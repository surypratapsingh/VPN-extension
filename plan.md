# Plan — GeoSwitch

## Goal
A free Chrome/Edge MV3 extension that routes the browser through public SOCKS5 proxies, so you can read geo-restricted content as if you were in another country. No signup, no VPS, no cost.

## Scope
- In: country picker, live proxy list, connect with verified exit country, rotation, optional custom (own) SOCKS5 servers.
- Out: privacy/security use (banking, logins), streaming-service unblocking, paid infrastructure by default.

## Architecture / approach
- `manifest.json` (MV3; proxy, storage, webRequest, webRequestAuthProvider), `background.js` (service worker: fetches the list, races proxies, checks the exit country), `popup.*`, `options.*`.
- Proxy source: the free ProxyScrape API (about 500–1400 SOCKS5 proxies). Served from cache instantly; refreshed in the background after 10 minutes.
- Connect races up to 6 proxies at once: a PAC script routes six Cloudflare hostnames through six different proxies, each fetching `/cdn-cgi/trace`. The first answer from the requested country wins (so it is also the fastest). 5s per round, up to 3 rounds (18 proxies).
- A proxy is accepted only if it carries traffic and its measured exit country matches the one requested.
- Tests: `tests/background.test.js` (simulated browser, no network); `tests/e2e-*.js` (headless Edge, live proxies).
- `server-setup/setup.sh`: optional Dante SOCKS5 + ufw + fail2ban on an Ubuntu/Debian VPS for the "Custom servers" path.

## Milestones
- [x] MV3 extension with popup, options and background worker
- [x] Free proxy list + connect/rotate with measured exit-country check
- [x] Live test (2026-09-21): 24/42 proxies carried traffic; 9/10 countries reached a verified exit; NL fails (the list mislabels it)
- [x] Custom-server path + VPS setup script
- [x] Speed (2026-09-25): parallel racing, fastest-proxy pick, fail-fast probes, instant popup. Worst-case connect 28.6s -> 4.4s on the same proxies
- [x] Checker bug fixed (2026-09-25): per-slot third-party checkers misjudged proxies; all slots now use Cloudflare trace
- [x] Tests: simulated-browser suite (30 checks) + real-Edge E2E for connect and popup
- [ ] Put the folder under git
- [ ] Decide next improvements: auto-rotate when pages fail through the current proxy (seen with a Russian proxy); more proxy sources for thin countries
