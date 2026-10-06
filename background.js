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

async function connectFree(countryCode, skip = []) {
  const before = await getState();
  const previous = before.status === "connected" && before.proxy ? before : null;
  const fallback = previous ? `SOCKS5 ${proxyKey(previous.proxy)}` : "DIRECT";

  const pool = await fetchPool();
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
      await setState({
        status: "connected",
        target: countryCode,
        proxy: result.winner,
        info: result.info,
        latencyMs: result.info.ms,
        tried,
        note: null,
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
    await setState({ status: "disconnected", target: serverId, note: null, lastError: `${server.label} did not respond.` });
  }
}

async function disconnect() {
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
          sendResponse({ ok: true, countries, servers, state, poolFetchedAt: poolFetchedAt || null });
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
