// Checks that options.js shows stored server fields as plain text (no HTML parsing).
// Uses a small fake DOM, so it runs with plain Node and no dependencies.
// Run: node tests/options.test.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const PAYLOAD = "<img src=x onerror=alert(1)>";

const log = { created: [], innerHTMLWrites: [] };

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.className = "";
    this._html = "";
    log.created.push(this);
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.children = []; log.innerHTMLWrites.push(v); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
}

const els = {
  "servers-body": new El("tbody"),
  "add-btn": new El("button"),
  "save-btn": new El("button"),
  "saved-msg": new El("span"),
  "auto-switch": new El("input"),
};
// The log already holds these fixtures; only rows built by options.js are checked below.
log.created.length = 0;
log.innerHTMLWrites.length = 0;

const servers = [{ id: "s1", label: PAYLOAD, country: "DE", host: "1.2.3.4", port: 1080, username: "", password: "" }];
const chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg.type === "GET_SERVERS") return { servers };
      if (msg.type === "GET_SETTINGS") return { autoSwitch: true };
      return {};
    },
  },
};
const document = {
  getElementById: (id) => els[id],
  createElement: (tag) => new El(tag),
};

const ctx = vm.createContext({ document, chrome, console, setTimeout });
vm.runInContext(SRC, ctx);

(async () => {
  await new Promise((r) => setTimeout(r, 0)); // let init() finish its messages

  assert.equal(log.innerHTMLWrites.some((h) => h.includes("<img")), false, "no HTML string contains the payload");
  const tbody = els["servers-body"];
  assert.equal(tbody.children.length, 1, "one row per stored server");
  const row = tbody.children[0];
  const labelInput = row.children[0].children[0];

  assert.equal(labelInput.value, PAYLOAD, "the stored text is kept as typed");
  assert.equal(labelInput.dataset.field, "label");
  assert.equal(labelInput.children.length, 0, "no element was parsed out of the label");
  assert.equal(log.created.some((e) => e.tagName === "IMG"), false, "no <img> element was created");

  assert.equal(row.children[6].children[0].textContent, "Remove");
  console.log("PASS stored label with HTML stays plain text in its input");
  console.log("ALL PASSED");
})().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
