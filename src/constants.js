/**
 * Every static value the extension relies on lives here — no magic numbers,
 * strings, URLs or limits inline anywhere else.
 */

export const EXTENSION_VERSION_STORAGE_KEY = 'installedVersion';

/** Keys used in chrome.storage.local (persistent) and .session (per browser run). */
export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  stats: 'stats',
  log: 'log',
  runtimeState: 'runtimeState',
  startupAt: 'startupAt',
});

export const LOG_LEVELS = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
});

export const LOG_LEVEL_NAMES = Object.freeze(Object.keys(LOG_LEVELS));
export const DEFAULT_LOG_LEVEL = 'info';
export const LOG_MAX_ENTRIES = 2000;
export const LOG_MESSAGE_MAX_LENGTH = 500;
export const LOG_PERSIST_DEBOUNCE_MS = 1000;
export const LOG_EXPORT_FILENAME = 'cache-miss-fix-log.txt';
export const LOG_EXPORT_MIME_TYPE = 'text/plain;charset=utf-8';

/**
 * Cache-layer navigation failures. These are exactly the errors Chrome raises
 * when a restored tab is served from the HTTP cache and the document was never
 * stored there (typical for Cloudflare-protected pages sent with `no-store`).
 */
export const CACHE_NAVIGATION_ERRORS = Object.freeze([
  'net::ERR_CACHE_MISS',
  'net::ERR_CACHE_READ_FAILURE',
  'net::ERR_CACHE_WRITE_FAILURE',
  'net::ERR_CACHE_OPERATION_NOT_SUPPORTED',
  'net::ERR_CACHE_OPEN_FAILURE',
  'net::ERR_CACHE_CREATE_FAILURE',
  'net::ERR_CACHE_RACE',
  'net::ERR_CACHE_CHECKSUM_READ_FAILURE',
  'net::ERR_CACHE_CHECKSUM_MISMATCH',
  'net::ERR_CACHE_LOCK_TIMEOUT',
  'net::ERR_CACHE_AUTH_FAILURE_AFTER_READ',
  'net::ERR_CACHE_ENTRY_NOT_SUITABLE',
  'net::ERR_CACHE_DOOM_FAILURE',
]);

/**
 * Transport failures that a retry can plausibly fix. Off by default: unlike a
 * cache miss, these can mean the network really is down, and retrying then just
 * burns requests against the origin.
 */
export const TRANSIENT_NETWORK_ERRORS = Object.freeze([
  'net::ERR_FAILED',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_HTTP2_PROTOCOL_ERROR',
  'net::ERR_QUIC_PROTOCOL_ERROR',
  'net::ERR_SSL_PROTOCOL_ERROR',
  'net::ERR_TIMED_OUT',
]);

/** Only these schemes can be re-navigated. */
export const RECOVERABLE_URL_SCHEMES = Object.freeze(['http:', 'https:']);

/** The frame id Chrome uses for a tab's main frame. */
export const MAIN_FRAME_ID = 0;

/* ---------------------------------------------------------------- scheduling */

/**
 * Minimum gap between two recovery navigations against the same origin. Firing
 * ten restored tabs at a Cloudflare-protected host at once tends to produce a
 * challenge or a rate limit, which is the problem we are trying to avoid.
 */
export const ORIGIN_STAGGER_MS_DEFAULT = 1500;
export const ORIGIN_STAGGER_MS_MIN = 0;
export const ORIGIN_STAGGER_MS_MAX = 30_000;

/** Retry budget per tab before giving up and leaving the error page in place. */
export const MAX_ATTEMPTS_DEFAULT = 3;
export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 10;

export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_MAX_MS = 30_000;

/** How many recovery navigations may be in flight across all origins. */
export const MAX_CONCURRENT_RECOVERIES = 3;

/** A recovery with no observed outcome within this window counts as failed. */
export const RECOVERY_TIMEOUT_MS = 45_000;

/** Guards against acting on stale queue entries after a long worker sleep. */
export const QUEUE_ENTRY_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Watchdog alarm. Service workers are torn down aggressively, so short-lived
 * setTimeout schedules can be lost; the alarm re-drives the queue from state
 * persisted in chrome.storage.session. 30s is the shortest period Chrome allows.
 */
export const WATCHDOG_ALARM_NAME = 'cache-miss-fix-watchdog';
export const WATCHDOG_ALARM_PERIOD_MINUTES = 0.5;

/** Window after browser start in which session restore is still plausible. */
export const STARTUP_WINDOW_MINUTES_DEFAULT = 5;
export const STARTUP_WINDOW_MINUTES_MIN = 1;
export const STARTUP_WINDOW_MINUTES_MAX = 60;

/* -------------------------------------------------------- preventive rewrite */

/**
 * Dynamic declarativeNetRequest rule ids are allocated from this base. Ids must
 * be stable per domain so a settings change can replace exactly its own rules.
 */
export const DNR_RULE_ID_BASE = 1000;
export const DNR_RULE_ID_MAX = 90_000;
export const DNR_RULE_PRIORITY = 1;
export const CACHEABLE_MAX_AGE_SECONDS_DEFAULT = 300;
export const CACHEABLE_MAX_AGE_SECONDS_MIN = 30;
export const CACHEABLE_MAX_AGE_SECONDS_MAX = 86_400;
export const CACHEABLE_RESOURCE_TYPES = Object.freeze(['main_frame']);
export const CACHEABLE_REMOVED_HEADERS = Object.freeze(['pragma', 'expires']);
export const CACHE_CONTROL_HEADER = 'cache-control';

/* --------------------------------------------------------------------- badge */

export const BADGE_BACKGROUND_COLOR = '#4f46e5';
export const BADGE_TEXT_COLOR = '#ffffff';
export const BADGE_MAX_COUNT = 99;

/* ------------------------------------------------------------------ messages */

/** Message types exchanged between the background worker and the UI pages. */
export const MESSAGE_TYPES = Object.freeze({
  getStatus: 'get-status',
  retryAll: 'retry-all',
  clearStats: 'clear-stats',
  clearLog: 'clear-log',
  syncRules: 'sync-rules',
});

/* ------------------------------------------------------------------ defaults */

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  logLevel: DEFAULT_LOG_LEVEL,
  maxAttempts: MAX_ATTEMPTS_DEFAULT,
  originStaggerMs: ORIGIN_STAGGER_MS_DEFAULT,
  recoverNetworkErrors: false,
  restrictToStartupWindow: false,
  startupWindowMinutes: STARTUP_WINDOW_MINUTES_DEFAULT,
  preemptiveReloadOnActivate: false,
  showBadge: true,
  /** Empty allowlist means "every host"; the denylist always wins. */
  hostAllowlist: Object.freeze([]),
  hostDenylist: Object.freeze([]),
  cacheable: Object.freeze({
    enabled: false,
    domains: Object.freeze([]),
    maxAgeSeconds: CACHEABLE_MAX_AGE_SECONDS_DEFAULT,
  }),
});

export const DEFAULT_STATS = Object.freeze({
  recovered: 0,
  failed: 0,
  byHost: Object.freeze({}),
  lastRecoveryAt: null,
});

/** Hosts seen failing this often are worth suggesting for preventive mode. */
export const SUGGESTION_MIN_RECOVERIES = 2;
export const SUGGESTION_MAX_ENTRIES = 10;

export const OPTIONS_PAGE_PATH = 'src/options/options.html';
export const THEME_STORAGE_KEY = 'theme';
export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const DEFAULT_THEME = 'system';
