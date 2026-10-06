const selectEl = document.getElementById("server-select");
const connectBtn = document.getElementById("connect-btn");
const rotateBtn = document.getElementById("rotate-btn");
const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const poolInfoEl = document.getElementById("pool-info");
const refreshLink = document.getElementById("refresh-link");
const optionsLink = document.getElementById("options-link");

let countries = [];
let customServers = [];
let state = { status: "disconnected" };

function flag(cc) {
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

function renderOptions() {
  const previous = selectEl.value;
  selectEl.innerHTML = "";

  if (countries.length) {
    const group = document.createElement("optgroup");
    group.label = "Free proxies";
    for (const c of countries) {
      const opt = document.createElement("option");
      opt.value = `free:${c.country}`;
      opt.textContent = `${flag(c.country)} ${c.countryName} (${c.count})`;
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }

  if (customServers.length) {
    const group = document.createElement("optgroup");
    group.label = "My servers";
    for (const s of customServers) {
      const opt = document.createElement("option");
      opt.value = `custom:${s.id}`;
      opt.textContent = `${flag(s.country)} ${s.label}`;
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }

  if (!selectEl.options.length) {
    const opt = document.createElement("option");
    opt.textContent = "No proxies available";
    selectEl.appendChild(opt);
    connectBtn.disabled = true;
    return;
  }

  if (previous) selectEl.value = previous;
  if (!selectEl.value) selectEl.selectedIndex = 0;
}

function renderState() {
  const busy = state.status === "connecting";
  const connected = state.status === "connected";

  selectEl.disabled = busy || connected;
  connectBtn.disabled = busy || !selectEl.options.length;
  connectBtn.textContent = connected ? "Disconnect" : busy ? "Connecting…" : "Connect";
  connectBtn.classList.toggle("danger", connected);
  rotateBtn.hidden = !connected;

  if (connected) {
    statusEl.textContent = "Connected";
    statusEl.className = "connected";
    const i = state.info || {};
    const where = [i.city, i.country].filter(Boolean).join(", ");
    const speed = state.latencyMs ? ` · ${state.latencyMs} ms` : "";
    const lines = [`${i.ip}${where ? ` — ${where}` : ""}`, `via ${state.proxy?.host}:${state.proxy?.port}${speed}`];
    if (state.note) lines.push(state.note);
    detailEl.textContent = lines.join("\n");
  } else if (busy) {
    statusEl.textContent = "Connecting…";
    statusEl.className = "connecting";
    detailEl.textContent =
      state.racing > 1
        ? `Racing ${state.racing} proxies at once — round ${state.round} of ${state.rounds}`
        : "Testing server…";
  } else if (state.lastError) {
    statusEl.textContent = "Not connected";
    statusEl.className = "error";
    detailEl.textContent = state.lastError;
  } else {
    statusEl.textContent = "Not connected";
    statusEl.className = "disconnected";
    detailEl.textContent = "";
  }

  if (connected && state.target?.length === 2) selectEl.value = `free:${state.target}`;
}

function renderPoolInfo(fetchedAt) {
  if (!countries.length) {
    poolInfoEl.textContent = "Proxy list unavailable — hit Refresh";
    return;
  }
  const total = countries.reduce((n, c) => n + c.count, 0);
  const age = fetchedAt ? Math.round((Date.now() - fetchedAt) / 60000) : null;
  poolInfoEl.textContent = `${total} free proxies · ${countries.length} countries${age !== null ? ` · updated ${age}m ago` : ""}`;
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: "GET_INIT" });
  countries = res.countries || [];
  customServers = res.servers || [];
  state = res.state || { status: "disconnected" };
  renderOptions();
  renderPoolInfo(res.poolFetchedAt);
  renderState();
}

connectBtn.addEventListener("click", async () => {
  if (state.status === "connected") {
    await chrome.runtime.sendMessage({ type: "DISCONNECT" });
    return;
  }
  const [kind, id] = selectEl.value.split(":");
  connectBtn.disabled = true;
  if (kind === "free") {
    await chrome.runtime.sendMessage({ type: "CONNECT_FREE", countryCode: id });
  } else {
    await chrome.runtime.sendMessage({ type: "CONNECT_CUSTOM", serverId: id });
  }
});

rotateBtn.addEventListener("click", async () => {
  if (state.status !== "connected" || !state.target) return;
  const skip = state.tried || [];
  await chrome.runtime.sendMessage({ type: "CONNECT_FREE", countryCode: state.target, skip });
});

refreshLink.addEventListener("click", async () => {
  poolInfoEl.textContent = "Refreshing…";
  const res = await chrome.runtime.sendMessage({ type: "REFRESH_POOL" });
  if (res.ok) {
    countries = res.countries;
    renderOptions();
    renderPoolInfo(Date.now());
  } else {
    poolInfoEl.textContent = `Refresh failed: ${res.error}`;
  }
});

optionsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.state) {
    state = changes.state.newValue;
    renderState();
  }
  // The list refreshes in the background after the popup opens from cache.
  if (changes.poolFetchedAt) init();
});

init();
