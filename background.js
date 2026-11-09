const PROXY_API =
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=json&timeout=3000";

// One hostname per racing slot: the PAC script routes each hostname through a different
// proxy, so six proxies are tested at once. All six serve Cloudflare's /cdn-cgi/trace, so
// every proxy is judged by the same geolocation (the one Cloudflare-fronted sites see).
// Mixing third-party checkers made the verdict depend on the slot: through real proxies
// ifconfig.co placed German exits in AT/GB, api.db-ip.com returned quota errors, and
// ipapi.co returns HTTP 429 — each made good proxies look dead or mislabeled.
const CHECKERS = [
  "speed.cloudflare.com",
  "developers.cloudflare.com",
  "workers.cloudflare.com",
  "radar.cloudflare.com",
  "www.cloudflare.com",
  "one.one.one.one"
].map((host) => ({ host, url: `https://${host}/cdn-cgi/trace` }));

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function parseTrace(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  if (!fields.ip || !/^[A-Z]{2}$/.test(fields.loc || "")) return null;
  let country = fields.loc;
  try {
    country = regionNames.of(fields.loc) || fields.loc;
  } catch {}
  return { ip: fields.ip, countryCode: fields.loc, country, city: "" };
}

// Auto-rotate (V1): while connected through a free proxy, 2 proxy/connection failures
// on main-frame navigations within 60s rotate to the next verified proxy for the same
// country. At most one auto-rotate per 30s so a bad stretch cannot loop rotations.
const AUTO_ROTATE_WINDOW_MS = 60 * 1000;
const AUTO_ROTATE_THRESHOLD = 2;
const AUTO_ROTATE_COOLDOWN_MS = 30 * 1000;
const PROXY_ERRORS = new Set([
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_SOCKS_CONNECTION_FAILED",
  "net::ERR_TIMED_OUT",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_EMPTY_RESPONSE"
]);
const AUTO_ROTATE_NOTE = "Switched proxy: the last one failed";

// Extra sources (V2): keyless, signup-free SOCKS5 lists that carry a country label.
// They are only consulted when the primary ProxyScrape list has fewer than 10 proxies
// for the requested country (`thin` countries). Their country labels are hints only:
// a proxy is still accepted solely on the measured Cloudflare exit-country check.
// Each extra fetch is capped at 3s and run in parallel via allSettled, so a failing
// or hanging source can neither break nor stall Connect; the primary pool is used alone.
const THIN_COUNTRY_THRESHOLD = 10;
const EXTRA_TIMEOUT_MS = 3000;

function makeProxy(host, port, country, countryName, uptime) {
  const p = Number(port);
  const cc = String(country || "").toUpperCase();
  // Same PAC-script safety rule as the primary list: plain IPv4 + integer port + 2-letter code.
  if (!IPV4.test(host || "") || !Number.isInteger(p) || p < 1 || p > 65535 || !/^[A-Z]{2}$/.test(cc)) return null;
  return { host, port: p, country: cc, countryName: countryName || cc, uptime: typeof uptime === "number" ? uptime : 0 };
}

function parseHProxyList(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const p of data) {
    const entry = makeProxy(p.ip, p.port, p.country_code, null, p.uptime_pct ?? p.uptime_24h);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.uptime - a.uptime);
}

function parseMonosansList(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const p of data) {
    if (p.protocol !== "socks5" || p.username || p.password) continue;
    const cc = p.geolocation?.country?.iso_code;
    const name = p.geolocation?.country?.names?.en;
    // monosans reports a response `timeout` (seconds, lower is faster), not uptime;
    // derive a comparable score so faster entries sort first within this source.
    const uptime = typeof p.timeout === "number" ? Math.max(0, Math.round(100 - p.timeout * 50)) : 0;
    const entry = makeProxy(p.host, p.port, cc, name, uptime);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.uptime - a.uptime);
}

const EXTRA_SOURCES = [
  { url: "https://hproxy.com/api/proxy-list?format=json&protocol=socks5", parse: parseHProxyList },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json", parse: parseMonosansList }
];

async function fetchExtraSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRA_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`extra source HTTP ${res.status}`);
    return source.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExtraPool() {
  const results = await Promise.allSettled(EXTRA_SOURCES.map((s) => fetchExtraSource(s)));
  const extras = [];
  for (const r of results) if (r.status === "fulfilled") extras.push(...r.value); // source order = fallback order
  return extras;
}

// Primary entries first (fallback order), then extras, deduplicated by host:port.
function mergePools(primary, extras) {
  const seen = new Set(primary.map((p) => `${p.host}:${p.port}`));
  const merged = [...primary];
  for (const p of extras) {
    const key = `${p.host}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return merged;
}

// Existing cache rules are untouched for the primary pool. The extra pool gets the
// same 10-minute TTL and is stored separately; a fresh cache means no network at all
// on Connect, and a failed refresh falls back to the stale cache or the primary pool.
async function getPoolForCountry(primaryPool, countryCode) {
  const primaryCount = primaryPool.filter((p) => p.country === countryCode).length;
  if (primaryCount >= THIN_COUNTRY_THRESHOLD) return primaryPool;
  const { extraPool, extraPoolFetchedAt } = await chrome.storage.local.get(["extraPool", "extraPoolFetchedAt"]);
  if (Array.isArray(extraPool) && extraPool.length && extraPoolFetchedAt && Date.now() - extraPoolFetchedAt <= LIST_TTL_MS) {
    return mergePools(primaryPool, extraPool);
  }
  let extras = [];
  try {
    extras = await fetchExtraPool();
  } catch {
    extras = [];
  }
  if (extras.length) await chrome.storage.local.set({ extraPool: extras, extraPoolFetchedAt: Date.now() });
  else if (Array.isArray(extraPool) && extraPool.length) extras = extraPool;
  return mergePools(primaryPool, extras);
}

const LIST_TTL_MS = 10 * 60 * 1000;
// Measured 2026-09-25: 4s dropped a country that 5s reached; beyond 5s only the slowest
// ~10% of live proxies answer, and those make browsing slow anyway.
const PROBE_TIMEOUT_MS = 5000;
const MAX_CANDIDATES = 18;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

let refreshing = null;

async function setState(patch) {
  const { state = {} } = await chrome.storage.local.get("state");
  const next = { ...state, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ state: next });
  return next;
}

async function getState() {
  const { state = { status: "disconnected" } } = await chrome.storage.local.get("state");
  return state;
}

function refreshPool() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const res = await fetch(PROXY_API, { cache: "no-store" });
    if (!res.ok) throw new Error(`proxy list HTTP ${res.status}`);
    const data = await res.json();
    const next = [];
    for (const p of data.proxies || []) {
      const port = Number(p.port);
      // Hosts and ports end up inside a generated PAC script, so only accept plain IPv4 + integer port.
      if (!p.alive || !IPV4.test(p.ip || "") || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (!p.ip_data || !p.ip_data.countryCode) continue;
      next.push({
        host: p.ip,
        port,
        country: p.ip_data.countryCode,
        countryName: p.ip_data.country || p.ip_data.countryCode,
        uptime: typeof p.uptime === "number" ? p.uptime : 0
      });
    }
    next.sort((a, b) => b.uptime - a.uptime);
    if (!next.length) throw new Error("proxy list empty");
    await chrome.storage.local.set({ pool: next, poolFetchedAt: Date.now() });
    return next;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function fetchPool(force = false) {
  const { pool } = await chrome.storage.local.get("pool");
  if (!force && pool?.length) {
    const { poolFetchedAt } = await chrome.storage.local.get("poolFetchedAt");
    // Stale-while-revalidate: answer instantly from cache, refresh in the background.
    if (!poolFetchedAt || Date.now() - poolFetchedAt > LIST_TTL_MS) refreshPool().catch(() => {});
    return pool;
  }
  try {
    return await refreshPool();
  } catch (err) {
    if (pool?.length) return pool;
    throw new Error(`Could not load proxy list: ${err.message}`);
  }
}

async function getCountries() {
  const pool = await fetchPool();
  const byCountry = new Map();
  for (const p of pool) {
    const entry = byCountry.get(p.country) || { country: p.country, countryName: p.countryName, count: 0 };
    entry.count++;
    byCountry.set(p.country, entry);
  }
  return [...byCountry.values()].sort((a, b) => a.countryName.localeCompare(b.countryName));
}

async function getCustomServers() {
  const { servers = [] } = await chrome.storage.local.get("servers");
  return servers.filter((s) => s.host && s.host !== "REPLACE_ME");
}

async function applyProxy(host, port) {
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "socks5", host, port: Number(port) },
        bypassList: ["localhost", "127.0.0.1", "<local>"]
      }
    },
    scope: "regular"
  });
}

async function applyRacePac(slots, fallback) {
  const routes = {};
  for (const { proxy, checker } of slots) routes[checker.host] = `SOCKS5 ${proxy.host}:${proxy.port}`;
  const data =
    `var R=${JSON.stringify(routes)};` +
    `function FindProxyForURL(url,host){` +
    `return Object.prototype.hasOwnProperty.call(R,host)?R[host]:${JSON.stringify(fallback)};}`;
  await chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data } }, scope: "regular" });
}

async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

function probe(checker) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = performance.now();
  const promise = fetch(checker.url, { cache: "no-store", signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) return null;
      const info = parseTrace(await res.text());
      return info ? { ...info, ms: Math.round(performance.now() - started) } : null;
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
  return { promise, abort: () => controller.abort() };
}

// Probes start together, so the first proxy to come back from the right country is also
// the lowest-latency one. Resolve on it immediately rather than waiting for dead proxies.
async function raceBatch(batch, countryCode, fallback) {
  const slots = batch.map((proxy, i) => ({ proxy, checker: CHECKERS[i] }));
  await applyRacePac(slots, fallback);
  const racers = slots.map((s) => ({ ...s, ...probe(s.checker) }));
  const dead = [];
  const mismatched = [];

  return new Promise((resolve) => {
    let pending = racers.length;
    let settled = false;
    for (const racer of racers) {
      racer.promise.then((info) => {
        if (settled) return;
        if (!info) {
          dead.push(racer.proxy);
        } else if (info.countryCode !== countryCode) {
          // Public lists mislabel countries often (an "NL" proxy exiting in Canada is common),
          // so trust the measured exit country over the listing.
          mismatched.push({ proxy: racer.proxy, got: info.countryCode });
        } else {
          settled = true;
          for (const other of racers) if (other !== racer) other.abort();
          resolve({ winner: racer.proxy, info, dead, mismatched });
          return;
        }
        if (--pending === 0) resolve({ winner: null, info: null, dead, mismatched });
      });
    }
  });
}

const proxyKey = (p) => `${p.host}:${p.port}`;

async function connectFree(countryCode, skip = [], auto = false) {
  if (!countryCode) throw new Error("Pick a country first.");
  const before = await getState();
  const previous = before.status === "connected" && before.proxy ? before : null;
  const fallback = previous ? `SOCKS5 ${proxyKey(previous.proxy)}` : "DIRECT";

  const primaryPool = await fetchPool();
  const pool = await getPoolForCountry(primaryPool, countryCode);
  const candidates = pool
    .filter((p) => p.country === countryCode && !skip.includes(proxyKey(p)))
    .slice(0, MAX_CANDIDATES);

  const batches = [];
  for (let i = 0; i < candidates.length; i += CHECKERS.length) batches.push(candidates.slice(i, i + CHECKERS.length));

  const tried = [...skip];
  let dead = 0;
  const mismatched = [];

  for (let round = 0; round < batches.length; round++) {
    await setState({
      status: "connecting",
      target: countryCode,
      racing: batches[round].length,
      round: round + 1,
      rounds: batches.length,
      note: null,
      lastError: null
    });

    const result = await raceBatch(batches[round], countryCode, fallback);
    dead += result.dead.length;
    mismatched.push(...result.mismatched.map((m) => m.got));
    // Proxies aborted mid-race stay eligible for "Try another": they may be perfectly fine.
    tried.push(...result.dead.map(proxyKey), ...result.mismatched.map((m) => proxyKey(m.proxy)));

    if (result.winner) {
      await applyProxy(result.winner.host, result.winner.port);
      tried.push(proxyKey(result.winner));
      await chrome.storage.local.set({ autoFailures: [] });
      await setState({
        status: "connected",
        target: countryCode,
        proxy: result.winner,
        info: result.info,
        latencyMs: result.info.ms,
        tried,
        note: auto ? AUTO_ROTATE_NOTE : null,
        lastError: null
      });
      return;
    }
  }

  const parts = [`Tested ${candidates.length} ${countryCode} proxies`];
  if (dead) parts.push(`${dead} didn't respond within ${PROBE_TIMEOUT_MS / 1000}s`);
  if (mismatched.length) parts.push(`${mismatched.length} exited in the wrong country (${[...new Set(mismatched)].join(", ")})`);
  const summary = candidates.length ? parts.join("; ") : `No untested proxies left for ${countryCode}`;

  if (previous) {
    // Rotation found nothing better: keep the proxy that was already working.
    await applyProxy(previous.proxy.host, previous.proxy.port);
    await setState({ ...previous, tried, note: `${summary}. Stayed on the current proxy.`, lastError: null });
    return;
  }

  await clearProxy();
  await setState({
    status: "disconnected",
    target: countryCode,
    tried,
    note: null,
    lastError: candidates.length
      ? `${summary}. Free proxies are flaky and often mislabeled — hit Refresh or try another country.`
      : `${summary}. Hit Refresh for a new list or pick another country.`
  });
}

async function verifyExit() {
  // Everything goes through the one proxy here, so ask three checkers at once and take the first answer.
  const probes = CHECKERS.slice(0, 3).map(probe);
  try {
    return await Promise.any(probes.map((p) => p.promise.then((info) => info || Promise.reject(new Error("no answer")))));
  } catch {
    return null;
  } finally {
    for (const p of probes) p.abort();
  }
}

async function connectCustom(serverId) {
  const servers = await getCustomServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) throw new Error("Server not found");

  await setState({ status: "connecting", target: serverId, racing: 1, round: 1, rounds: 1, note: null, lastError: null });
  await applyProxy(server.host, server.port);
  const info = await verifyExit();

  if (info) {
    await setState({
      status: "connected",
      target: serverId,
      proxy: { host: server.host, port: server.port, country: server.country, countryName: server.label },
      info,
      latencyMs: info.ms,
      note: null,
      lastError: null
    });
  } else {
    await clearProxy();
    await setState({ status: "disconnected", target: serverId, note: null, lastError: `${String(server.label || "Server").slice(0, 40)} did not respond.` });
  }
}

async function disconnect() {
  await chrome.storage.local.set({ autoFailures: [] });
  await clearProxy();
  await setState({ status: "disconnected", target: null, proxy: null, info: null, latencyMs: null, tried: [], note: null, lastError: null });
}

async function handleProxyAuth(details) {
  if (!details.isProxy) return {};
  const state = await getState();
  if (state.status !== "connected" && state.status !== "connecting") return { cancel: true };

  const servers = await getCustomServers();
  const match = servers.find((s) => s.host === (details.challenger && details.challenger.host));
  if (match && match.username) {
    return { authCredentials: { username: match.username, password: match.password } };
  }
  // Free proxies shouldn't need auth. Cancel rather than showing a browser login dialog,
  // so the probe fails fast and the race moves on.
  return { cancel: true };
}

// Auto-switch preference: stored as `autoSwitch`, default ON (anything but explicit false).
async function getAutoSwitch() {
  const { autoSwitch } = await chrome.storage.local.get("autoSwitch");
  return autoSwitch !== false;
}

let autoRotating = false;

// Counts main-frame navigation failures that point at the proxy/connection while
// connected through a free proxy. 2 within 60s (and outside the 30s cooldown)
// rotates to the next verified proxy for the SAME country via connectFree.
// Failure timestamps and the cooldown live in storage so they survive service-worker
// restarts. Errors that are not in PROXY_ERRORS (e.g. ERR_ABORTED, a page's own
// error) and sub-frame errors never count. No new manifest permission is needed:
// webRequest is already declared.
async function handleNavError(details) {
  if (!details || details.type !== "main_frame" || !PROXY_ERRORS.has(details.error)) return;
  if (!(await getAutoSwitch())) return;
  const state = await getState();
  if (state.status !== "connected" || !state.proxy || !/^[A-Z]{2}$/.test(state.target || "")) return;
  if (autoRotating) return;

  const now = Date.now();
  const { lastAutoRotateAt = 0 } = await chrome.storage.local.get("lastAutoRotateAt");
  if (now - lastAutoRotateAt < AUTO_ROTATE_COOLDOWN_MS) return;

  let { autoFailures = [] } = await chrome.storage.local.get("autoFailures");
  autoFailures = autoFailures.filter((t) => now - t <= AUTO_ROTATE_WINDOW_MS);
  autoFailures.push(now);
  await chrome.storage.local.set({ autoFailures });
  if (autoFailures.length < AUTO_ROTATE_THRESHOLD) return;

  await chrome.storage.local.set({ autoFailures: [], lastAutoRotateAt: now });
  const fresh = await getState();
  if (fresh.status !== "connected" || fresh.target !== state.target) return;
  autoRotating = true;
  try {
    await connectFree(fresh.target, fresh.tried || [], true);
  } catch {
    // connectFree already records its own errors in state; nothing to add here.
  } finally {
    autoRotating = false;
  }
}

if (chrome.webRequest.onErrorOccurred) {
  // Chrome does not wait for listeners, so failures can arrive together. Run them one at a
  // time so each read-modify-write of autoFailures sees the previous one (no lost counts).
  let navQueue = Promise.resolve();
  const onNavError = (details) => {
    navQueue = navQueue.then(() => handleNavError(details)).catch(() => {});
  };
  // Edge (Chromium 156, measured 2026-11-08) throws `TypeError: No matching signature`
  // for onErrorOccurred.addListener(callback) and needs the filter argument, while
  // Chrome accepts either. Try the filter form first, fall back to the plain form,
  // and never let a registration failure kill the service worker.
  try {
    chrome.webRequest.onErrorOccurred.addListener(onNavError, { urls: ["<all_urls>"] });
  } catch {
    try {
      chrome.webRequest.onErrorOccurred.addListener(onNavError);
    } catch {}
  }
}

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    handleProxyAuth(details).then(callback);
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_INIT": {
          const [countries, servers, state] = await Promise.all([
            getCountries().catch(() => []),
            getCustomServers(),
            getState()
          ]);
          const { poolFetchedAt } = await chrome.storage.local.get("poolFetchedAt");
          const autoSwitch = await getAutoSwitch();
          sendResponse({ ok: true, countries, servers, state, poolFetchedAt: poolFetchedAt || null, autoSwitch });
          break;
        }
        case "REFRESH_POOL": {
          await fetchPool(true);
          const countries = await getCountries();
          sendResponse({ ok: true, countries });
          break;
        }
        case "CONNECT_FREE":
          sendResponse({ ok: true, started: true });
          connectFree(message.countryCode, message.skip || []).catch((err) =>
            setState({ status: "disconnected", note: null, lastError: err.message })
          );
          break;
        case "CONNECT_CUSTOM":
          sendResponse({ ok: true, started: true });
          connectCustom(message.serverId).catch((err) =>
            setState({ status: "disconnected", note: null, lastError: err.message })
          );
          break;
        case "DISCONNECT":
          await disconnect();
          sendResponse({ ok: true });
          break;
        case "SAVE_SERVERS":
          await chrome.storage.local.set({ servers: message.servers });
          sendResponse({ ok: true });
          break;
        case "GET_SETTINGS":
          sendResponse({ ok: true, autoSwitch: await getAutoSwitch() });
          break;
        case "SAVE_SETTINGS":
          await chrome.storage.local.set({ autoSwitch: message.autoSwitch !== false });
          sendResponse({ ok: true });
          break;
        case "GET_SERVERS": {
          const { servers = [] } = await chrome.storage.local.get("servers");
          sendResponse({ ok: true, servers });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      await setState({ status: "disconnected", lastError: err.message });
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});
