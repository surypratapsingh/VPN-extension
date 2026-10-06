# GeoSwitch — Free Geo-Switching Browser Extension

A Chrome/Edge (Manifest V3) extension that routes your browser through free
public SOCKS5 proxies so you can browse as if you were in another country.

**Fully free — no signup, no credit card, no VPS.** It pulls a live list of
public SOCKS5 proxies from ProxyScrape's free API, races several in your
chosen country at once, and keeps the fastest one that verifiably exits there.

## Install

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select `C:\Users\surya\Documents\vpn-extension`

No configuration needed. Open the popup, pick a country, click **Connect**.
After updating the files, click the reload icon on the extension's card.

## How it works

1. The popup opens instantly from a cached list of ~500–1400 live SOCKS5
   proxies grouped by country; a list older than 10 minutes refreshes in the
   background (**Refresh list** forces it).
2. **Connect** races up to 6 proxies at the same time. A PAC script sends
   each of six Cloudflare hostnames through a different proxy, and each one
   asks Cloudflare's `/cdn-cgi/trace` what IP and country it sees.
3. The first proxy to answer from the right country wins. All probes start
   together, so that proxy is also the lowest-latency one. Proxies that are
   dead, mislabeled or return a block page are skipped. Each round gives up
   after 5s; at most 3 rounds (18 proxies).
4. **Try another proxy** re-races the rest. Your browsing stays on the
   current proxy while it does that, and if nothing better turns up you
   stay where you were.

## Measured results (2026-09-25)

**Connect speed**, replaying the old and new logic on the same 148 real
proxies across 14 countries:

| | Old (one at a time) | New (race 6) |
|---|---|---|
| Median | 1.1s | 1.0s |
| 90th percentile | 6.6s | 1.7s |
| Worst | 28.6s | 4.4s |

Bangladesh went from 28.6s to 1.4s. For China, the proxy it picked went
from 6.3s latency to 0.66s, which also makes browsing faster.

**In a real browser** (the extension loaded in headless Edge, live proxies):

| Country | Connected in | Exit seen by a normal tab | wikipedia.org load |
|---|---|---|---|
| DE | 1.0s | Frankfurt | 1.6s |
| FR | 1.2s | Marseille | 1.4s |
| US | 1.7s | New York City | 2.2s |
| GB | 1.0s | London | 1.7s |
| JP | 0.8s | Tokyo | 1.9s |
| NL | 1.1s | Meppel | 1.2s |

"Try another proxy" took 0.9–2.4s (one case: 11.7s). After Disconnect the
tab saw the real IP again.

The Netherlands used to fail every time. Most NL entries in the public list
are still mislabeled, but genuine NL exits do show up. If none are
available, the extension refuses and names the countries the proxies really
exit from, rather than silently putting you in the wrong country.

## Limitations — read this

- **Not private.** These are servers run by strangers who can see and log
  your traffic, and tamper with anything not sent over HTTPS. Do **not**
  use this for banking, email, or logging into important accounts. It is
  for reading geo-restricted content.
- **Flaky by nature.** Free proxies die constantly. If pages stop loading,
  click **Try another proxy**.
- **A proxy can pass the check and still block some sites.** One Russian
  proxy reached Cloudflare but would not load Wikipedia. Sites blocked in a
  country are usually blocked through that country's proxies too.
- **Shared bandwidth.** The fastest proxy is picked, but they are shared.
- **Often blocked.** Netflix, BBC iPlayer and similar actively block known
  public proxy IPs. News sites and ordinary websites generally work.

For something fast and trustworthy, **Custom servers** still supports your
own private SOCKS5 server; `server-setup/setup.sh` provisions one on any
Ubuntu/Debian VPS. That is the paid-but-good path.

## Tests

```bash
node tests/background.test.js
```

Runs the real `background.js` against a simulated browser whose requests
follow the PAC script the extension generates (30 checks, ~7s, no network).

```bash
node tests/e2e-popup.js
```

Loads the extension into a headless Edge with a throwaway profile, clicks
the popup's buttons against live proxies, and reports any JavaScript errors.
`node tests/e2e-edge.js DE,FR,US` checks each country's exit from a normal
tab. Both need the network and Edge at its default install path (or set
`EDGE`).

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 config and permissions |
| `background.js` | Proxy list, parallel race, verification, rotation, proxy auth |
| `popup.html/js` | Country picker, connect/disconnect/rotate, live status and latency |
| `options.html/js` | Optional: your own private SOCKS5 servers |
| `server-setup/setup.sh` | Provisions a private SOCKS5 proxy on your VPS |
| `tests/` | Simulated-browser tests and real-Edge end-to-end tests |

No icon files yet — Chrome shows a placeholder until you add
`icons/16.png`, `48.png`, `128.png` and reference them in `manifest.json`.
