// Real end-to-end: headless Edge (throwaway profile) + this unpacked extension + live free proxies.
// This one connect/rotate for each country, checked from a normal tab. Uses the network. Run: node tests/e2e-edge.js [DE,FR,US]
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
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
  return { send, evaluate, close: () => ws.close() };
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

    console.log(`Before connecting, a normal tab sees: ${await tabCountry()}`);
    await bg.evaluate("chrome.storage.local.clear()");

    const t0 = Date.now();
    const countries = await bg.evaluate("getCountries().then(c => c.length)");
    console.log(`Proxy list loaded: ${countries} countries (${Date.now() - t0}ms)\n`);

    for (const cc of COUNTRIES) {
      const r = await bg.evaluate(`(async () => {
        const t0 = performance.now();
        await connectFree(${JSON.stringify(cc)});
        const { state } = await chrome.storage.local.get("state");
        const cfg = await chrome.proxy.settings.get({});
        return { ms: Math.round(performance.now() - t0), state, mode: cfg.value.mode, control: cfg.levelOfControl };
      })()`);
      const s = r.state;
      if (s.status !== "connected") {
        console.log(`[${cc}] NOT connected after ${(r.ms / 1000).toFixed(1)}s — ${s.lastError}`);
        continue;
      }
      console.log(`[${cc}] connected in ${(r.ms / 1000).toFixed(1)}s via ${s.proxy.host}:${s.proxy.port} (probe ${s.latencyMs}ms, mode ${r.mode}, ${r.control})`);
      console.log(`       extension says exit: ${s.info.ip} ${s.info.countryCode} ${s.info.city}`);
      console.log(`       a normal tab sees:   ${await tabCountry()}`);
      const wiki = await browse("https://www.wikipedia.org/");
      console.log(`       wikipedia.org loaded in a tab: ${(wiki.ms / 1000).toFixed(1)}s (${wiki.text.includes("Wikipedia") ? "rendered" : "did NOT render"})`);

      const rot = await bg.evaluate(`(async () => {
        const before = (await chrome.storage.local.get("state")).state;
        const t0 = performance.now();
        await connectFree(${JSON.stringify(cc)}, before.tried);
        const { state } = await chrome.storage.local.get("state");
        return { ms: Math.round(performance.now() - t0), from: before.proxy.host, state };
      })()`);
      const rs = rot.state;
      console.log(`       "Try another": ${(rot.ms / 1000).toFixed(1)}s -> ${rs.status} via ${rs.proxy?.host} (${rs.info?.countryCode}, probe ${rs.latencyMs}ms)${rs.note ? ` — ${rs.note}` : ""}`);
      await bg.evaluate("disconnect()");
    }

    console.log(`\nAfter disconnect, a normal tab sees: ${await tabCountry()}`);
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
