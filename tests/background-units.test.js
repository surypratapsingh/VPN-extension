// Unit tests for background.js pieces that the scenario test only reaches indirectly:
// proxy auth, custom-server storage messages, trace parsing and proxy entry checks.
// Run: node tests/background-units.test.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function load(seed = {}) {
  const store = structuredClone(seed);
  const listeners = {};
  const chrome = {
    webRequest: { onAuthRequired: { addListener: (fn) => { listeners.auth = fn; } }, onErrorOccurred: { addListener() {} } },
    runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } } },
    storage: {
      local: {
        get: async (k) => { const o = {}; for (const key of Array.isArray(k) ? k : [k]) if (key in store) o[key] = structuredClone(store[key]); return o; },
        set: async (o) => { Object.assign(store, structuredClone(o)); },
        remove: async (k) => { delete store[k]; },
      },
    },
    proxy: { settings: { set: async () => {}, clear: async () => {} } },
  };
  const ctx = vm.createContext({ chrome, console, URL, AbortController, setTimeout, clearTimeout, performance, DOMException });
  vm.runInContext(SRC, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  // Copy results back into this realm so deepEqual compares plain objects.
  const call = async (fn, ...args) => JSON.parse(JSON.stringify(await run(`${fn}(...${JSON.stringify(args)})`) ?? null));
  const send = (msg) => new Promise((res) => listeners.message(msg, {}, (r) => res(JSON.parse(JSON.stringify(r)))));
  const auth = (details) => new Promise((res) => listeners.auth(details, (r) => res(JSON.parse(JSON.stringify(r)))));
  return { store, call, send, auth };
}

const SERVERS = [
  { id: "a", label: "Alpha", country: "DE", host: "10.0.0.1", port: 1080, username: "u1", password: "p1" },
  { id: "b", label: "Beta", country: "DE", host: "10.0.0.2", port: 1080 },
];
const proxyAuth = (host) => ({ isProxy: true, challenger: { host, port: 1080 } });

let n = 0;
async function test(name, fn) {
  try { await fn(); n++; console.log("ok   " + name); } catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}

(async () => {
  // --- Proxy authentication
  await test("auth: site (non-proxy) login prompts are left alone", async () => {
    const e = load({ state: { status: "connected" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth({ isProxy: false, challenger: { host: "10.0.0.1" } }), {});
  });
  await test("auth: connected, matching custom host gets its saved credentials", async () => {
    const e = load({ state: { status: "connected" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth(proxyAuth("10.0.0.1")), { authCredentials: { username: "u1", password: "p1" } });
  });
  await test("auth: connecting counts as active too", async () => {
    const e = load({ state: { status: "connecting" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth(proxyAuth("10.0.0.1")), { authCredentials: { username: "u1", password: "p1" } });
  });
  await test("auth: credentials are never sent to a different host", async () => {
    const e = load({ state: { status: "connected" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth(proxyAuth("10.0.0.99")), { cancel: true });
  });
  await test("auth: a server without a username gets no login (cancel, no dialog)", async () => {
    const e = load({ state: { status: "connected" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth(proxyAuth("10.0.0.2")), { cancel: true });
  });
  await test("auth: disconnected state cancels even for a known host", async () => {
    const e = load({ state: { status: "disconnected" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth(proxyAuth("10.0.0.1")), { cancel: true });
  });
  await test("auth: no saved state at all cancels (default is disconnected)", async () => {
    const e = load({ servers: SERVERS });
    assert.deepStrictEqual(await e.auth(proxyAuth("10.0.0.1")), { cancel: true });
  });
  await test("auth: missing challenger cancels instead of throwing", async () => {
    const e = load({ state: { status: "connected" }, servers: SERVERS });
    assert.deepStrictEqual(await e.auth({ isProxy: true }), { cancel: true });
  });

  // --- Messages
  await test("messages: SAVE_SERVERS then GET_SERVERS round-trips", async () => {
    const e = load();
    assert.deepStrictEqual(await e.send({ type: "GET_SERVERS" }), { ok: true, servers: [] });
    assert.deepStrictEqual(await e.send({ type: "SAVE_SERVERS", servers: SERVERS }), { ok: true });
    assert.deepStrictEqual((await e.send({ type: "GET_SERVERS" })).servers, SERVERS);
  });
  await test("messages: placeholder and hostless servers are hidden from connect (getCustomServers)", async () => {
    const e = load({ servers: [{ id: "x", host: "REPLACE_ME" }, { id: "y" }, SERVERS[1]] });
    assert.deepStrictEqual((await e.call("getCustomServers")).map((s) => s.id), ["b"]);
  });
  await test("messages: auto-switch is on by default and only an explicit false turns it off", async () => {
    const e = load();
    assert.strictEqual((await e.send({ type: "GET_SETTINGS" })).autoSwitch, true);
    await e.send({ type: "SAVE_SETTINGS" });
    assert.strictEqual(e.store.autoSwitch, true);
    await e.send({ type: "SAVE_SETTINGS", autoSwitch: false });
    assert.strictEqual((await e.send({ type: "GET_SETTINGS" })).autoSwitch, false);
    await e.send({ type: "SAVE_SETTINGS", autoSwitch: true });
    assert.strictEqual((await e.send({ type: "GET_SETTINGS" })).autoSwitch, true);
  });
  await test("messages: unknown type answers ok:false and names the type", async () => {
    const e = load();
    const r = await e.send({ type: "NOPE" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Unknown message type: NOPE/);
  });
  await test("messages: CONNECT_CUSTOM for a missing server ends disconnected with the reason", async () => {
    const e = load({ servers: SERVERS });
    assert.deepStrictEqual(await e.send({ type: "CONNECT_CUSTOM", serverId: "zzz" }), { ok: true, started: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(e.store.state.status, "disconnected");
    assert.strictEqual(e.store.state.lastError, "Server not found");
  });

  // --- Trace parsing
  await test("parseTrace: reads ip and country, trims, tolerates junk lines and = in values", async () => {
    const e = load();
    const r = await e.call("parseTrace", "fl=1\nnoequals\nip= 1.2.3.4 \nloc=DE\nuag=a=b=c\n");
    assert.deepStrictEqual(r, { ip: "1.2.3.4", countryCode: "DE", country: "Germany", city: "" });
  });
  await test("parseTrace: rejects missing ip, missing loc and non-uppercase or long country codes", async () => {
    const e = load();
    for (const t of ["loc=DE\n", "ip=1.2.3.4\n", "ip=1.2.3.4\nloc=de\n", "ip=1.2.3.4\nloc=DEU\n", "ip=1.2.3.4\nloc=D1\n", ""]) {
      assert.strictEqual(await e.call("parseTrace", t), null, JSON.stringify(t));
    }
  });
  await test("parseTrace: an unknown but well-formed code falls back to the code itself", async () => {
    const e = load();
    const r = await e.call("parseTrace", "ip=1.2.3.4\nloc=ZZ\n");
    assert.strictEqual(r.countryCode, "ZZ");
    assert.ok(r.country.length > 0);
  });

  // --- Proxy entry checks (these values end up inside the generated PAC script)
  await test("makeProxy: accepts a clean entry, upper-cases the country, defaults name and uptime", async () => {
    const e = load();
    assert.deepStrictEqual(await e.call("makeProxy", "1.2.3.4", "1080", "de"), { host: "1.2.3.4", port: 1080, country: "DE", countryName: "DE", uptime: 0 });
    assert.deepStrictEqual(await e.call("makeProxy", "1.2.3.4", 1080, "DE", "Germany", 97), { host: "1.2.3.4", port: 1080, country: "DE", countryName: "Germany", uptime: 97 });
    assert.strictEqual((await e.call("makeProxy", "1.2.3.4", 1080, "DE", null, "97")).uptime, 0);
  });
  await test("makeProxy: rejects anything that could break out of the PAC script", async () => {
    const e = load();
    for (const host of ['1.2.3.4"; evil()//', "example.com", "1.2.3", "1.2.3.4.5", "", null, "1.2.3.4 ", "999.1.1.1", "1.2.3.256", "300.300.300.300"]) {
      assert.strictEqual(await e.call("makeProxy", host, 1080, "DE"), null, String(host));
    }
    for (const port of [0, 65536, -1, 1080.5, "abc", "", null]) {
      assert.strictEqual(await e.call("makeProxy", "1.2.3.4", port, "DE"), null, String(port));
    }
    for (const cc of ["", "D", "DEU", "1E", null]) assert.strictEqual(await e.call("makeProxy", "1.2.3.4", 1080, cc), null, String(cc));
    assert.ok(await e.call("makeProxy", "255.255.255.255", 65535, "DE"));
    assert.ok(await e.call("makeProxy", "0.0.0.0", 1, "DE"));
  });

  // --- Pool merge
  await test("mergePools: primary first, extras after, duplicates by host:port dropped once", async () => {
    const e = load();
    const P = (host, port, tag) => ({ host, port, tag });
    const r = await e.call("mergePools", [P("1.1.1.1", 1, "p1"), P("2.2.2.2", 1, "p2")], [P("2.2.2.2", 1, "x-dup"), P("3.3.3.3", 1, "x3"), P("3.3.3.3", 1, "x3-dup"), P("2.2.2.2", 2, "x-port")]);
    assert.deepStrictEqual(r.map((p) => p.tag), ["p1", "p2", "x3", "x-port"]);
    assert.deepStrictEqual(await e.call("mergePools", [], []), []);
  });

  console.log(`\n${n} passed${process.exitCode ? ", some FAILED" : ""}`);
})();
