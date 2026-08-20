# Cache Miss Fix — Specification

## Overview

Chrome extension (Manifest V3) that repairs tabs whose navigation failed with a cache-layer
error after a session restore, and can optionally prevent the failure altogether.

Chrome restores the previously active tab with a network request and every other tab from
the HTTP cache. A document served with `Cache-Control: no-store` — the norm for
Cloudflare-protected pages — was never written to that cache, so the restore load fails with
`net::ERR_CACHE_MISS`. The extension detects those failures and re-navigates the affected
tabs, paced per host so the origin does not see a burst.

## Operating modes

| Mode | Default | Description |
| --- | --- | --- |
| **Reactive repair** | on | Detects a failed navigation and re-navigates the tab. No host permissions required. |
| **Preventive reload** | off | On first activation of an unloaded restored tab of a known problem host, navigates immediately instead of letting Chrome try the cache. |
| **Header rewrite** | off | Sets `Cache-Control: private, max-age=N` on main-frame documents of nominated hosts, so the cache-first restore succeeds. Requires host permission per host. |
| **Disabled** | — | Master switch off; no detection, no navigation, no rules. |

## Detection

| Condition | Requirement |
| --- | --- |
| Event | `chrome.webNavigation.onErrorOccurred` |
| Frame | main frame only (`frameId === 0`) |
| Scheme | `http:` or `https:` |
| Error | member of `CACHE_NAVIGATION_ERRORS`, or of `TRANSIENT_NETWORK_ERRORS` when "also retry connection errors" is enabled |
| Host | passes the denylist, and the allowlist when non-empty |
| Time | inside the session-restore window, when that restriction is enabled |

### Recovered errors

`ERR_CACHE_MISS`, `ERR_CACHE_READ_FAILURE`, `ERR_CACHE_WRITE_FAILURE`,
`ERR_CACHE_OPERATION_NOT_SUPPORTED`, `ERR_CACHE_OPEN_FAILURE`, `ERR_CACHE_CREATE_FAILURE`,
`ERR_CACHE_RACE`, `ERR_CACHE_CHECKSUM_READ_FAILURE`, `ERR_CACHE_CHECKSUM_MISMATCH`,
`ERR_CACHE_LOCK_TIMEOUT`, `ERR_CACHE_AUTH_FAILURE_AFTER_READ`,
`ERR_CACHE_ENTRY_NOT_SUITABLE`, `ERR_CACHE_DOOM_FAILURE`.

Opt-in transport errors: `ERR_FAILED`, `ERR_CONNECTION_CLOSED`, `ERR_CONNECTION_RESET`,
`ERR_CONNECTION_ABORTED`, `ERR_EMPTY_RESPONSE`, `ERR_HTTP2_PROTOCOL_ERROR`,
`ERR_QUIC_PROTOCOL_ERROR`, `ERR_SSL_PROTOCOL_ERROR`, `ERR_TIMED_OUT`.

### Skip reasons

Every rejected candidate is logged with one of: `extension-disabled`, `not-main-frame`,
`unsupported-scheme`, `error-not-recoverable`, `host-denylisted`, `host-not-allowlisted`,
`outside-startup-window`, `attempts-exhausted`.

## Recovery

Recovery is a fresh navigation to the same URL via `chrome.tabs.update(tabId, { url })`,
which goes to the network rather than the cache.

| Control | Default | Range | Purpose |
| --- | --- | --- | --- |
| Per-host stagger | 1500 ms | 0–30000 | One recovery navigation per host per interval; prevents a request burst against a protected origin. |
| Global concurrency | 3 | constant | Recoveries in flight across all hosts. |
| Attempts per tab | 3 | 1–10 | Recovery navigations before the error page is left in place. |
| Backoff | 2 s → 30 s | constants | `min(30000, 2000 × 2^(attempts−1))` per tab. |
| Recovery timeout | 45 s | constant | No observed outcome counts as a failure. |
| Queue entry max age | 10 min | constant | Stale entries are dropped. |
| Offline | — | — | Nothing is issued while `navigator.onLine` is false. |

### Outcomes

| Signal | Result |
| --- | --- |
| `webNavigation.onCompleted` for the tab | recorded as recovered, per host |
| the same error again | attempt incremented, re-queued with backoff, or given up |
| no signal within the timeout | re-queued with backoff, or given up |
| `tabs.onRemoved` | all state for the tab dropped |
| give-up | listed in the popup, retryable manually |

## Persistence and lifecycle

| Concern | Mechanism |
| --- | --- |
| Queue, in-flight set, per-host gates, attempt counts | `chrome.storage.session`, re-read on every worker start |
| Resuming after worker suspension | `chrome.alarms` watchdog, period 30 s, calls `tick()` |
| Session-restore window | `chrome.runtime.onStartup` timestamp; no state is cleared, because failures can precede the event |
| Settings, statistics, log, theme | `chrome.storage.local` |
| Listener registration | synchronous, top level of the service worker |

## Header rewrite rules

| Property | Value |
| --- | --- |
| API | `chrome.declarativeNetRequest` dynamic rules |
| Rule ids | allocated from `DNR_RULE_ID_BASE` (1000), one per host |
| Condition | `requestDomains: [host]`, `resourceTypes: ["main_frame"]` |
| Action | `cache-control` → `set` `private, max-age=N`; `pragma`, `expires` → `remove` |
| `max-age` | 300 s default, 30–86400 |
| Precondition | host permission granted for that host; ungranted hosts are reported, not silently skipped |

## Permissions

| Permission | Purpose |
| --- | --- |
| `webNavigation` | Observe navigation failures and their error codes |
| `tabs` | Read a tab's URL, re-navigate it |
| `storage` | Settings, statistics, log, per-session queue |
| `alarms` | Watchdog that resumes the queue after worker suspension |
| `declarativeNetRequestWithHostAccess` | The opt-in header rewrite |
| `optional_host_permissions: *://*/*` | Requested at runtime, per host, only for the header rewrite |

No content scripts. No `host_permissions` in the manifest. No network requests originated by
the extension.

## User interface

| Surface | Contents |
| --- | --- |
| Popup | Enabled/paused badge, master switch, counters (waiting, reloading, gave up, fixed), last fix, list of abandoned hosts, manual retry, link to settings |
| Options | General, recovery behaviour, host lists, preventive mode with permission grant and suggestions, statistics, log viewer with level filter and file export |

Localisation: English and German, all strings via `chrome.i18n`, `Intl` for numbers and
dates. Themes: light and dark, following the system preference by default.

## Logging

Levels `error`, `warn`, `info`, `debug`, `trace`. Output goes to the service worker console
and to a ring buffer of the last 2000 entries in `chrome.storage.local`, exportable as a
text file. Log entries include hostnames and URLs of failed navigations.

## Technical details

- **Manifest version**: 3
- **Minimum Chrome**: 116
- **Modules**: ES modules in the service worker (`"type": "module"`) and in extension pages
- **Dependencies**: none at runtime; the documentation site is the only `node_modules` consumer
- **Build step**: none

## Browser support

- ✅ Chrome 116+ (primary)
- ✅ Edge, Brave, and other Chromium browsers with Manifest V3 and `chrome.storage.session`
- ⚠️ Firefox — needs manifest adjustments; `declarativeNetRequest` response-header
  modification differs
- ❌ Safari — `declarativeNetRequest` `modifyHeaders` support is incomplete
