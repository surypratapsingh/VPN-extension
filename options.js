const tbody = document.getElementById("servers-body");
const addBtn = document.getElementById("add-btn");
const saveBtn = document.getElementById("save-btn");
const savedMsg = document.getElementById("saved-msg");
const autoSwitchEl = document.getElementById("auto-switch");

let servers = [];

// Stored server fields are user text: set them with .value / textContent, never as HTML.
const FIELDS = [
  { field: "label", label: "Label", type: "text" },
  { field: "country", label: "Country code", type: "text", maxLength: 2 },
  { field: "host", label: "Host", type: "text" },
  { field: "port", label: "Port", type: "number" },
  { field: "username", label: "Username", type: "text" },
  { field: "password", label: "Password", type: "password" }
];

// Inline errors from the last Save, keyed "rowIndex:field". Cleared as the user edits that field.
let errors = {};

// Host and port checks for custom servers. Whitespace is trimmed first and brackets around an
// IPv6 address are dropped. Each returns { value } when valid, otherwise { error }.
const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function isIPv6(host) {
  try {
    return /^[0-9a-f:.]+$/i.test(host) && new URL(`http://[${host}]`).hostname !== "";
  } catch {
    return false;
  }
}

function checkHost(raw) {
  let host = String(raw ?? "").trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return { error: "Enter a host name or IP address." };
  if (host.includes("://") || host.includes("/")) return { error: "Enter only the host name, without http:// or a path." };
  if (isIPv6(host)) return { value: host };
  if (/^[^:]+:\d+$/.test(host)) return { error: "Put the port in the Port field, not the host." };
  if (host.includes(":")) return { error: "Not a valid IPv6 address." };
  if (/^[\d.]+$/.test(host)) return IPV4_RE.test(host) ? { value: host } : { error: "Not a valid IPv4 address." };
  const ok = host.length <= 253 && host.split(".").every((label) => HOST_LABEL_RE.test(label));
  return ok ? { value: host } : { error: "Not a valid host name." };
}

function checkPort(raw) {
  const text = String(raw ?? "").trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1 || n > 65535) return { error: "Port must be a whole number from 1 to 65535." };
  return { value: n };
}

function rowFor(s, i) {
  const tr = document.createElement("tr");
  for (const f of FIELDS) {
    const input = document.createElement("input");
    input.setAttribute("aria-label", f.label);
    input.type = f.type;
    if (f.maxLength) input.maxLength = f.maxLength;
    input.dataset.field = f.field;
    input.dataset.i = String(i);
    input.value = s[f.field] ?? "";
    const td = document.createElement("td");
    td.appendChild(input);
    const error = errors[`${i}:${f.field}`];
    if (error) {
      const note = document.createElement("span");
      note.className = "field-error";
      note.setAttribute("role", "alert");
      note.textContent = error;
      td.appendChild(note);
    }
    tr.appendChild(td);
  }
  const remove = document.createElement("button");
  remove.className = "secondary";
  remove.dataset.remove = String(i);
  remove.textContent = "Remove";
  const td = document.createElement("td");
  td.appendChild(remove);
  tr.appendChild(td);
  return tr;
}

function render() {
  tbody.innerHTML = "";
  servers.forEach((s, i) => tbody.appendChild(rowFor(s, i)));
}

tbody.addEventListener("input", (e) => {
  const i = e.target.dataset.i;
  const field = e.target.dataset.field;
  if (i === undefined || !field) return;
  servers[i][field] = e.target.value;
  delete errors[`${i}:${field}`];
  const note = e.target.parentNode.querySelector(".field-error");
  if (note) note.remove();
});

tbody.addEventListener("click", (e) => {
  if (e.target.dataset.remove !== undefined) {
    servers.splice(Number(e.target.dataset.remove), 1);
    render();
  }
});

addBtn.addEventListener("click", () => {
  servers.push({
    id: `server-${Date.now()}`,
    label: "New Server",
    country: "XX",
    host: "",
    port: 1080,
    username: "",
    password: ""
  });
  render();
});

saveBtn.addEventListener("click", async () => {
  // Nothing is saved while any field is invalid; valid values are stored trimmed and normalized.
  errors = {};
  servers.forEach((s, i) => {
    const host = checkHost(s.host);
    const port = checkPort(s.port);
    if (host.error) errors[`${i}:host`] = host.error;
    else s.host = host.value;
    if (port.error) errors[`${i}:port`] = port.error;
    else s.port = port.value;
  });
  render();
  if (Object.keys(errors).length) {
    savedMsg.className = "error";
    savedMsg.textContent = "Fix the highlighted fields, then save again.";
    return;
  }
  await chrome.runtime.sendMessage({ type: "SAVE_SERVERS", servers });
  await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", autoSwitch: autoSwitchEl.checked });
  savedMsg.className = "";
  savedMsg.textContent = "Saved.";
  setTimeout(() => (savedMsg.textContent = ""), 2000);
});

(async function init() {
  const res = await chrome.runtime.sendMessage({ type: "GET_SERVERS" });
  servers = res.servers;
  render();
  const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).catch(() => null);
  if (settings && typeof settings.autoSwitch === "boolean") autoSwitchEl.checked = settings.autoSwitch;
})();
