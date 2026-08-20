# CLAUDE.md — Project Rules for Cache Miss Fix

## Project overview

Chrome extension (Manifest V3) that repairs tabs whose navigation failed with a cache-layer
error after a session restore. Chrome restores non-active tabs from the HTTP cache;
Cloudflare-protected documents are sent with `Cache-Control: no-store`, so the restore load
fails with `ERR_CACHE_MISS`. The extension detects those failures and re-navigates the tabs,
staggered per host.

No build step, no bundler, no runtime dependencies. ES modules everywhere.

## Architecture

```
src/
├── background.js        # service worker: event wiring only
├── recovery.js          # RecoveryController: queue, pacing, backoff, persistence
├── cacheable-rules.js   # opt-in declarativeNetRequest header rewrite
├── settings.js          # settings + statistics, validated on read and write
├── host-match.js        # hostname/URL helpers
├── logger.js            # levelled logging: console + persisted ring buffer
├── constants.js         # every tunable, limit, key, error name
├── popup/               # toolbar popup
├── options/             # settings, statistics, log viewer
└── ui/                  # i18n + theme helpers, shared design tokens
```

## Hard rules

1. **No magic values.** Every number, string key, header name and error code goes in
   `src/constants.js` with a comment. This is not negotiable — the file exists for it.
2. **No user-facing text in code.** Use `chrome.i18n` with keys defined in **both**
   `_locales/en` and `_locales/de`. Never concatenate sentence fragments; use placeholders.
   Use `Intl` for numbers and dates. `npm run validate` enforces parity and usage.
3. **Register `chrome.*` listeners synchronously** at the top level of `background.js`.
   These events start the service worker; a listener added after an `await` misses the
   event that woke it.
4. **Never assume the service worker stayed alive.** Anything that must outlive a suspension
   goes into `chrome.storage.session` and is re-driven by the `chrome.alarms` watchdog.
5. **Test anything touching timing.** The per-host stagger and concurrency cap are what stop
   a repair from looking like a request burst to a protected origin. `tests/recovery.test.mjs`
   has a case per rule; add or update one.
6. **Both themes, always.** Extension pages take colours from the custom properties in
   `src/ui/shared.css`, which define light and dark palettes. Never hardcode a colour.
7. **Handle and log errors.** Wrap `chrome` calls; a failed state write or log write must
   never break a repair.

## Code style

- Two-space indent, single quotes, semicolons, trailing commas in multiline literals.
- `camelCase` functions and variables, `UPPER_SNAKE_CASE` constants, `#private` class fields.
- `async`/`await`, not `.then()` chains — except at event-listener boundaries, where the
  listener must stay synchronous and the promise is caught explicitly.
- Comments explain *why*, not *what*. The Chrome-specific reasons (restore semantics, worker
  lifetime, rate-limit avoidance) are the ones worth writing down.
- Dependency injection over module globals: `RecoveryController` takes its clock and
  collaborators as constructor arguments, which is what makes it testable.

## Commands

```bash
npm run check          # validate + test — run before every commit
npm test               # node:test suite (stubbed chrome, manual clock)
npm run validate       # manifest references, locale parity, message-key usage
npm run icons          # regenerate icons/*.png (committed; CI checks they match)

npm run install:docs   # docs dependencies
npm run dev            # docs preview
npm run build          # docs production build
```

## Testing approach

`tests/fake-chrome.mjs` provides a `chrome` stub (`storage.local`, `storage.session`,
`tabs.get`, `tabs.update`) and a manual clock whose timers fire only when a test advances
it. No browser, no real time. Retry timers return their promise from the callback so the
test clock can await a tick — `setTimeout` ignores return values, so production behaviour is
unchanged. Keep it that way.

## Documentation

Behaviour changes must be reflected in:

- `SPECIFICATION.md` — the tables of errors, limits, permissions and rules
- `docs/src/content/docs/getting-started/configuration.mdx` — any setting
- `docs/src/content/docs/guides/how-it-works.mdx` — any mechanic
- `README.md` — only if the summary or the constants table changes

Docs links use the full base path (`/chrome-cache-miss-fix/…`) because the site is served
from a GitHub Pages subpath.

## Things that look like bugs but are not

- `markBrowserStartup()` deliberately clears **no** state. `chrome.storage.session` is
  already empty in a new browser session, and restore failures can arrive *before*
  `chrome.runtime.onStartup` — wiping would drop tabs already queued.
- The manual retry still honours the per-host stagger, so a retry may not navigate
  immediately.
- `handleNavigationSuccess` marks tabs as "seen" for the preventive-reload heuristic, which
  is why it runs even when nothing was queued.
