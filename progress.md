# Progress Log
Newest entry first. Each entry: Done / In progress / Next / Blockers.

## 2026-11-08 - CI workflow + bug review (branch friend/ci)
- Done: `.github/workflows/ci.yml` runs `node --test tests/*.test.js` on push and pull_request (Node 22, checkout/setup-node v5). README Tests section names the CI and says the e2e scripts stay manual. Reviewed `background.js` and `options.js` for listener, storage and rotation/race bugs: none found that is clear enough to fix. Two narrow races noted, not changed: (1) a Disconnect clicked in the short window before auto-rotation's first `connecting` state is overwritten when `connectFree` applies its proxy; (2) two main-frame failures arriving at the same instant can read the same `autoFailures` list and lose one count.
- Tested: `node --test tests/*.test.js` - `# tests 3`, `# pass 3`, `# fail 0` (~16s). Workflow YAML parses with js-yaml; steps are checkout@v5, setup-node@v5, `node --test tests/*.test.js`.
- Could not do: CI itself (no push; the workflow has not run on GitHub yet).
- Unsure of: whether races (1) and (2) are worth a generation-token fix; both need a click or a same-millisecond error to show up.

## 2026-11-08 - V3 Docs + final summary
- Done: README.md documents auto-switch (what it does, same-country, 60s/2-failure/30s rules, popup note, how to turn off via Options), the two extra sources (HProxy + monosans/proxy-list, <10 thin-country merge, labels-are-hints), updated test count (54 -> 55). Banking/logins/privacy warning kept, unchanged. plan.md: both next-improvement items ticked with test evidence. decisions.md: entries for V1 (thresholds, no new permission, Edge signature), V2 (sources + why, 3s cap, fallback order), and the Edge fix.
- Tested: `node tests/background.test.js` ALL PASSED (55 checks); `node tests/e2e-popup.js` PASSED (Edge installed at default path; connect/rotate/refresh/disconnect, 0 JS errors).
- Could not do: none.
- Unsure of: none.

## Final summary (2026-11-08)
- V1 Done and committed (1fad008 + fix d30552d): auto-rotate on 2 main-frame proxy failures within 60s, same country, max once/30s, default-on Options switch, popup note, no new manifest permission. Tested: 55 simulated checks + live Edge E2E.
- V2 Done and committed (f86c68b): HProxy + monosans extra sources for countries with <10 primary proxies, dedupe by host:port, fallback order, 3s-capped parallel fetch, 10-min cache, measured exit check still the only truth. Tested: simulated dedupe/fallback/failing/empty/hanging/cache/thick-skip/mislabeled cases.
- V3 Done (this commit): README/plan/decisions/progress updated; banking/privacy warning intact.
- Commits (local only, never pushed): 1fad008 V1, f86c68b V2, d30552d Edge fix, plus this V3 docs commit. site/ never staged. No secrets, no new dependencies, no analytics/remote logging, no old test edited or deleted (only added checks + harness support for new list fetches).
- Blockers: none.

## 2026-11-08 - Fix: Edge onErrorOccurred registration (found by live E2E)
- Done: Real headless Edge would not load the extension with V1's `chrome.webRequest.onErrorOccurred.addListener(handler)` - Edge (Chromium 156) throws `TypeError: No matching signature` at service-worker startup, killing the worker (bisected: access alone is fine, addListener(handler) throws, addListener(handler, {urls:["<all_urls>"]}) succeeds). Registration now tries the filter form first, falls back to the plain form, never throws. No manifest change.
- Tested: `node tests/background.test.js` ALL PASSED (55 checks, incl. new filter check); `node tests/e2e-popup.js` PASSED (loaded, GB connect 2.7s, Try another 0.8s, Refresh, Disconnect, 0 JS errors).
- Could not do: none.
- Unsure of: whether Chrome MV3 accepts the filter form first (it should - filter is in Chrome's webRequest signature; the fallback covers it if not).

## 2026-11-08 - V2 More proxy sources for thin countries
- Done: Two extra keyless/signup-free sources: HProxy (`https://hproxy.com/api/proxy-list?format=json&protocol=socks5`, ip/port/country_code/uptime_pct) and monosans/proxy-list (`proxies.json` on GitHub, socks5 only, geolocation country + response timeout). When the primary ProxyScrape pool has <10 proxies for the requested country, extras are fetched in parallel (allSettled, 3s timeout each), merged after the primary pool in source order (fallback order), deduplicated by host:port, and cached 10 min (same TTL as primary, stored as extraPool). A failing/hanging/empty source falls back to the stale extra cache or the primary pool alone. Exit country is still only the measured Cloudflare check; extra labels are hints only (same IPv4/port/country-code validation as primary for PAC safety).
- Tested: `node tests/background.test.js` - ALL PASSED, 54 checks (44 prior + 10 new: thin merge, fallback order, dedupe, cache store/use with no fetch, failing source, empty sources, hang timeout ~3.1s, thick-country skip, mislabeled extra rejected).
- Could not do: none.
- Unsure of: none (live format of both sources verified 2026-11-08 via their public endpoints; no account/signup used).

## 2026-11-08 - V1 Auto-rotate when pages fail through the current proxy
- Done: background.js counts main-frame webRequest onErrorOccurred failures in {ERR_PROXY_CONNECTION_FAILED, ERR_SOCKS_CONNECTION_FAILED, ERR_TIMED_OUT, ERR_CONNECTION_RESET, ERR_EMPTY_RESPONSE} while connected via a free proxy; 2 within 60s rotates via existing connectFree to the next verified proxy for the SAME country, at most once per 30s (timestamps/cooldown in storage, survive SW restarts). Popup shows state.note `Switched proxy: the last one failed` (popup already renders note). Options page checkbox `Auto-switch when pages fail` (GET_SETTINGS/SAVE_SETTINGS, default on, storage `autoSwitch`). No new manifest permission (webRequest already declared).
- Tested: `node tests/background.test.js` - ALL PASSED, 44 checks (30 old + 14 new: threshold, inside/outside 60s window, 30s cooldown, same country, off switch, ERR_ABORTED/other/sub-frame excluded, settings round-trip). e2e-popup.js not run for V1 alone (live proxies; will run before final summary if Edge allows - Edge IS installed).
- Could not do: none.
- Unsure of: none.

## 2026-10-06 - Put on GitHub
- Done: `git init` (branch `main`), first commit, `.gitattributes` keeps `*.sh` LF. Pushed to the private repo https://github.com/surypratapsingh/VPN-extension.
- Next: user reloads the extension in chrome://extensions and tries it by hand. Possible: auto-rotate when pages fail through the proxy.
- Blockers: none.

## 2026-09-25 - Speed: parallel racing, and a checker bug found by real-browser testing
- Done: Connect now races 6 proxies at once through a PAC script (one Cloudflare trace hostname per proxy) and keeps the first right-country answer, i.e. the fastest. Probes fail fast (5s, no retries through other checkers). Popup opens from cache and refreshes the list in the background; shows race progress and the proxy's latency. "Try another" keeps browsing on the current proxy while racing and stays put if nothing better turns up. Fixed: a connect error could leave the popup stuck on "Connecting…"; the two-line status rendered as one line.
- Measured: on the same 148 proxies / 14 countries, worst-case connect 28.6s -> 4.4s, p90 6.6s -> 1.7s. Real headless Edge with the extension loaded: DE, FR, US, GB, JP, NL all connected in 0.8-1.7s, a normal tab confirmed each exit country, Wikipedia loaded in 1.2-2.4s.
- Bug found on the way: with six different third-party checkers, a proxy's verdict depended on its slot. Through real proxies ifconfig.co placed German exits in AT/GB and api.db-ip.com returned quota errors, so DE failed while 3 working DE proxies were in the list. All six slots now use Cloudflare's /cdn-cgi/trace.
- State: `node tests/background.test.js` 30/30 (also run against deliberately broken copies to confirm it catches them); `node tests/e2e-popup.js` passes 3/3 with zero JS errors. Not yet tried by hand in the user's own Chrome.
- Next: user reloads the extension in chrome://extensions and tries it. Then `git init` + first commit (not done: user hasn't asked). Possible: auto-rotate when pages fail through the proxy (a Russian proxy passed the check but wouldn't load Wikipedia).
- Blockers: none. Node is at `C:\Program Files\nodejs\node.exe` but not on the agent shell PATH; call it by full path.

## 2026-09-24 - Project memory files added
- Done: plan.md, progress.md and decisions.md written from the README, the code and earlier session notes.
- State: working as of 2026-09-21. Load unpacked from this folder in chrome://extensions.
- Next: `git init` and a first commit. Then optionally add a second free proxy source to cover countries the list mislabels (NL).
- Blockers: none. Free proxies are flaky by nature.

## 2026-09-21 - Built and tested
- Done: extension, free-proxy connect logic with exit-country verification, rotation, custom servers, VPS setup script, README with measured results.
