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
  await chrome.runtime.sendMessage({ type: "SAVE_SERVERS", servers });
  await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", autoSwitch: autoSwitchEl.checked });
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
