const tbody = document.getElementById("servers-body");
const addBtn = document.getElementById("add-btn");
const saveBtn = document.getElementById("save-btn");
const savedMsg = document.getElementById("saved-msg");
const autoSwitchEl = document.getElementById("auto-switch");

let servers = [];

function render() {
  tbody.innerHTML = "";
  servers.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input aria-label="Label" data-field="label" data-i="${i}" value="${s.label}"></td>
      <td><input aria-label="Country code" data-field="country" data-i="${i}" value="${s.country}" maxlength="2"></td>
      <td><input aria-label="Host" data-field="host" data-i="${i}" value="${s.host}"></td>
      <td><input aria-label="Port" data-field="port" data-i="${i}" value="${s.port}" type="number"></td>
      <td><input aria-label="Username" data-field="username" data-i="${i}" value="${s.username}"></td>
      <td><input aria-label="Password" data-field="password" data-i="${i}" value="${s.password}" type="password"></td>
      <td><button data-remove="${i}" class="secondary">Remove</button></td>
    `;
    tbody.appendChild(tr);
  });
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
