# Cache Miss Fix

Chrome extension (Manifest V3) that repairs tabs which come back as `ERR_CACHE_MISS` after
Chrome restores a session — the broken duplicate tabs of a Cloudflare-protected site.

📖 **[Documentation](https://rennerdo30.github.io/chrome-cache-miss-fix/)**

## Why

With **“Continue where you left off”**, Chrome brings every tab back, but not in the same
way. The tab that was in the foreground gets a real network request; every other tab is
restored lazily, from the HTTP cache.

Pages behind Cloudflare are served with `Cache-Control: no-store`, so the document was never
written to that cache. There is nothing to restore from, and the navigation fails with
`net::ERR_CACHE_MISS`. That is the lopsided symptom you see when several tabs of one
protected site come back: exactly one works — the one that got the network load — and the
rest show an error page.

Cache Miss Fix notices those failures and re-navigates the affected tabs, paced so the site
never sees a burst of simultaneous requests.

## What it does

- Detects main-frame navigations that failed with a cache-layer error, via
  `chrome.webNavigation.onErrorOccurred`.
- Re-navigates the tab with `chrome.tabs.update` — an ordinary navigation, so it goes to the
  network instead of the cache.
- **Staggers recoveries per host** (1500 ms by default). This is the part that matters:
  reloading ten tabs of one protected origin at once is how you earn a managed challenge or
  a rate limit.
- Caps recoveries at three in flight across all hosts.
- Backs off exponentially (2 s, 4 s, 8 s … 30 s) and stops after a configurable number of
  attempts, leaving the error page rather than looping forever.
- Survives its own service worker being suspended: the queue lives in
  `chrome.storage.session` and is re-driven by a `chrome.alarms` watchdog.
- Defers while the browser is offline instead of burning attempts.
- Reports what it did — popup counters, per-host statistics, and a levelled log you can
  export.

Only `http:`/`https:` main-frame navigations are touched. Subframes, `chrome://` pages and
unrelated errors are ignored, and every skipped candidate is logged with a reason.

### Preventing it instead of repairing it

Two opt-in modes close the gap where you would otherwise see the error page for a moment:

| | Header rewrite | Preventive reload |
| --- | --- | --- |
| Error page ever shown | no | no |
| Extra network request | no | yes, one per restored tab |
| HTML cached on disk | yes | no |
| Can show stale content | yes, up to `max-age` | no |
| Needs host permission | yes | no |

The **header rewrite** sets `Cache-Control: private, max-age=300` on main-frame documents of
hosts you nominate, so the cache-first restore succeeds on its own. It writes those sites'
page HTML — including pages you are signed in to — into the on-disk cache, which is why it is
off by default, opt-in per host, and gated behind an explicit permission grant. See
[Preventive Mode](https://rennerdo30.github.io/chrome-cache-miss-fix/guides/preventive-mode/).

## Privacy

Nothing leaves your machine. There is no backend, no telemetry, and no network code — the
source contains no `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` call and no
external URL. There are **no content scripts**: the extension never runs code in a page,
reads page content, or touches a site's DOM.

`webNavigation` and `tabs` do mean it observes the URLs you navigate to — that is inherent to
noticing a failed navigation. Those URLs are used to re-navigate the tab and, at verbose log
levels, written to the local log. Statistics keep hostnames only.

The log holds the last 2000 entries in `chrome.storage.local` and can be exported; it
contains hostnames and URLs of pages that failed, so read an export before attaching it to a
public issue. Full detail:
[Privacy](https://rennerdo30.github.io/chrome-cache-miss-fix/guides/privacy/).

## Install

Not on the Chrome Web Store — load it unpacked:

1. `git clone https://github.com/rennerdo30/chrome-cache-miss-fix.git`
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder (the directory containing
   `manifest.json`).

Requires Chrome 116 or newer. There is no build step and no runtime dependency; Chrome only
reads the files referenced by `manifest.json`, so `docs/`, `tests/`, `tools/` and `.github/`
are ignored by the browser.

### Verify

Set **Settings → On startup → Continue where you left off**, open the same protected page in
three or four tabs, quit Chrome fully, reopen it, and click through the tabs. They repair
themselves one per host per 1500 ms, and the popup counts what it fixed. For a live trace,
open **Service worker** on `chrome://extensions` with the log level set to **Debug**.

## Usage

Nothing to operate — it works in the background once loaded.

The **popup** shows how many tabs are waiting, reloading or were given up on, the total
fixed, the on/off switch, and a button to retry the tabs it abandoned.

The **options page** (**Details → Extension options**) covers attempts and delays, host
allow/denylists, both preventive modes, statistics, and the log viewer. Settings save as you
change them.

## Configuration

Everything in the UI is documented in
[Configuration](https://rennerdo30.github.io/chrome-cache-miss-fix/getting-started/configuration/).
The values not exposed there are named constants in `src/constants.js`:

| Constant | Default | Purpose |
| --- | --- | --- |
| `ORIGIN_STAGGER_MS_DEFAULT` | `1500` | Minimum gap between recoveries of the same host. |
| `MAX_CONCURRENT_RECOVERIES` | `3` | Recoveries in flight across all hosts. |
| `MAX_ATTEMPTS_DEFAULT` | `3` | Recovery navigations before giving up on a tab. |
| `BACKOFF_BASE_MS` / `BACKOFF_FACTOR` / `BACKOFF_MAX_MS` | `2000` / `2` / `30000` | Retry backoff curve. |
| `RECOVERY_TIMEOUT_MS` | `45000` | A recovery with no observed outcome counts as failed. |
| `QUEUE_ENTRY_MAX_AGE_MS` | 10 min | Queue entries older than this are dropped. |
| `WATCHDOG_ALARM_PERIOD_MINUTES` | `0.5` | Alarm that resumes the queue after worker suspension. |
| `CACHE_NAVIGATION_ERRORS` | 13 errors | Cache-layer errors treated as recoverable. |
| `TRANSIENT_NETWORK_ERRORS` | 9 errors | Transport errors, only with the opt-in enabled. |
| `LOG_MAX_ENTRIES` | `2000` | Size of the persisted log ring buffer. |

## Tech stack

- **Chrome Extension Manifest V3** — service worker, two extension pages, no content
  scripts.
- **Vanilla JavaScript, HTML, CSS** — ES modules, no framework, no bundler, no build step,
  zero runtime dependencies.
- **Chrome APIs** — `webNavigation`, `tabs`, `storage` (local + session), `alarms`,
  `declarativeNetRequest`, `permissions`, `i18n`.
- **`node:test`** — the recovery logic runs against a stubbed `chrome` and a manual clock.
- **Docs** — Astro Starlight with the Galaxy theme, in `docs/`, deployed to GitHub Pages.

## Development

```bash
npm run check          # validator + tests
npm test               # node:test suite for the recovery logic
npm run validate       # manifest references, locale parity, message-key usage
npm run icons          # regenerate icons/*.png

npm run install:docs   # install docs dependencies
npm run dev            # local docs preview
npm run build          # production docs build into docs/dist
```

The tests stub the `chrome` APIs and drive a manual clock (`tests/fake-chrome.mjs`), so the
staggering, concurrency cap, backoff, attempt limit, recovery timeout and
resume-after-suspension behaviour are all verified without a browser. Please add a test for
any change to timing — the pacing is what keeps a repair from looking like a request burst to
a protected site.

Edit a file, click the reload icon on `chrome://extensions`, and re-run your repro.

```
manifest.json
src/
  background.js        service worker: wires Chrome events to the controller
  recovery.js          the queue: detection, pacing, backoff, give-up, persistence
  cacheable-rules.js   opt-in Cache-Control rewrite (declarativeNetRequest)
  settings.js          validated settings and statistics storage
  host-match.js        hostname/URL helpers
  logger.js            levelled logging: console + persisted ring buffer
  constants.js         every tunable, limit, key and error name
  popup/ options/ ui/  the two extension pages and their shared design tokens
_locales/{en,de}/      all user-facing text
tools/                 icon generator, static validator
tests/                 node:test suite with a chrome stub and manual clock
docs/                  Astro Starlight documentation site
```

For the queue's state machine, the pacing rules and what each skip reason means, see
[How It Works](https://rennerdo30.github.io/chrome-cache-miss-fix/guides/how-it-works/),
[Troubleshooting](https://rennerdo30.github.io/chrome-cache-miss-fix/guides/troubleshooting/)
and [SPECIFICATION.md](SPECIFICATION.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- A tab can only be repaired once Chrome has attempted to load it, so a lazily-restored tab
  is repaired when you first click it. The preventive options exist for that gap.
- If the site answers the fresh load with a Cloudflare challenge, you still see the
  challenge — this fixes the browser-side cache failure, not the challenge.
- Scroll position and in-page state of the failed tab are lost; the error page had already
  discarded them.

## License

MIT — see [LICENSE](LICENSE).
