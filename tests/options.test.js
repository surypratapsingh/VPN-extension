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

const ctx = vm.createContext({ document, chrome, console, setTimeout, URL });
vm.runInContext(SRC, ctx);

// Host/port validation: plain values in, trimmed value or an inline error out.
const HOST_CASES = [
  ["  10.0.0.1 ", "10.0.0.1"],
  ["vpn.example.com", "vpn.example.com"],
  ["localhost", "localhost"],
  ["my-host.internal", "my-host.internal"],
  ["2001:db8::1", "2001:db8::1"],
  ["[::1]", "::1"],
  ["::ffff:1.2.3.4", "::ffff:1.2.3.4"],
];
const HOST_ERRORS = [
  ["", "Enter a host name or IP address."],
  ["   ", "Enter a host name or IP address."],
  ["256.1.1.1", "Not a valid IPv4 address."],
  ["1.2.3", "Not a valid IPv4 address."],
  ["-bad.example.com", "Not a valid host name."],
  ["bad_host.example.com", "Not a valid host name."],
  ["exa mple.com", "Not a valid host name."],
  ["1.2.3.4:1080", "Put the port in the Port field, not the host."],
  ["2001:db8::1::2", "Not a valid IPv6 address."],
  ["http://example.com", "Not a valid IPv6 address."],
];
for (const [raw, want] of HOST_CASES) {
  const got = ctx.checkHost(raw);
  assert.equal(got.error, undefined, `host ${JSON.stringify(raw)} should be valid`);
  assert.equal(got.value, want, `host ${JSON.stringify(raw)} normalizes to ${want}`);
}
for (const [raw, want] of HOST_ERRORS) {
  assert.equal(ctx.checkHost(raw).error, want, `host ${JSON.stringify(raw)} error`);
}

const PORT_CASES = [
  [" 1080 ", 1080],
  ["1", 1],
  ["65535", 65535],
  [1080, 1080],
];
const PORT_ERRORS = ["", "0", "65536", "-1", "1.5", "1e3", "10 80", "abc", "99999999999999999999"];
for (const [raw, want] of PORT_CASES) {
  const got = ctx.checkPort(raw);
  assert.equal(got.value, want, `port ${JSON.stringify(raw)} is valid as ${want}`);
}
for (const raw of PORT_ERRORS) {
  assert.equal(ctx.checkPort(raw).error, "Port must be a whole number from 1 to 65535.", `port ${JSON.stringify(raw)} rejected`);
}
console.log(`PASS validator: ${HOST_CASES.length} valid hosts, ${HOST_ERRORS.length} rejected hosts, ${PORT_CASES.length} valid ports, ${PORT_ERRORS.length} rejected ports`);

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

  // Save with an invalid port: nothing is sent, the row shows an inline error.
  const sent = [];
  chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return {}; };
  const saveClick = els["save-btn"].listeners.click[0];
  servers[0].host = "  10.0.0.9 ";
  servers[0].port = "70000";
  await saveClick();
  assert.equal(sent.length, 0, "invalid save sends nothing");
  const portCell = tbody.children[0].children[3];
  assert.equal(portCell.children.length, 2, "error note sits next to the port input");
  assert.equal(portCell.children[1].textContent, "Port must be a whole number from 1 to 65535.");
  assert.equal(portCell.children[1].attrs.role, "alert");
  assert.equal(els["saved-msg"].className, "error");

  // Fixing the value and saving again sends trimmed, normalized server data.
  servers[0].port = " 1080 ";
  await saveClick();
  assert.equal(sent[0].type, "SAVE_SERVERS", "valid save sends the servers");
  assert.equal(sent[0].servers[0].host, "10.0.0.9", "host is trimmed before it is stored");
  assert.equal(sent[0].servers[0].port, 1080, "port is stored as a number");
  assert.equal(els["saved-msg"].className, "", "error styling cleared after a good save");
  console.log("PASS save is blocked on invalid fields, and valid values are stored trimmed");
  console.log("ALL PASSED");
})().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
