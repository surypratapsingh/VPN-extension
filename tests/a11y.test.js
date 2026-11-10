// Static accessibility checks for the two extension pages: links are keyboard-reachable,
// status text is announced, and form controls have accessible names.
// Run: node tests/a11y.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const popup = read("popup.html");
const options = read("options.html");

// Links without href are not focusable with the keyboard and are not announced as links.
for (const [name, html] of [["popup.html", popup], ["options.html", options]]) {
  for (const tag of html.match(/<a\b[^>]*>/g) || []) {
    assert.match(tag, /\shref=/, `${name}: link without href is not keyboard-reachable: ${tag}`);
  }
}
console.log("PASS every link has an href (keyboard-reachable)");

// Text that changes after an action must be announced.
assert.match(popup, /<div id="status"[^>]*role="status"/, "popup: #status is announced when it changes");
console.log("PASS popup status is a live region");
assert.match(options, /<span id="saved-msg"[^>]*role="status"/, "options: save result is announced");
console.log("PASS options save message is a live region");

// Every static form control has an accessible name.
for (const [name, html] of [["popup.html", popup], ["options.html", options]]) {
  for (const tag of html.match(/<(input|select)\b[^>]*>/g) || []) {
    if (/type="hidden"/.test(tag)) continue;
    const id = (tag.match(/\sid="([^"]+)"/) || [])[1];
    const named = /aria-label=/.test(tag) || (id && new RegExp(`<label[^>]*for="${id}"`).test(html)) || /^<label/.test(tag);
    const wrapped = id ? new RegExp(`<label[^>]*>[^<]*<input[^>]*id="${id}"`).test(html) : false;
    assert.ok(named || wrapped, `${name}: control has no accessible name: ${tag}`);
  }
}
console.log("PASS every static form control has an accessible name");
console.log("ALL PASSED");
