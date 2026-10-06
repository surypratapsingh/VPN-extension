// Real end-to-end: headless Edge (throwaway profile) + this unpacked extension + live free proxies.
// This one clicks the real popup's buttons. Uses the network. Run: node tests/e2e-popup.js [DE,FR,US]
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXT = path.resolve(__dirname, "..");
const PROFILE = path.join(require("os").tmpdir(), "edge-e2e-profile");
const PORT = 9333;
const COUNTRIES = (process.argv[2] || "DE,FR,US").split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method) events.push(msg);
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const send = async (method, params = {}) => {
    await ready;
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method, params }));
    const msg = await new Promise((r) => waiting.set(myId, r));
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, events, close: () => ws.close() };
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const edge = spawn(EDGE, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run", "--no-default-browser-check", "about:blank"
  ], { stdio: "ignore" });

  let exitCode = 0;
  try {
    let sw, page;
    for (let i = 0; i < 60 && !(sw && page); i++) {
      await sleep(500);
      const ts = await targets();
      sw = ts.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"));
      // Skip Edge's own first-run pages (e.g. edge://sync-confirmation-dialog).
      page = ts.find((t) => t.type === "page" && t.url === "about:blank");
    }
    if (!sw) throw new Error("extension service worker never appeared — Edge refused --load-extension?");
    console.log(`Extension loaded in headless Edge: ${sw.url.split("/")[2]}`);

    const bg = cdp(sw.webSocketDebuggerUrl);
    // The worker target shows up before its script has run; wait for the extension APIs.
    for (let i = 0; i < 50; i++) {
      if (await bg.evaluate('typeof chrome === "object" && typeof connectFree === "function"').catch(() => false)) break;
      await sleep(200);
    }
    const tab = cdp(page.webSocketDebuggerUrl);
    await tab.send("Page.enable");

    const browse = async (url) => {
      const t0 = Date.now();
      await tab.send("Page.navigate", { url });
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        const s = await tab.evaluate("document.readyState + '|' + location.href").catch(() => "");
        if (s.startsWith("complete|") && !s.includes("about:blank")) break;
      }
      return { ms: Date.now() - t0, text: await tab.evaluate("document.body ? document.body.innerText : ''") };
    };
    const tabCountry = async () => {
      const { text } = await browse(`https://ipwho.is/?t=${Date.now()}`);
      try { const d = JSON.parse(text); return `${d.ip} ${d.country_code} ${d.city}`; } catch { return `unparseable: ${text.slice(0, 80)}`; }
    };

    await bg.evaluate("chrome.storage.local.clear()");
    const id = sw.url.split("/")[2];
    await tab.send("Runtime.enable");
    await tab.send("Page.navigate", { url: `chrome-extension://${id}/popup.html` });
    const ui = () => tab.evaluate(`({ pool: document.getElementById("pool-info").textContent,
      options: [...document.querySelectorAll("#server-select option")].length,
      button: document.getElementById("connect-btn").textContent,
      rotateVisible: !document.getElementById("rotate-btn").hidden,
      status: document.getElementById("status").textContent,
      detail: document.getElementById("detail").innerText })`);
    const waitFor = async (pred, label, ms = 30000) => {
      const t0 = Date.now(); const seen = new Set();
      while (Date.now() - t0 < ms) {
        const u = await ui().catch(() => null);
        if (u && u.status === "Connecting…") seen.add(u.detail);
        if (u && pred(u)) return { u, ms: Date.now() - t0, seen: [...seen] };
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await ui())}`);
    };
    const opened = await waitFor((u) => u.options > 1, "country list");
    console.log(`Popup opened; list: "${opened.u.pool}" (${opened.u.options} countries in dropdown)`);

    await tab.evaluate(`(() => { const s = document.getElementById("server-select"); s.value = "free:GB"; })()`);
    await tab.evaluate(`document.getElementById("connect-btn").click()`);
    const c = await waitFor((u) => u.status === "Connected", "connect");
    console.log(`Clicked Connect (GB) -> Connected in ${(c.ms / 1000).toFixed(1)}s`);
    console.log(`  progress shown while connecting: ${JSON.stringify(c.seen)}`);
    console.log(`  status panel: ${JSON.stringify(c.u.detail)}`);
    console.log(`  button now: "${c.u.button}", Try another visible: ${c.u.rotateVisible}`);

    const firstDetail = c.u.detail;
    await tab.evaluate(`document.getElementById("rotate-btn").click()`);
    await sleep(300);
    const r = await waitFor((u) => u.status === "Connected" && u.detail !== firstDetail, "rotate");
    console.log(`Clicked Try another -> ${(r.ms / 1000).toFixed(1)}s, now: ${JSON.stringify(r.u.detail)}`);

    await tab.evaluate(`document.getElementById("refresh-link").click()`);
    const f = await waitFor((u) => /updated 0m ago/.test(u.pool), "refresh");
    console.log(`Clicked Refresh list -> "${f.u.pool}"`);

    await tab.evaluate(`document.getElementById("connect-btn").click()`);
    const d = await waitFor((u) => u.status === "Not connected", "disconnect");
    console.log(`Clicked Disconnect -> "${d.u.status}", button "${d.u.button}", Try another visible: ${d.u.rotateVisible}`);

    const errors = tab.events.filter((e) => e.method === "Runtime.exceptionThrown" ||
      (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"));
    console.log(`JavaScript errors in the popup: ${errors.length}${errors.length ? " -> " + JSON.stringify(errors.map((e) => e.params.exceptionDetails?.exception?.description || e.params.args?.[0]?.value)) : ""}`);
    bg.close();
    tab.close();
  } catch (err) {
    console.log(`E2E ERROR: ${err.message}`);
    exitCode = 1;
  } finally {
    // msedge.exe hands off to child processes, so kill everything launched with this profile.
    spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-e2e-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"]);
    await sleep(1500);
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  process.exit(exitCode);
})();
