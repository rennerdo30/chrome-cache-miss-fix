# Contributing to Cache Miss Fix

Thanks for taking a look. This is a small, dependency-free extension, so getting set up
takes about a minute.

## Getting started

### Prerequisites

- Chrome 116 or newer
- Node.js 22.12 or newer (for the tests, the validator, and the docs site)
- Git

### Set up

1. Fork the repository on GitHub.
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/chrome-cache-miss-fix.git
   cd chrome-cache-miss-fix
   ```

3. Load it in Chrome:
   - open `chrome://extensions`
   - enable **Developer mode**
   - **Load unpacked** → select the project folder

There is nothing to install for the extension itself — it has no runtime dependencies and no
build step.

## Development workflow

1. Create a branch:

   ```bash
   git checkout -b feature/your-change
   ```

2. Make the change, then run the checks:

   ```bash
   npm run check      # validator + tests
   ```

3. Reload the extension on `chrome://extensions` and try your repro.
4. Commit and open a pull request against `main`.

CI runs `npm run check` on every push and pull request, so a green local run is a good
predictor.

## Testing

```bash
npm test           # node:test suite
npm run validate   # manifest references, locale parity, message-key usage
```

The tests stub the `chrome` APIs and drive a manual clock (`tests/fake-chrome.mjs`), so no
browser is involved. Everything about timing — the per-host stagger, the concurrency cap,
the backoff, the attempt limit, the recovery timeout, resuming from
`chrome.storage.session` — is covered there.

**Please add a test for any change to timing or queue behaviour.** The pacing is what keeps
a repair from looking like a request burst to a protected site, and it is easy to break
without noticing. `tests/recovery.test.mjs` has a case for each rule; copy the closest one.

Anything that cannot be tested that way — the actual restore behaviour, a real Cloudflare
challenge — needs a manual note in the pull request describing what you did and what you saw.

### Manual repro for a restore failure

1. **Settings → On startup → Continue where you left off**
2. Open the same protected page in three or four tabs
3. Quit Chrome fully, reopen it, click through the tabs
4. Watch the service worker console (`chrome://extensions` → **Service worker**) with the
   log level set to **Debug**

## Code style

The conventions are not enforced by a linter, so please match what is there:

- **No magic values.** Every number, key, header name and error string belongs in
  `src/constants.js`, with a comment saying what it is for.
- **No user-facing text in code.** All strings go through `chrome.i18n`, defined in both
  `_locales/en/messages.json` and `_locales/de/messages.json`. Use placeholders rather than
  concatenating fragments, and `Intl` for numbers and dates. `npm run validate` fails on a
  key missing from a locale, defined but unused, or used but undefined.
- **Handle and log errors.** Wrap `chrome` calls; a failure to persist state or write a log
  entry must never break a repair.
- **Both themes.** Extension pages take their colours from the custom properties in
  `src/ui/shared.css`, which define a light and a dark palette. Do not hardcode a colour.
- **Register listeners synchronously** at the top level of `src/background.js` — those
  events start the service worker, and a late registration misses the event that woke it.
- Two-space indentation, single quotes, semicolons, `camelCase` for functions and variables,
  `UPPER_SNAKE_CASE` for constants.

## Adding a translation

1. Copy `_locales/en/messages.json` to `_locales/<code>/messages.json`.
2. Translate the `message` values, keeping keys and placeholder names identical.
3. Run `npm run validate` — it checks parity and placeholder names against English.

## Documentation

Docs live in `docs/` (Astro Starlight) and deploy to GitHub Pages from `main`.

```bash
npm run install:docs
npm run dev            # http://localhost:4321/chrome-cache-miss-fix
npm run build
```

If your change alters behaviour or adds a setting, update the matching page —
`getting-started/configuration` for settings, `guides/how-it-works` for mechanics — and
`SPECIFICATION.md`.

## Pull requests

Please include:

- what problem the change solves, and how you verified it
- the tests you added or the manual steps you ran
- for anything touching timing, why the new pacing is still safe for a protected origin

Keep commits focused; a small series that each pass `npm run check` is easier to review than
one large commit.

## Reporting bugs

Open an issue with:

- Chrome version and OS
- what the restore looked like — number of tabs, number of hosts
- the `ERR_…` code from the error page
- whether either preventive option was enabled
- an exported log (options page → **Export as file**), if you can

> An exported log contains hostnames and URLs of the pages that failed. Read it before
> attaching it to a public issue.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
