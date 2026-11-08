# Decision Log
Format per entry:
## YYYY-MM-DD - Decision title
- Decision:
- Context:
- Alternatives rejected:
- Consequences:

## 2026-11-08 - Extra proxy sources for thin countries (V2)
- Decision: Add HProxy (hproxy.com keyless JSON API, socks5 + country_code) and monosans/proxy-list (GitHub proxies.json, socks5 + GeoNames country) as fallback sources. Consulted only when the primary pool has <10 proxies for the requested country; merged after the primary pool, deduplicated by host:port, cached 10 minutes; each fetch capped at 3s and run via allSettled.
- Context: ProxyScrape alone leaves some countries too thin (and heavily mislabeled, e.g. NL). Both extras need no key/signup and carry a country label so candidates can be matched to the requested country before the measured check.
- Alternatives rejected: Plain ip:port text lists (TheSpeedX, monosans socks5.txt) - no country label, so they cannot be candidates for a specific country; proxmint/databay APIs (newer/less established, databay API needs sign-in for copy/download); merging extras unconditionally (would change thick-country behavior and waste the primary's ordering).
- Consequences: Thin-country Connect can wait up to ~3s for extras (parallel, capped); a failing source never breaks Connect. Country labels from extras are never trusted - the Cloudflare measured exit check remains the only acceptance test, so a mislabeled extra is rejected and named, exactly like a primary entry.

## 2026-11-08 - Auto-rotate on proxy navigation failures (V1)
- Decision: 2 main-frame failures in {ERR_PROXY_CONNECTION_FAILED, ERR_SOCKS_CONNECTION_FAILED, ERR_TIMED_OUT, ERR_CONNECTION_RESET, ERR_EMPTY_RESPONSE} within 60s while connected via a free proxy triggers the existing rotate (connectFree same country); max once per 30s; default-on options switch (`autoSwitch` in storage).
- Context: a proxy can pass the Cloudflare trace check and still fail real pages (seen with a Russian proxy).
- Alternatives rejected: Rotating on a single failure (page/CDN blips would thrash proxies); rotating to any country (would silently change geo); a new manifest permission (webRequest is already declared, none needed).
- Consequences: Failure timestamps and cooldown are stored so they survive service-worker restarts; sub-frame errors and non-listed errors (ERR_ABORTED) never count. Edge-specific (found by live E2E 2026-11-08): Edge throws `TypeError: No matching signature` for `onErrorOccurred.addListener(handler)` at startup, so registration tries the `{urls:["<all_urls>"]}` filter form first with a plain-form fallback, wrapped so it can never kill the worker.

## 2026-09-21 - Free public SOCKS5 proxies by default
- Decision: Use the free ProxyScrape list as the default source; own VPS is an optional "Custom servers" path.
- Context: User wants zero cost and no signup; the purpose is reading geo-restricted content, not privacy.
- Alternatives rejected: A paid VPS as the default (rejected by the user); commercial VPN APIs.
- Consequences: Slow and flaky; not private. The README warns against banking and logins.

## 2026-09-21 - Verify the measured exit country before accepting a proxy
- Decision: Accept a proxy only if its real exit IP geolocates to the country the user asked for.
- Context: Public lists mislabel countries heavily. Every NL entry tested actually exited elsewhere.
- Alternatives rejected: Trusting the list's country field.
- Consequences: NL connects fail, by design, instead of silently landing in the wrong country. This check must stay in `background.js`.

## 2026-09-21 - Don't use ipapi.co for IP verification
- Status: Superseded by "2026-09-25 - Verify exit country with Cloudflare /cdn-cgi/trace" (the ipapi.co finding still holds).
- Decision: Check exit IPs with ipwho.is / ifconfig.co / api.ipify.org (as used in `background.js`).
- Context: ipapi.co rate-limits to HTTP 429, which made every working proxy look dead.
- Alternatives rejected: ipapi.co.
- Consequences: Keep the current checker; test any replacement for rate limits.

## 2026-09-25 - Race proxies in parallel through a per-host PAC script
- Decision: Test up to 6 proxies at once. A PAC script routes six checker hostnames through six different proxies; the first right-country answer wins and the rest are aborted. 5s per round, up to 3 rounds, uptime order.
- Context: chrome.proxy is browser-wide, so the old code tested one proxy at a time, and a dead proxy cost up to 3 checkers x 9s. Measured worst case 28.6s (theoretical ~5 min).
- Alternatives rejected: Waiting for a whole batch then picking the fastest (measured slower than the old code: dead proxies hold every batch to the timeout). Ordering by ProxyScrape's own latency field (worse tail: 9.4s vs 4.4s). A 4s timeout (lost a country that 5s reached). Also checking a second, non-Cloudflare host per proxy for reachability: rejected because hosts blocked in some countries (e.g. Google in CN) would make the verdict depend on the slot again.
- Consequences: Relies on Chromium sending PAC-routed requests through different SOCKS5 proxies at once; confirmed in real headless Edge. During a race, other traffic goes DIRECT (or through the current proxy when rotating).

## 2026-09-25 - Verify exit country with Cloudflare /cdn-cgi/trace
- Decision: All six racing slots fetch `https://<host>/cdn-cgi/trace` on six Cloudflare hostnames (speed., developers., workers., radar., www.cloudflare.com, one.one.one.one) and read `ip=` / `loc=`.
- Context: With mixed checkers the verdict depended on the slot. Measured through 8 real proxies: ifconfig.co disagreed with the majority 4/8 times (German exits as AT/GB, a US exit as IR); api.db-ip.com failed 4/8 (quota errors); get.geojs.io 2/8 wrong. The Cloudflare hosts answered 7-8/8 and always matched the majority. The earlier E2E failure on DE was exactly this.
- Alternatives rejected: Keeping third-party geo APIs (ipwho.is, ipinfo.io, api.country.is, geojs, ifconfig.co, db-ip); ipapi.co (HTTP 429).
- Consequences: One geolocation source, the same one every Cloudflare-fronted site uses. No city in the result (the popup shows the country only). If Cloudflare changes /cdn-cgi/trace, all verification stops; `tests/e2e-edge.js` would show it.
