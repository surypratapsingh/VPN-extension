// Runs the real background.js in a VM with a fake browser whose fetch() obeys the PAC script
// the extension generates, and fake proxies with scripted latency / death / wrong country.
// Run: node tests/background.test.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(process.env.BG || path.join(__dirname, "..", "background.js"), "utf8");

// Same format as a real https://<host>/cdn-cgi/trace reply.
const trace = (host, ip, cc) => `fl=1f1
h=${host}
ip=${ip}
ts=1758800000.1
visit_scheme=https
uag=Mozilla
colo=FRA
http=http/2
loc=${cc}
tls=TLSv1.3
`;

function env({ proxies = {}, pool = [], listMs = 0, listFails = false, seed = {}, extraSources = {} }) {
  const store = structuredClone(seed);
  let config = null;
  const log = { pacs: [], applied: [], fetches: [], states: [], listFetches: [] };
  let onMessage = null;
  let onErrorOccurred = null;

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (obj) => {
          Object.assign(store, structuredClone(obj));
          if (obj.state) log.states.push(structuredClone(obj.state));
        },
        remove: async (k) => { delete store[k]; }
      }
    },
    proxy: {
      settings: {
        set: async ({ value }) => {
          config = value;
          if (value.mode === "pac_script") log.pacs.push(value.pacScript.data);
          else log.applied.push(`${value.rules.singleProxy.host}:${value.rules.singleProxy.port}`);
        },
        clear: async () => { config = null; log.applied.push("CLEARED"); }
      }
    },
    webRequest: { onAuthRequired: { addListener: () => {} }, onErrorOccurred: { addListener: (fn, filter) => { onErrorOccurred = fn; log.errorFilter = filter; } } },
    runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } }
  };

  function route(url, host) {
    if (!config) return "DIRECT";
    if (config.mode === "fixed_servers") return `SOCKS5 ${config.rules.singleProxy.host}:${config.rules.singleProxy.port}`;
    const pac = vm.createContext({});
    vm.runInContext(config.pacScript.data, pac); // throws if the generated PAC isn't valid JS
    return pac.FindProxyForURL(url, host);
  }

  function fetch(url, opts = {}) {
    const host = new URL(url).hostname;
    if (host === "hproxy.com" || host === "raw.githubusercontent.com") {
      // V2 extra sources: stubbed per-test. Default (undefined) = fetch fails.
      log.listFetches.push(host);
      const spec = extraSources[host === "hproxy.com" ? "hproxy" : "monosans"];
      return new Promise((resolve, reject) => {
        if (!spec || spec.fail) return reject(new TypeError("Failed to fetch"));
        if (spec.hang) {
          if (opts.signal) opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          return;
        }
        setTimeout(() => resolve({ ok: true, json: async () => spec.rows || [] }), spec.ms || 0);
      });
    }
    if (host === "api.proxyscrape.com") {
      return new Promise((resolve, reject) =>
        setTimeout(() => (listFails ? reject(new TypeError("Failed to fetch")) : resolve({ ok: true, json: async () => ({ proxies: pool }) })), listMs)
      );
    }
    const via = route(url, host);
    log.fetches.push({ host, via });
    const b = via === "DIRECT" ? { ms: 5, ip: "REAL-IP", cc: "IN" } : proxies[via.replace("SOCKS5 ", "")];
    if (!b) return Promise.reject(new Error(`no such proxy: ${via}`));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (opts.signal) {
        if (opts.signal.aborted) return abort();
        opts.signal.addEventListener("abort", abort);
      }
      if (b.hang) return;
      setTimeout(() => (b.dead ? reject(new TypeError("Failed to fetch")) : resolve({ ok: true, text: async () => (b.html ? "<html><title>Access denied</title></html>" : trace(host, b.ip || via, b.cc)) })), b.ms);
    });
  }

  vm.runInContext(SRC, vm.createContext({ chrome, fetch, AbortController, setTimeout, clearTimeout, performance, console, URL, DOMException }));
  const send = (msg) => new Promise((res) => onMessage(msg, {}, res));
  const settle = async (n0) => {
    for (let i = 0; i < 400; i++) {
      const last = log.states[log.states.length - 1];
      if (log.states.length > n0 && last.status !== "connecting") return last;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("never settled");
  };
  const connect = async (msg) => {
    const n0 = log.states.length;
    const t0 = performance.now();
    await send(msg);
    const final = await settle(n0);
    return { final, ms: performance.now() - t0 };
  };
  const fireError = async (details) => { if (onErrorOccurred) await onErrorOccurred(details); };
  const settleAuto = async (n0) => {
    for (let i = 0; i < 400; i++) {
      const last = log.states[log.states.length - 1];
      if (log.states.length > n0 && last.status !== "connecting") return last;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("auto-rotate never settled");
  };
  return { send, connect, store, log, fireError, settleAuto };
}

const listing = (host, port, cc, uptime) => ({ alive: true, ip: host, port, uptime, ip_data: { countryCode: cc, country: cc } });

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

(async () => {
  // --- 1. Race picks the fastest proxy that really exits in the requested country
  const P = {
    "10.0.0.1:1080": { ms: 900, cc: "DE" },
    "10.0.0.2:1080": { ms: 300, cc: "DE" },
    "10.0.0.3:1080": { dead: true, ms: 50 },
    "10.0.0.4:1080": { ms: 150, cc: "CA" }, // fastest, but mislabeled: must lose
    "10.0.0.5:1080": { hang: true },         // must not hold up the race
    "10.0.0.6:1080": { ms: 600, cc: "DE" }
  };
  const pool1 = Object.keys(P).map((k, i) => listing(k.split(":")[0], 1080, "DE", 99 - i));
  const e1 = env({ proxies: P, pool: pool1 });
  const r1 = await e1.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("connects", r1.final.status === "connected");
  check("picks fastest correct-country proxy, not first-listed or mislabeled", r1.final.proxy?.host === "10.0.0.2", r1.final.proxy?.host);
  check("does not wait for the hanging proxy", r1.ms < 1500, `${Math.round(r1.ms)}ms`);
  check("reports measured latency", r1.final.latencyMs >= 280 && r1.final.latencyMs < 500, `${r1.final.latencyMs}ms`);
  check("browser left on the winner as a fixed proxy", e1.log.applied.at(-1) === "10.0.0.2:1080", e1.log.applied.at(-1));
  const routed = new Map(e1.log.fetches.map((f) => [f.host, f.via]));
  check("PAC sent 6 checker hosts through 6 different proxies", new Set(routed.values()).size === 6 && routed.size === 6, [...routed.values()].join(" "));
  check("PAC routes other traffic DIRECT when not already connected", e1.log.pacs[0].includes('"DIRECT"'));

  // --- 2. Rotation re-races the untested/aborted survivors, and routes other traffic via the current proxy meanwhile
  const r2 = await e1.connect({ type: "CONNECT_FREE", countryCode: "DE", skip: r1.final.tried });
  check("rotation connects to a different proxy", r2.final.status === "connected" && r2.final.proxy.host !== "10.0.0.2", r2.final.proxy?.host);
  check("rotation picks the faster survivor (600ms over 900ms)", r2.final.proxy?.host === "10.0.0.6", r2.final.proxy?.host);
  check("during rotation, browsing stays on the current proxy", e1.log.pacs.at(-1).includes('"SOCKS5 10.0.0.2:1080"'));

  // --- 3. Rotation that finds nothing keeps the working proxy
  const r3 = await e1.connect({ type: "CONNECT_FREE", countryCode: "DE", skip: pool1.map((p) => `${p.ip}:${p.port}`) });
  check("failed rotation stays connected", r3.final.status === "connected" && r3.final.proxy.host === "10.0.0.6", r3.final.status);
  check("failed rotation explains itself", /Stayed on the current proxy|No untested/.test(r3.final.note || r3.final.lastError || ""), r3.final.note);

  // --- 4. First round all bad -> second round wins
  const Q = {};
  const pool4 = [];
  for (let i = 1; i <= 12; i++) {
    const k = `10.1.0.${i}:1080`;
    Q[k] = i <= 5 ? { dead: true, ms: 40 } : i === 6 ? { ms: 80, cc: "US" } : i === 9 ? { ms: 200, cc: "FR" } : { dead: true, ms: 40 };
    pool4.push(listing(`10.1.0.${i}`, 1080, "FR", 100 - i));
  }
  const e4 = env({ proxies: Q, pool: pool4 });
  const r4 = await e4.connect({ type: "CONNECT_FREE", countryCode: "FR" });
  check("second round finds the proxy", r4.final.status === "connected" && r4.final.proxy.host === "10.1.0.9", r4.final.proxy?.host);
  check("two PAC rounds were used", e4.log.pacs.length === 2, `${e4.log.pacs.length}`);
  check("progress reported round 2 of 2", e4.log.states.some((s) => s.status === "connecting" && s.round === 2 && s.rounds === 2));

  // --- 5. Everything hangs: bounded by the 5s probe timeout, then a clear error
  const H = {};
  const pool5 = [];
  for (let i = 1; i <= 6; i++) {
    H[`10.2.0.${i}:1080`] = { hang: true };
    pool5.push(listing(`10.2.0.${i}`, 1080, "JP", 90));
  }
  const e5 = env({ proxies: H, pool: pool5 });
  const r5 = await e5.connect({ type: "CONNECT_FREE", countryCode: "JP" });
  check("all-hanging round gives up at the probe timeout", r5.ms > 4800 && r5.ms < 6500, `${Math.round(r5.ms)}ms`);
  check("then disconnects with an explanation", r5.final.status === "disconnected" && /didn't respond within 5s/.test(r5.final.lastError), r5.final.lastError);
  check("never left the browser on an untested proxy", e5.log.applied.at(-1) === "CLEARED");

  // --- 6. Only mislabeled proxies (the NL case): refuse, name where they really exit
  const N = { "10.3.0.1:1080": { ms: 100, cc: "CA" }, "10.3.0.2:1080": { ms: 120, cc: "BR" } };
  const e6 = env({ proxies: N, pool: [listing("10.3.0.1", 1080, "NL", 99), listing("10.3.0.2", 1080, "NL", 98)] });
  const r6 = await e6.connect({ type: "CONNECT_FREE", countryCode: "NL" });
  check("mislabeled-only country refuses to connect", r6.final.status === "disconnected", r6.final.status);
  check("error names the real exit countries", /wrong country \((CA, BR|BR, CA)\)/.test(r6.final.lastError), r6.final.lastError);
  check("fast even when refusing", r6.ms < 1000, `${Math.round(r6.ms)}ms`);

  // --- 7. Hostile list entries can't reach the generated PAC script
  const bad = [
    listing('1.2.3.4";alert(1);//', 1080, "US", 99),
    listing("2001:db8::1", 1080, "US", 99),
    { ...listing("5.6.7.8", "80a", "US", 99) },
    listing("9.9.9.9", 70000, "US", 99),
    listing("8.8.4.4", 1080, "US", 50)
  ];
  const e7 = env({ pool: bad });
  const init7 = await e7.send({ type: "GET_INIT" });
  const us = init7.countries.find((c) => c.country === "US");
  check("only the valid IPv4:port entry survives", us?.count === 1 && e7.store.pool.length === 1 && e7.store.pool[0].host === "8.8.4.4", JSON.stringify(e7.store.pool?.map((p) => p.host)));

  // --- 8. Popup opens instantly from a stale cache and refreshes in the background
  const e8 = env({ pool: [listing("7.7.7.7", 1080, "GB", 99)], listMs: 400, seed: { pool: [{ host: "6.6.6.6", port: 1080, country: "GB", countryName: "GB", uptime: 1 }], poolFetchedAt: 1 } });
  const t8 = performance.now();
  const init8 = await e8.send({ type: "GET_INIT" });
  const openMs = performance.now() - t8;
  check("popup data returned without waiting for the network", openMs < 150 && init8.countries.length === 1, `${Math.round(openMs)}ms`);
  await new Promise((r) => setTimeout(r, 600));
  check("stale list refreshed in the background", e8.store.poolFetchedAt > 1 && e8.store.pool[0].host === "7.7.7.7");

  // --- 9. Custom server: dead one fails fast instead of 3 x 9s
  const e9 = env({ proxies: { "10.9.0.1:1080": { dead: true, ms: 30 }, "10.9.0.2:1080": { ms: 120, cc: "SG" } }, seed: { servers: [
    { id: "a", label: "Dead box", country: "SG", host: "10.9.0.1", port: 1080 },
    { id: "b", label: "Good box", country: "SG", host: "10.9.0.2", port: 1080 }
  ] } });
  const r9a = await e9.connect({ type: "CONNECT_CUSTOM", serverId: "a" });
  check("dead custom server fails fast", r9a.final.status === "disconnected" && r9a.ms < 1000, `${Math.round(r9a.ms)}ms`);
  const r9b = await e9.connect({ type: "CONNECT_CUSTOM", serverId: "b" });
  check("good custom server connects with latency", r9b.final.status === "connected" && r9b.final.latencyMs > 0, `${r9b.final.latencyMs}ms`);

  // --- 10. List download failure with no cache surfaces an error instead of hanging on "Connecting…"
  const e10 = env({ listFails: true });
  const r10 = await e10.connect({ type: "CONNECT_FREE", countryCode: "US" });
  check("list failure is reported, not stuck", r10.final.status === "disconnected" && /Could not load proxy list/.test(r10.final.lastError), r10.final.lastError);

  // --- 11. A proxy that answers fast with a block page (not a trace) must not win
  const B = { "10.4.0.1:1080": { ms: 40, html: true }, "10.4.0.2:1080": { ms: 250, cc: "US" } };
  const e11 = env({ proxies: B, pool: [listing("10.4.0.1", 1080, "US", 99), listing("10.4.0.2", 1080, "US", 98)] });
  const r11 = await e11.connect({ type: "CONNECT_FREE", countryCode: "US" });
  check("block-page proxy rejected, real one wins", r11.final.status === "connected" && r11.final.proxy.host === "10.4.0.2", r11.final.proxy?.host);
  check("country name filled in from the code", r11.final.info?.country === "United States", r11.final.info?.country);
  check("all racing hosts are Cloudflare trace endpoints", e11.log.fetches.every((f) => /(cloudflare\.com|one\.one\.one\.one)$/.test(f.host)), [...new Set(e11.log.fetches.map((f) => f.host))].join(" "));

  // --- 12. V1 auto-rotate: 2 proxy failures within 60s rotate, same country, note shown
  const A = {
    "10.5.0.1:1080": { ms: 100, cc: "DE" },
    "10.5.0.2:1080": { ms: 120, cc: "DE" },
    "10.5.0.3:1080": { ms: 140, cc: "DE" }
  };
  const poolA = Object.keys(A).map((k, i) => listing(k.split(":")[0], 1080, "DE", 99 - i));
  const e12 = env({ proxies: A, pool: poolA });
  const r12 = await e12.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V1 setup connects", r12.final.status === "connected" && r12.final.proxy.host === "10.5.0.1");
  check("V1 onErrorOccurred registered with <all_urls> filter (Edge signature)", e12.log.errorFilter?.urls?.[0] === "<all_urls>", JSON.stringify(e12.log.errorFilter));
  const n12 = e12.log.states.length;
  await e12.fireError({ type: "main_frame", error: "net::ERR_PROXY_CONNECTION_FAILED", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 150));
  check("V1 one failure does not rotate", e12.store.state.proxy.host === "10.5.0.1" && e12.log.states.length === n12);
  await e12.fireError({ type: "main_frame", error: "net::ERR_SOCKS_CONNECTION_FAILED", url: "https://example.com/" });
  const r12b = await e12.settleAuto(n12);
  check("V1 two failures within 60s rotate to next proxy", r12b.status === "connected" && r12b.proxy.host === "10.5.0.2", r12b.proxy?.host);
  check("V1 auto-rotate keeps the same country", r12b.target === "DE" && r12b.info?.countryCode === "DE");
  check("V1 popup note shown after auto-rotate", /Switched proxy: the last one failed/.test(r12b.note || ""), r12b.note);

  // --- 13. V1 window: a failure older than 60s does not count toward the threshold
  const e13 = env({ proxies: A, pool: poolA, seed: { state: { status: "connected", target: "DE", proxy: { host: "10.5.0.1", port: 1080 }, tried: ["10.5.0.1:1080"] }, autoFailures: [Date.now() - 61000] } });
  await e13.fireError({ type: "main_frame", error: "net::ERR_TIMED_OUT", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 150));
  check("V1 failure outside 60s window does not rotate", e13.store.state.proxy.host === "10.5.0.1");
  await e13.fireError({ type: "main_frame", error: "net::ERR_TIMED_OUT", url: "https://example.com/" });
  const r13 = await e13.settleAuto(e13.log.states.length);
  check("V1 second fresh failure then rotates", r13.status === "connected" && r13.proxy.host === "10.5.0.2", r13.proxy?.host);

  // --- 14. V1 cooldown: no second auto-rotate within 30s
  const e14 = env({ proxies: A, pool: poolA, seed: { state: { status: "connected", target: "DE", proxy: { host: "10.5.0.1", port: 1080 }, tried: ["10.5.0.1:1080"] }, lastAutoRotateAt: Date.now() } });
  await e14.fireError({ type: "main_frame", error: "net::ERR_PROXY_CONNECTION_FAILED", url: "https://example.com/" });
  await e14.fireError({ type: "main_frame", error: "net::ERR_CONNECTION_RESET", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 200));
  check("V1 cooldown blocks rotate within 30s", e14.store.state.proxy.host === "10.5.0.1" && e14.log.states.length === 0);

  // --- 15. V1 off switch and errors that must NOT count
  const e15 = env({ proxies: A, pool: poolA, seed: { state: { status: "connected", target: "DE", proxy: { host: "10.5.0.1", port: 1080 }, tried: ["10.5.0.1:1080"] }, autoSwitch: false } });
  await e15.fireError({ type: "main_frame", error: "net::ERR_PROXY_CONNECTION_FAILED", url: "https://example.com/" });
  await e15.fireError({ type: "main_frame", error: "net::ERR_PROXY_CONNECTION_FAILED", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 200));
  check("V1 off switch prevents auto-rotate", e15.store.state.proxy.host === "10.5.0.1");

  const e16 = env({ proxies: A, pool: poolA, seed: { state: { status: "connected", target: "DE", proxy: { host: "10.5.0.1", port: 1080 }, tried: ["10.5.0.1:1080"] } } });
  await e16.fireError({ type: "main_frame", error: "net::ERR_ABORTED", url: "https://example.com/" });
  await e16.fireError({ type: "main_frame", error: "net::ERR_NAME_NOT_RESOLVED", url: "https://example.com/" });
  await e16.fireError({ type: "sub_frame", error: "net::ERR_PROXY_CONNECTION_FAILED", url: "https://example.com/" });
  await e16.fireError({ type: "xmlhttprequest", error: "net::ERR_PROXY_CONNECTION_FAILED", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 200));
  check("V1 ERR_ABORTED/other errors/sub-frame do not count", e16.store.state.proxy.host === "10.5.0.1" && e16.log.states.length === 0);
  // A 404-like page error is not a webRequest onErrorOccurred at all; only the 5 listed errors count.
  await e16.fireError({ type: "main_frame", error: "net::ERR_EMPTY_RESPONSE", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 150));
  check("V1 single listed error still below threshold", e16.store.state.proxy.host === "10.5.0.1");
  await e16.fireError({ type: "main_frame", error: "net::ERR_EMPTY_RESPONSE", url: "https://example.com/" });
  const r16 = await e16.settleAuto(e16.log.states.length);
  check("V1 ERR_EMPTY_RESPONSE counts toward threshold", r16.status === "connected" && r16.proxy.host === "10.5.0.2", r16.proxy?.host);

  // --- 17. V1 settings round-trip (options page switch storage)
  const s17 = await e16.send({ type: "GET_SETTINGS" });
  check("V1 settings default on", s17.ok && s17.autoSwitch === true);
  await e16.send({ type: "SAVE_SETTINGS", autoSwitch: false });
  const s17b = await e16.send({ type: "GET_SETTINGS" });
  check("V1 settings can be turned off and saved", s17b.autoSwitch === false);

  // --- 18. V2 thin country merges extras, dedupes by host:port, fallback order (primary first)
  const hpRow = (ip, port, cc, uptime) => ({ ip, port, country_code: cc, uptime_pct: uptime });
  const monoRow = (host, port, cc, name, timeout) => ({ protocol: "socks5", username: null, password: null, host, port, timeout, geolocation: { country: { iso_code: cc, names: { en: name } } } });
  const C = { "10.6.0.1:1080": { dead: true, ms: 40 }, "10.6.0.2:1080": { ms: 120, cc: "DE" }, "10.6.0.3:1080": { ms: 300, cc: "DE" } };
  const e18 = env({
    proxies: C,
    pool: [listing("10.6.0.1", 1080, "DE", 99)],
    extraSources: {
      hproxy: { rows: [hpRow("10.6.0.1", 1080, "DE", 90), hpRow("10.6.0.2", 1080, "DE", 80)] }, // first row duplicates the primary host:port
      monosans: { rows: [monoRow("10.6.0.3", 1080, "DE", "Germany", 0.2)] }
    }
  });
  const r18 = await e18.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 thin country connects via an extra source", r18.final.status === "connected" && r18.final.proxy.host === "10.6.0.2", r18.final.proxy?.host);
  check("V2 both extra sources consulted, in fallback order", e18.log.listFetches.join(",") === "hproxy.com,raw.githubusercontent.com", e18.log.listFetches.join(","));
  check("V2 extras deduplicated by host:port (no duplicate tried keys)", new Set(r18.final.tried).size === r18.final.tried.length, r18.final.tried.join(" "));
  check("V2 extra pool cached for next connect", Array.isArray(e18.store.extraPool) && e18.store.extraPool.length === 3, `cached=${e18.store.extraPool?.length}`);

  // --- 19. V2 failing first source + empty second source do not break Connect
  const e19 = env({
    proxies: C,
    pool: [listing("10.6.0.1", 1080, "DE", 99)],
    extraSources: { hproxy: { fail: true }, monosans: { rows: [monoRow("10.6.0.3", 1080, "DE", "Germany", 0.2)] } }
  });
  const r19 = await e19.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 failing source does not break connect (monosans wins)", r19.final.status === "connected" && r19.final.proxy.host === "10.6.0.3", r19.final.proxy?.host);

  const e19b = env({
    proxies: { "10.6.0.2:1080": { ms: 100, cc: "DE" } },
    pool: [listing("10.6.0.2", 1080, "DE", 99)],
    extraSources: { hproxy: { rows: [] }, monosans: { rows: [] } }
  });
  const r19b = await e19b.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 empty extra sources fall back to primary", r19b.final.status === "connected" && r19b.final.proxy.host === "10.6.0.2", r19b.final.proxy?.host);

  // --- 20. V2 hanging extra sources are capped by the 3s timeout and do not break Connect
  const e20 = env({
    proxies: { "10.6.0.2:1080": { ms: 100, cc: "DE" } },
    pool: [listing("10.6.0.2", 1080, "DE", 99)],
    extraSources: { hproxy: { hang: true }, monosans: { hang: true } }
  });
  const r20 = await e20.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 hanging extra sources time out and primary still connects", r20.final.status === "connected" && r20.ms >= 2900 && r20.ms < 6000, `${Math.round(r20.ms)}ms`);

  // --- 21. V2 fresh extra-pool cache is used with no network fetch
  const e21 = env({
    proxies: C,
    pool: [listing("10.6.0.1", 1080, "DE", 99)],
    seed: { extraPool: [{ host: "10.6.0.2", port: 1080, country: "DE", countryName: "DE", uptime: 80 }], extraPoolFetchedAt: Date.now() },
    extraSources: { hproxy: { hang: true }, monosans: { hang: true } }
  });
  const r21 = await e21.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 fresh cache used (no extra fetch) and connects", r21.final.status === "connected" && r21.final.proxy.host === "10.6.0.2" && e21.log.listFetches.length === 0, `fetches=${e21.log.listFetches.length}`);

  // --- 22. V2 thick country (>=10 primary) never consults extra sources
  const D = {};
  const poolD = [];
  for (let i = 1; i <= 10; i++) { D[`10.7.0.${i}:1080`] = { ms: 50 + i * 10, cc: "DE" }; poolD.push(listing(`10.7.0.${i}`, 1080, "DE", 100 - i)); }
  const e22 = env({ proxies: D, pool: poolD, extraSources: { hproxy: { rows: [hpRow("10.6.0.2", 1080, "DE", 99)] }, monosans: { rows: [] } } });
  const r22 = await e22.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 thick country skips extra sources", r22.final.status === "connected" && e22.log.listFetches.length === 0, `fetches=${e22.log.listFetches.length}`);

  // --- 23. V2 extra labels are never trusted: a mislabeled extra is rejected by the measured check
  const e23 = env({
    proxies: { "10.6.0.1:1080": { dead: true, ms: 40 }, "10.6.0.2:1080": { ms: 100, cc: "CA" } },
    pool: [listing("10.6.0.1", 1080, "DE", 99)],
    extraSources: { hproxy: { rows: [hpRow("10.6.0.2", 1080, "DE", 90)] }, monosans: { rows: [] } }
  });
  const r23 = await e23.connect({ type: "CONNECT_FREE", countryCode: "DE" });
  check("V2 mislabeled extra rejected, not silently used", r23.final.status === "disconnected" && /wrong country \(CA\)/.test(r23.final.lastError), r23.final.lastError);

  // --- 24. Input edge cases: empty country, empty host, very long label. Each settles with a short message.
  const e24a = env({ pool: [listing("10.7.0.1", 1080, "DE", 99)] });
  const r24a = await e24a.connect({ type: "CONNECT_FREE", countryCode: "" });
  check("empty country code: asks for a country", r24a.final.status === "disconnected" && /Pick a country/.test(r24a.final.lastError || ""), r24a.final.lastError);
  const e24b = env({ seed: { servers: [{ id: "h", label: "No host", country: "DE", host: "", port: 1080 }] } });
  const r24b = await e24b.connect({ type: "CONNECT_CUSTOM", serverId: "h" });
  check("empty host: server is not used, message shown", r24b.final.status === "disconnected" && /not found/.test(r24b.final.lastError || ""), r24b.final.lastError);
  const e24c = env({ proxies: { "10.7.1.1:1080": { dead: true, ms: 30 } }, seed: { servers: [{ id: "l", label: "L".repeat(5000), country: "DE", host: "10.7.1.1", port: 1080 }] } });
  const r24c = await e24c.connect({ type: "CONNECT_CUSTOM", serverId: "l" });
  check("very long label: short message, no crash", r24c.final.status === "disconnected" && (r24c.final.lastError || "").length < 80, `${(r24c.final.lastError || "").length} chars`);

  // --- 26. A stored custom server with a bad port is reported as such, and never applied
  const e26 = env({ proxies: { "10.9.9.9:1080": { ms: 30, cc: "DE" } }, seed: { servers: [
    { id: "blank", label: "Blank port", country: "DE", host: "10.9.9.9", port: "" },
    { id: "text", label: "Text port", country: "DE", host: "10.9.9.9", port: "abc" },
    { id: "range", label: "Big port", country: "DE", host: "10.9.9.9", port: 70000 },
    { id: "ok", label: "Good port", country: "DE", host: "10.9.9.9", port: "1080" }
  ] } });
  for (const id of ["blank", "text", "range"]) {
    const r = await e26.connect({ type: "CONNECT_CUSTOM", serverId: id });
    check(`custom server with bad port (${id}): reported, not applied`, r.final.status === "disconnected" && /invalid port\. Fix it in Options\./.test(r.final.lastError || ""), r.final.lastError);
  }
  check("bad-port servers never reached the browser", e26.log.applied.every((a) => a === "CLEARED") && e26.log.pacs.length === 0, e26.log.applied.join(" "));
  const r26 = await e26.connect({ type: "CONNECT_CUSTOM", serverId: "ok" });
  check("valid stored port (string) still connects", r26.final.status === "connected", r26.final.lastError || r26.final.status);

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
