// Checks updateProxyHealth in background.js: proxies that fail N probes in a row are
// dropped from the pool, a winner has its count cleared, and stored counts stay bounded.
// Run: node tests/proxy-health.test.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

// background.js registers listeners when it loads; no-op stubs are enough here.
const noop = { addListener() {} };
const ctx = vm.createContext({
  chrome: {
    webRequest: { onAuthRequired: noop, onErrorOccurred: noop },
    runtime: { onMessage: noop },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    proxy: { settings: { set: async () => {}, clear: async () => {} } },
  },
  console,
});
vm.runInContext(SRC, ctx);

// Run the real function inside the VM and copy the result back into this realm.
const health = (pool, failures, dead, winner, limit) =>
  JSON.parse(
    JSON.stringify(
      vm.runInContext(
        `updateProxyHealth(${JSON.stringify(pool)}, ${JSON.stringify(failures)}, ${JSON.stringify(dead)}, ${JSON.stringify(winner)}${
          limit === undefined ? "" : `, ${limit}`
        })`,
        ctx
      )
    )
  );
const p = (host, port = 1080) => ({ host, port, country: "DE", countryName: "DE", uptime: 50 });
const hosts = (result) => result.pool.map((x) => x.host);

const pool = [p("10.0.0.1"), p("10.0.0.2"), p("10.0.0.3")];

// --- 1. Below the limit nothing is dropped; each failed probe raises the count by one
let h = health(pool, {}, ["10.0.0.1:1080"], null);
assert.deepStrictEqual(hosts(h), ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
assert.strictEqual(h.failures["10.0.0.1:1080"], 1);
h = health(pool, h.failures, ["10.0.0.1:1080"], null);
assert.strictEqual(h.failures["10.0.0.1:1080"], 2);
assert.deepStrictEqual(hosts(h), ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
console.log("PASS first two failures keep the proxy in the pool");

// --- 2. The Nth failure drops it, and it stays dropped while the count is stored
assert.strictEqual(vm.runInContext("PROXY_FAILURE_LIMIT", ctx), 3, "default limit is 3");
h = health(pool, h.failures, ["10.0.0.1:1080"], null);
assert.deepStrictEqual(hosts(h), ["10.0.0.2", "10.0.0.3"]);
assert.strictEqual(h.failures["10.0.0.1:1080"], 3);
assert.deepStrictEqual(hosts(health(pool, h.failures, [], null)), ["10.0.0.2", "10.0.0.3"]);
console.log("PASS third failure drops the proxy and it stays out");

// --- 3. A winner is cleared and stays eligible
h = health(pool, { "10.0.0.2:1080": 2 }, [], p("10.0.0.1"));
assert.deepStrictEqual(hosts(h), ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
assert.strictEqual(h.failures["10.0.0.1:1080"], undefined);
assert.strictEqual(h.failures["10.0.0.2:1080"], 2);
console.log("PASS a winning proxy has its failure count cleared");

// --- 4. Counts for hosts no longer in the pool are pruned, so storage stays bounded
h = health([p("10.0.0.1")], { "10.0.0.1:1080": 1, "9.9.9.9:1080": 2 }, [], null);
assert.deepStrictEqual(Object.keys(h.failures), ["10.0.0.1:1080"]);
assert.deepStrictEqual(h.failures, { "10.0.0.1:1080": 1 });
console.log("PASS counts of proxies that left the pool are pruned");

// --- 5. Failures for hosts outside the pool never create an entry
assert.deepStrictEqual(health(pool, {}, ["9.9.9.9:1080"], null).failures, {});
console.log("PASS failures outside the pool are ignored");

// --- 6. The limit is a parameter: with limit 1 a single failure is enough
h = health(pool, {}, ["10.0.0.1:1080"], null, 1);
assert.deepStrictEqual(hosts(h), ["10.0.0.2", "10.0.0.3"]);
console.log("PASS a custom limit of 1 drops after one failure");

// --- 7. Malformed stored counts neither resurrect nor hide a proxy
h = health(pool, { "10.0.0.1:1080": 0, "10.0.0.2:1080": "x" }, [], null);
assert.deepStrictEqual(h.failures, {});
assert.deepStrictEqual(hosts(h), ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
assert.deepStrictEqual(health(null, null, null, null).pool, []);
console.log("PASS malformed counts are ignored");

console.log("ALL PASSED");
