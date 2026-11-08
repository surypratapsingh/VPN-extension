// Checks the proxy-list parsers in background.js (HProxy and monosans) on sample data.
// Run: node tests/parsers.test.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

// background.js registers listeners when it loads; no-op stubs are enough for the parsers.
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

// Run a parser inside the VM and copy the result back into this realm.
const parse = (fn, data) => JSON.parse(JSON.stringify(vm.runInContext(`${fn}(${JSON.stringify(data)})`, ctx)));

const de = { country: { iso_code: "DE", names: { en: "Germany" } } };
const monosans = [
  { protocol: "socks5", host: "1.2.3.4", port: 1080, timeout: 0.5, geolocation: de },
  { protocol: "socks5", host: "5.6.7.8", port: 1080, timeout: 2, geolocation: de },
  { protocol: "socks5", host: "3.3.3.3", port: 1080, timeout: 0.1, geolocation: { country: { iso_code: "de" } } },
  { protocol: "http", host: "9.9.9.9", port: 8080, timeout: 0.1, geolocation: de },
  { protocol: "socks5", host: "2.2.2.2", port: 1080, username: "u", timeout: 0.1, geolocation: de },
  { protocol: "socks5", host: "not-an-ip", port: 1080, timeout: 0.1, geolocation: de },
];
const kept = parse("parseMonosansList", monosans);
// Only plain socks5 with a valid IPv4 host survives; faster (lower timeout) sorts first; country is upper-cased.
assert.deepStrictEqual(kept.map((p) => p.host), ["3.3.3.3", "1.2.3.4", "5.6.7.8"]);
assert.deepStrictEqual(kept.map((p) => p.country), ["DE", "DE", "DE"]);
assert.equal(kept[1].countryName, "Germany");

const hproxy = [
  { ip: "10.0.0.1", port: 1080, country_code: "fr", uptime_pct: 40 },
  { ip: "10.0.0.2", port: 1080, country_code: "FR", uptime_24h: 90 },
  { ip: "10.0.0.3", port: 70000, country_code: "FR", uptime_pct: 99 },
  { ip: "10.0.0.4", port: 1080, country_code: "FRA", uptime_pct: 99 },
];
// Bad port and bad country code are dropped; uptime_24h is used when uptime_pct is missing; highest uptime first.
assert.deepStrictEqual(parse("parseHProxyList", hproxy).map((p) => p.host), ["10.0.0.2", "10.0.0.1"]);
assert.deepStrictEqual(parse("parseHProxyList", {}), []);

console.log("PASS parseMonosansList keeps plain socks5 IPv4 entries, fastest first");
console.log("PASS parseHProxyList drops bad ports and codes, sorts by uptime");
console.log("ALL PASSED");
