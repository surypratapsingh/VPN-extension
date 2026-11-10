// Checks popup.js against a small fake DOM: the country list, the status panel and the
// Connect / Try another / Refresh wiring. No browser, no network.
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
    this.hidden = false;
    this.disabled = false;
    this.className = "";
    this.selectedIndex = -1;
    this._value = "";
    this._text = "";
    const classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  async click() {
    for (const fn of this.listeners.click || []) await fn({ target: this, preventDefault() { this.prevented = true; } });
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  set innerHTML(v) {
    this.children = []; // popup.js only ever resets the select this way
  }
  get options() {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === "OPTION") out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  get value() {
    if (this.tagName === "OPTION") return this._value;
    if (this._value) return this._value;
    return this.options.length ? this.options[0].value : "";
  }
  set value(v) {
    if (this.tagName === "OPTION") {
      this._value = String(v);
      return;
    }
    this._value = this.options.some((o) => o.value === v) ? String(v) : "";
  }
}

function load(init) {
  const els = {
    "server-select": new El("select"),
    "connect-btn": new El("button"),
    "rotate-btn": new El("button"),
    status: new El("span"),
    detail: new El("div"),
    "pool-info": new El("div"),
    "refresh-link": new El("a"),
    "options-link": new El("a"),
  };
  const sent = [];
  let onChanged = null;
  let opened = 0;
  const chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === "GET_INIT") return structuredClone(init);
        if (msg.type === "REFRESH_POOL") return structuredClone(init.refresh);
        return { ok: true };
      },
      openOptionsPage: async () => {
        opened++;
      },
    },
    storage: { onChanged: { addListener: (fn) => (onChanged = fn) } },
  };
  const document = { getElementById: (id) => els[id], createElement: (tag) => new El(tag) };
  const ctx = vm.createContext({ document, chrome, console, setTimeout, Date });
  vm.runInContext(SRC, ctx, { filename: "popup.js" });
  return {
    els,
    sent,
    ctx,
    ready: new Promise((r) => setTimeout(r, 0)),
    changed: (changes, area = "local") => onChanged(changes, area),
    opened: () => opened,
  };
}

// Messages are built inside the VM realm, so compare a copy with this realm's prototypes.
const sentMsg = (run) => JSON.parse(JSON.stringify(run.sent.at(-1)));

const countries = [
  { country: "DE", countryName: "Germany", count: 12 },
  { country: "FR", countryName: "France", count: 3 },
];
const servers = [{ id: "s1", label: "Home box", country: "SG" }];
const refreshed = [{ country: "US", countryName: "United States", count: 5 }];

(async () => {
  // --- 1. Opens on the cached list: grouped options, counts, fresh state
  const a = load({ countries, servers, state: { status: "disconnected" }, poolFetchedAt: Date.now() - 2 * 60000, refresh: { ok: true, countries: refreshed } });
  await a.ready;
  const sel = a.els["server-select"];
  assert.strictEqual(vm.runInContext(`flag("DE")`, a.ctx), "\u{1F1E9}\u{1F1EA}");
  assert.strictEqual(vm.runInContext(`flag("de")`, a.ctx), "", "a non-uppercase code has no flag");
  assert.strictEqual(vm.runInContext(`flag("USA")`, a.ctx), "", "a 3-letter code has no flag");
  assert.strictEqual(sel.children.length, 2, "one optgroup for free proxies, one for custom servers");
  assert.strictEqual(sel.children[0].label, "Free proxies");
  assert.strictEqual(sel.children[1].label, "My servers");
  assert.deepStrictEqual(sel.options.map((o) => o.value), ["free:DE", "free:FR", "custom:s1"]);
  assert.strictEqual(sel.options[0].textContent, "\u{1F1E9}\u{1F1EA} Germany (12)");
  assert.strictEqual(sel.value, "free:DE");
  assert.strictEqual(a.els["pool-info"].textContent, "15 free proxies · 2 countries · updated 2m ago");
  assert.strictEqual(a.els["status"].textContent, "Not connected");
  assert.strictEqual(a.els["connect-btn"].textContent, "Connect");
  assert.strictEqual(a.els["rotate-btn"].hidden, true);
  console.log("PASS list renders grouped options, counts and age");

  // --- 2. Connect uses the selected free country or custom server
  await a.els["connect-btn"].click();
  assert.deepStrictEqual(sentMsg(a), { type: "CONNECT_FREE", countryCode: "DE" });
  sel.value = "custom:s1";
  await a.els["connect-btn"].click();
  assert.deepStrictEqual(sentMsg(a), { type: "CONNECT_CUSTOM", serverId: "s1" });
  console.log("PASS Connect sends the selected target");

  // --- 3. Refresh list replaces the list and shows a fresh age
  await a.els["refresh-link"].click();
  assert.strictEqual(sentMsg(a).type, "REFRESH_POOL");
  assert.deepStrictEqual(sel.options.map((o) => o.value), ["free:US", "custom:s1"]);
  assert.strictEqual(sel.value, "custom:s1", "the current selection survives a refresh");
  assert.strictEqual(a.els["pool-info"].textContent, "5 free proxies · 1 countries · updated 0m ago");
  console.log("PASS Refresh list re-renders and keeps the selection");

  // --- 4. A failed refresh is reported instead of silently keeping the old count
  const a2 = load({ countries, servers, state: { status: "disconnected" }, poolFetchedAt: Date.now(), refresh: { ok: false, error: "HTTP 503" } });
  await a2.ready;
  await a2.els["refresh-link"].click();
  assert.strictEqual(a2.els["pool-info"].textContent, "Refresh failed: HTTP 503");
  console.log("PASS failed refresh is reported");

  // --- 5. Connected: status panel, Disconnect button, Try another
  const b = load({
    countries,
    servers,
    state: {
      status: "connected",
      target: "DE",
      proxy: { host: "1.2.3.4", port: 1080 },
      info: { ip: "5.6.7.8", country: "Germany", city: "Berlin" },
      latencyMs: 120,
      note: "Switched proxy: the last one failed",
      tried: ["1.2.3.4:1080"],
    },
    poolFetchedAt: null,
    refresh: { ok: true, countries },
  });
  await b.ready;
  assert.strictEqual(b.els["status"].textContent, "Connected");
  assert.strictEqual(b.els["status"].className, "connected");
  assert.strictEqual(
    b.els["detail"].textContent,
    "5.6.7.8 — Berlin, Germany\nvia 1.2.3.4:1080 · 120 ms\nSwitched proxy: the last one failed"
  );
  assert.strictEqual(b.els["connect-btn"].textContent, "Disconnect");
  assert.strictEqual(b.els["connect-btn"].classList.contains("danger"), true);
  assert.strictEqual(b.els["server-select"].disabled, true);
  assert.strictEqual(b.els["rotate-btn"].hidden, false);
  assert.strictEqual(b.els["server-select"].value, "free:DE", "the connected country is selected");
  assert.strictEqual(b.els["pool-info"].textContent, "15 free proxies · 2 countries", "no age without a fetch time");
  await b.els["connect-btn"].click();
  assert.deepStrictEqual(sentMsg(b), { type: "DISCONNECT" });
  await b.els["rotate-btn"].click();
  assert.deepStrictEqual(sentMsg(b), { type: "CONNECT_FREE", countryCode: "DE", skip: ["1.2.3.4:1080"] });
  await b.els["options-link"].click();
  assert.strictEqual(b.opened(), 1);
  console.log("PASS connected panel, Disconnect, Try another skip list and Options link");

  // --- 6. Connecting shows the race progress and disables the controls
  const c = load({ countries, servers, state: { status: "connecting", racing: 3, round: 1, rounds: 2 }, poolFetchedAt: Date.now(), refresh: { ok: true, countries } });
  await c.ready;
  assert.strictEqual(c.els["status"].textContent, "Connecting…");
  assert.strictEqual(c.els["detail"].textContent, "Racing 3 proxies at once — round 1 of 2");
  assert.strictEqual(c.els["connect-btn"].textContent, "Connecting…");
  assert.strictEqual(c.els["connect-btn"].disabled, true);
  assert.strictEqual(c.els["server-select"].disabled, true);
  assert.strictEqual(c.els["rotate-btn"].hidden, true);
  console.log("PASS connecting state shows race progress");

  // --- 7. A single test (custom server) says "Testing server…"; errors are shown as-is
  const d = load({ countries, servers, state: { status: "connecting", racing: 1, round: 1, rounds: 1 }, poolFetchedAt: Date.now(), refresh: { ok: true, countries } });
  await d.ready;
  assert.strictEqual(d.els["detail"].textContent, "Testing server…");
  const e = load({ countries, servers, state: { status: "disconnected", lastError: "Tested 2 DE proxies; 1 didn't respond" }, poolFetchedAt: Date.now(), refresh: { ok: true, countries } });
  await e.ready;
  assert.strictEqual(e.els["status"].textContent, "Not connected");
  assert.strictEqual(e.els["status"].className, "error");
  assert.strictEqual(e.els["detail"].textContent, "Tested 2 DE proxies; 1 didn't respond");
  console.log("PASS custom-server progress and error text");

  // --- 8. No list at all invites a refresh and blocks Connect
  const f = load({ countries: [], servers: [], state: { status: "disconnected" }, poolFetchedAt: null, refresh: { ok: true, countries: [] } });
  await f.ready;
  assert.strictEqual(f.els["pool-info"].textContent, "Proxy list unavailable — hit Refresh");
  assert.deepStrictEqual(f.els["server-select"].options.map((o) => o.textContent), ["No proxies available"]);
  assert.strictEqual(f.els["connect-btn"].disabled, true);
  console.log("PASS empty list blocks Connect and asks for a refresh");

  // --- 9. Storage changes re-render the popup (other areas are ignored)
  const g = load({ countries, servers, state: { status: "disconnected" }, poolFetchedAt: Date.now(), refresh: { ok: true, countries } });
  await g.ready;
  g.changed({ state: { newValue: { status: "connected", target: "FR", proxy: { host: "9.9.9.9", port: 1080 }, info: { ip: "1.1.1.1", country: "France" } } } });
  assert.strictEqual(g.els["status"].textContent, "Connected");
  assert.strictEqual(g.els["server-select"].value, "free:FR");
  g.changed({ state: { newValue: { status: "disconnected" } } }, "sync");
  assert.strictEqual(g.els["status"].textContent, "Connected", "a sync-storage change is ignored");
  console.log("PASS storage changes re-render the popup");

  console.log("ALL PASSED");
})().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
