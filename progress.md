# Progress Log
Newest entry first. Each entry: Done / In progress / Next / Blockers.

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
