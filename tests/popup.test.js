// Checks popup.js: the server list, the status text, and the button handlers, on a small fake DOM.
// Uses plain Node and no dependencies, like the other tests here.
// Run: node tests/popup.test.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.className = "";
    this.classes = new Set();
    this.classList = {
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      has: (c) => this.classes.has(c),
    };
  }
  // A select's options are its direct <option> children and those inside <optgroup>s.
  get options() {
    return this.children.flatMap((c) => (c.tagName === "OPTGROUP" ? c.children : c.tagName === "OPTION" ? [c] : []));
  }
  get selectedIndex() { return this.options.findIndex((o) => o.value === this.value); }
  set selectedIndex(i) { this.value = this.options[i].value; }
  set innerHTML(v) { this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const COUNTRIES = [
  { country: "DE", countryName: "Germany", count: 3 },
  { country: "FR", countryName: "France", count: 2 },
];
const SERVERS = [{ id: "s1", label: "My VPS", country: "NL" }];

// Loads popup.js against a fresh fake DOM. `init` is the GET_INIT reply.
async function boot(init) {
  const els = {};
  for (const id of ["server-select", "connect-btn", "rotate-btn", "status", "detail", "pool-info", "refresh-link", "options-link"]) {
    els[id] = new El(id.endsWith("btn") || id.endsWith("link") ? (id.endsWith("link") ? "a" : "button") : "div");
  }
  els["server-select"].tagName = "SELECT";
  els["rotate-btn"].hidden = true;
  const sent = [];
  let optionsOpened = false;
  const chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === "GET_INIT") return init;
        return { ok: true };
      },
      openOptionsPage: () => { optionsOpened = true; },
    },
    storage: { onChanged: { addListener() {} } },
  };
  const document = {
    getElementById: (id) => els[id],
    createElement: (tag) => new El(tag),
  };
  const ctx = vm.createContext({ document, chrome, console, Date, setTimeout });
  vm.runInContext(SRC, ctx);
  await tick();
  return { els, sent, optionsOpened: () => optionsOpened };
}

const SETTLED = { countries: COUNTRIES, servers: SERVERS, state: { status: "disconnected" }, poolFetchedAt: null };

const checks = [
  ["server list groups free and custom proxies", async () => {
    const { els } = await boot(SETTLED);
    assert.deepEqual(els["server-select"].options.map((o) => o.value), ["free:DE", "free:FR", "custom:s1"]);
    assert.equal(els["server-select"].options[0].textContent, "🇩🇪 Germany (3)");
    assert.equal(els["connect-btn"].disabled, false);
    assert.equal(els["pool-info"].textContent, "5 free proxies · 2 countries");
  }],
  ["connected shows the exit IP, proxy and latency, and offers Disconnect", async () => {
    const state = {
      status: "connected", target: "DE", latencyMs: 120,
      info: { ip: "1.2.3.4", city: "Berlin", country: "DE" },
      proxy: { host: "10.0.0.1", port: 8080 },
    };
    const { els } = await boot({ ...SETTLED, state });
    assert.equal(els["connect-btn"].textContent, "Disconnect");
    assert.equal(els["connect-btn"].classes.has("danger"), true);
    assert.equal(els["rotate-btn"].hidden, false);
    assert.equal(els["status"].textContent, "Connected");
    assert.equal(els["detail"].textContent, "1.2.3.4 — Berlin, DE\nvia 10.0.0.1:8080 · 120 ms");
    assert.equal(els["server-select"].value, "free:DE");
  }],
  ["a failed connect shows the error text in red", async () => {
    const { els } = await boot({ ...SETTLED, state: { status: "disconnected", lastError: "No proxy answered" } });
    assert.equal(els["status"].className, "error");
    assert.equal(els["detail"].textContent, "No proxy answered");
    assert.equal(els["connect-btn"].textContent, "Connect");
  }],
  ["connecting locks the picker and shows the race progress", async () => {
    const state = { status: "connecting", racing: 3, round: 1, rounds: 2 };
    const { els } = await boot({ ...SETTLED, state });
    assert.equal(els["server-select"].disabled, true);
    assert.equal(els["connect-btn"].disabled, true);
    assert.equal(els["connect-btn"].textContent, "Connecting…");
    assert.equal(els["detail"].textContent, "Racing 3 proxies at once — round 1 of 2");
  }],
  ["Connect with a free country sends CONNECT_FREE for that country", async () => {
    const { els, sent } = await boot(SETTLED);
    els["server-select"].value = "free:FR";
    await els["connect-btn"].listeners.click[0]();
    assert.deepEqual(sent.at(-1), { type: "CONNECT_FREE", countryCode: "FR" });
  }],
  ["Connect with a custom server sends CONNECT_CUSTOM for its id", async () => {
    const { els, sent } = await boot(SETTLED);
    els["server-select"].value = "custom:s1";
    await els["connect-btn"].listeners.click[0]();
    assert.deepEqual(sent.at(-1), { type: "CONNECT_CUSTOM", serverId: "s1" });
  }],
  ["Connect while connected sends DISCONNECT", async () => {
    const state = { status: "connected", target: "DE", info: {}, proxy: { host: "h", port: 1 } };
    const { els, sent } = await boot({ ...SETTLED, state });
    await els["connect-btn"].listeners.click[0]();
    assert.deepEqual(sent.at(-1), { type: "DISCONNECT" });
  }],
  ["Try another proxy skips the ones already tried", async () => {
    const state = { status: "connected", target: "DE", tried: ["1.1.1.1:80"], info: {}, proxy: { host: "h", port: 1 } };
    const { els, sent } = await boot({ ...SETTLED, state });
    await els["rotate-btn"].listeners.click[0]();
    assert.deepEqual(sent.at(-1), { type: "CONNECT_FREE", countryCode: "DE", skip: ["1.1.1.1:80"] });
  }],
  ["Custom servers link opens the options page", async () => {
    const { els, optionsOpened } = await boot(SETTLED);
    els["options-link"].listeners.click[0]();
    assert.equal(optionsOpened(), true);
  }],
];

(async () => {
  for (const [name, fn] of checks) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log("ALL PASSED");
})().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
