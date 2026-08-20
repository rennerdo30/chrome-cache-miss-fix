/**
 * Detects failed tab navigations and re-drives them as real network loads.
 *
 * Why this exists: when Chrome restores a session it loads non-active tabs from
 * the HTTP cache. A Cloudflare-protected document is usually sent with
 * `Cache-Control: no-store`, so nothing was ever cached and the restore load
 * fails with net::ERR_CACHE_MISS. Only the foreground tab gets a real network
 * load, which is why exactly one tab of a duplicated page comes back fine.
 *
 * The recovery is deliberately staggered per host: firing ten restored tabs at a
 * Cloudflare-protected origin simultaneously invites a challenge or a rate limit.
 *
 * All timers are backed by state in chrome.storage.session and a watchdog alarm,
 * because the service worker can be torn down between the error and the retry.
 */

import {
  BACKOFF_BASE_MS,
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  CACHE_NAVIGATION_ERRORS,
  MAIN_FRAME_ID,
  MAX_CONCURRENT_RECOVERIES,
  QUEUE_ENTRY_MAX_AGE_MS,
  RECOVERY_TIMEOUT_MS,
  STORAGE_KEYS,
  TRANSIENT_NETWORK_ERRORS,
} from './constants.js';
import { hostMatchesAnyPattern, parseRecoverableUrl } from './host-match.js';

const CACHE_ERROR_SET = new Set(CACHE_NAVIGATION_ERRORS);
const TRANSIENT_ERROR_SET = new Set(TRANSIENT_NETWORK_ERRORS);

/** Reasons a candidate navigation is not recovered, for logging and tests. */
export const SKIP_REASONS = Object.freeze({
  disabled: 'extension-disabled',
  subframe: 'not-main-frame',
  scheme: 'unsupported-scheme',
  errorNotRecoverable: 'error-not-recoverable',
  denylisted: 'host-denylisted',
  notAllowlisted: 'host-not-allowlisted',
  outsideStartupWindow: 'outside-startup-window',
  attemptsExhausted: 'attempts-exhausted',
});

function emptyState() {
  return {
    queue: {},
    inFlight: {},
    failed: {},
    hostNextAllowedAt: {},
    seenTabIds: [],
    startupAt: null,
  };
}

export function backoffDelayMs(attempts) {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempts - 1));
}

export class RecoveryController {
  #logger;
  #getSettings;
  #recordOutcome;
  #onStateChanged;
  #now;
  #setTimer;
  #clearTimer;
  #isOnline;

  #state = emptyState();
  #seenTabIds = new Set();
  #timerId = null;
  #ready = null;

  constructor({
    logger,
    getSettings,
    recordOutcome,
    onStateChanged = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  }) {
    this.#logger = logger;
    this.#getSettings = getSettings;
    this.#recordOutcome = recordOutcome;
    this.#onStateChanged = onStateChanged;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#isOnline = isOnline;
  }

  /** Idempotent; every event handler awaits this before touching state. */
  ready() {
    if (!this.#ready) this.#ready = this.#restoreState();
    return this.#ready;
  }

  async #restoreState() {
    try {
      const stored = await chrome.storage.session.get(STORAGE_KEYS.runtimeState);
      const raw = stored?.[STORAGE_KEYS.runtimeState];
      if (raw && typeof raw === 'object') {
        this.#state = { ...emptyState(), ...raw };
        this.#seenTabIds = new Set(
          Array.isArray(raw.seenTabIds) ? raw.seenTabIds : [],
        );
        this.#logger.debug('runtime state restored', {
          queued: Object.keys(this.#state.queue).length,
          inFlight: Object.keys(this.#state.inFlight).length,
        });
      }
    } catch (error) {
      this.#logger.warn('could not restore runtime state', error?.message ?? error);
      this.#state = emptyState();
    }
  }

  async #persistState() {
    this.#state.seenTabIds = [...this.#seenTabIds];
    try {
      await chrome.storage.session.set({ [STORAGE_KEYS.runtimeState]: this.#state });
    } catch (error) {
      this.#logger.warn('could not persist runtime state', error?.message ?? error);
    }
  }

  /**
   * Called from chrome.runtime.onStartup — marks the session-restore window.
   *
   * Nothing is cleared here: chrome.storage.session starts empty in a new
   * browser session anyway, and the first restore failures can arrive before
   * onStartup does, so wiping state would drop tabs we already queued.
   */
  async markBrowserStartup() {
    await this.ready();
    this.#state.startupAt = this.#now();
    await this.#persistState();
    this.#logger.info('browser start observed; session restore window open');
  }

  get startupAt() {
    return this.#state.startupAt;
  }

  snapshot() {
    return {
      queued: Object.values(this.#state.queue).length,
      inFlight: Object.values(this.#state.inFlight).length,
      failed: Object.values(this.#state.failed).map((entry) => ({
        tabId: entry.tabId,
        url: entry.url,
        host: entry.host,
        error: entry.error,
      })),
      startupAt: this.#state.startupAt,
    };
  }

  #isRecoverableError(error, settings) {
    if (CACHE_ERROR_SET.has(error)) return true;
    return settings.recoverNetworkErrors && TRANSIENT_ERROR_SET.has(error);
  }

  #withinStartupWindow(settings) {
    if (this.#state.startupAt === null) return false;
    const windowMs = settings.startupWindowMinutes * 60 * 1000;
    return this.#now() - this.#state.startupAt <= windowMs;
  }

  /** Applies the user's host filters. Returns a skip reason or null. */
  #hostSkipReason(host, settings) {
    if (hostMatchesAnyPattern(host, settings.hostDenylist)) return SKIP_REASONS.denylisted;
    if (settings.hostAllowlist.length > 0
      && !hostMatchesAnyPattern(host, settings.hostAllowlist)) {
      return SKIP_REASONS.notAllowlisted;
    }
    return null;
  }

  /**
   * Entry point for chrome.webNavigation.onErrorOccurred.
   * Returns the skip reason when nothing was queued (used by the tests).
   */
  async handleNavigationError(details) {
    await this.ready();
    const settings = await this.#getSettings();

    if (!settings.enabled) return SKIP_REASONS.disabled;
    if (details.frameId !== MAIN_FRAME_ID) return SKIP_REASONS.subframe;

    const parsed = parseRecoverableUrl(details.url);
    if (!parsed) return SKIP_REASONS.scheme;

    if (!this.#isRecoverableError(details.error, settings)) {
      this.#logger.trace('ignoring navigation error', {
        error: details.error, url: details.url,
      });
      return SKIP_REASONS.errorNotRecoverable;
    }

    const host = parsed.hostname;
    const hostSkip = this.#hostSkipReason(host, settings);
    if (hostSkip) {
      this.#logger.debug('host filtered out', { host, reason: hostSkip });
      return hostSkip;
    }

    if (settings.restrictToStartupWindow && !this.#withinStartupWindow(settings)) {
      this.#logger.debug('outside session-restore window', { host });
      return SKIP_REASONS.outsideStartupWindow;
    }

    const tabId = details.tabId;
    const inFlight = this.#state.inFlight[tabId];
    let attempts = 0;

    if (inFlight && inFlight.url === details.url) {
      // Our own recovery navigation just failed the same way.
      attempts = inFlight.attempts;
      delete this.#state.inFlight[tabId];
      this.#logger.warn('recovery attempt failed', {
        host, attempts, error: details.error,
      });
    }

    if (attempts >= settings.maxAttempts) {
      this.#state.failed[tabId] = {
        tabId, url: details.url, host, error: details.error, at: this.#now(),
      };
      await this.#recordOutcome({ host, succeeded: false });
      await this.#persistState();
      this.#logger.error('giving up on tab', { tabId, host, attempts });
      this.#onStateChanged(this.snapshot());
      return SKIP_REASONS.attemptsExhausted;
    }

    this.#state.queue[tabId] = {
      tabId,
      url: details.url,
      host,
      attempts,
      error: details.error,
      enqueuedAt: this.#now(),
      notBefore: this.#now() + backoffDelayMs(attempts),
    };
    delete this.#state.failed[tabId];

    this.#logger.info('queued tab for recovery', {
      tabId, host, error: details.error, attempts,
    });
    await this.#persistState();
    this.#onStateChanged(this.snapshot());
    await this.tick();
    return null;
  }

  /** Entry point for onCommitted/onCompleted — a navigation that worked. */
  async handleNavigationSuccess(details) {
    await this.ready();
    if (details.frameId !== MAIN_FRAME_ID) return;

    const tabId = details.tabId;
    let changed = false;

    if (!this.#seenTabIds.has(tabId)) {
      this.#seenTabIds.add(tabId);
      changed = true;
    }

    const inFlight = this.#state.inFlight[tabId];
    if (inFlight) {
      delete this.#state.inFlight[tabId];
      delete this.#state.failed[tabId];
      changed = true;
      this.#logger.info('tab recovered', {
        tabId, host: inFlight.host, attempts: inFlight.attempts,
      });
      await this.#recordOutcome({ host: inFlight.host, succeeded: true });
    }

    // A successful load supersedes anything queued for that tab.
    if (this.#state.queue[tabId]) {
      delete this.#state.queue[tabId];
      changed = true;
    }

    if (changed) {
      await this.#persistState();
      this.#onStateChanged(this.snapshot());
      await this.tick();
    }
  }

  /**
   * Optional preventive path: when a tab that was never loaded in this session is
   * activated during the restore window, load it from the network straight away
   * instead of letting Chrome try the cache first.
   */
  async handleTabActivated(tabId, knownProblemHosts = []) {
    await this.ready();
    const settings = await this.#getSettings();
    if (!settings.enabled || !settings.preemptiveReloadOnActivate) {
      this.#seenTabIds.add(tabId);
      return false;
    }
    if (!this.#withinStartupWindow(settings)) return false;
    if (this.#seenTabIds.has(tabId)) return false;

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      this.#logger.debug('activated tab vanished', { tabId });
      return false;
    }

    const isUnloaded = tab.discarded === true || tab.status === 'unloaded';
    if (!isUnloaded) {
      this.#seenTabIds.add(tabId);
      await this.#persistState();
      return false;
    }

    const parsed = parseRecoverableUrl(tab.url ?? tab.pendingUrl);
    if (!parsed) return false;
    const host = parsed.hostname;
    if (this.#hostSkipReason(host, settings)) return false;

    const isKnownProblem = hostMatchesAnyPattern(host, knownProblemHosts)
      || hostMatchesAnyPattern(host, settings.hostAllowlist)
      || hostMatchesAnyPattern(host, settings.cacheable.domains);
    if (!isKnownProblem) return false;

    this.#seenTabIds.add(tabId);
    this.#state.queue[tabId] = {
      tabId,
      url: parsed.href,
      host,
      attempts: 0,
      error: 'preemptive',
      enqueuedAt: this.#now(),
      notBefore: this.#now(),
    };
    this.#logger.info('preemptive reload queued', { tabId, host });
    await this.#persistState();
    await this.tick();
    return true;
  }

  async handleTabRemoved(tabId) {
    await this.ready();
    let changed = false;
    for (const bucket of [this.#state.queue, this.#state.inFlight, this.#state.failed]) {
      if (bucket[tabId]) {
        delete bucket[tabId];
        changed = true;
      }
    }
    if (this.#seenTabIds.delete(tabId)) changed = true;
    if (changed) {
      await this.#persistState();
      this.#onStateChanged(this.snapshot());
    }
  }

  /** Re-queues every tab we previously gave up on. Driven by the popup button. */
  async retryAllFailed() {
    await this.ready();
    const entries = Object.values(this.#state.failed);
    if (entries.length === 0) return 0;

    for (const entry of entries) {
      this.#state.queue[entry.tabId] = {
        ...entry,
        attempts: 0,
        enqueuedAt: this.#now(),
        notBefore: this.#now(),
      };
      delete this.#state.failed[entry.tabId];
    }
    this.#logger.info('manual retry requested', { tabs: entries.length });
    await this.#persistState();
    await this.tick();
    return entries.length;
  }

  /**
   * Drives the queue: expires stale work, promotes due entries into flight
   * while respecting the per-host stagger and the concurrency cap, then
   * schedules the next wake-up.
   */
  async tick() {
    await this.ready();
    const settings = await this.#getSettings();
    const now = this.#now();
    let changed = false;

    // Recoveries that never reported an outcome.
    for (const entry of Object.values(this.#state.inFlight)) {
      if (now - entry.startedAt < RECOVERY_TIMEOUT_MS) continue;
      delete this.#state.inFlight[entry.tabId];
      changed = true;
      if (entry.attempts >= settings.maxAttempts) {
        this.#state.failed[entry.tabId] = { ...entry, error: 'timeout', at: now };
        await this.#recordOutcome({ host: entry.host, succeeded: false });
        this.#logger.warn('recovery timed out, giving up', { tabId: entry.tabId });
      } else {
        this.#state.queue[entry.tabId] = {
          ...entry,
          error: 'timeout',
          enqueuedAt: now,
          notBefore: now + backoffDelayMs(entry.attempts),
        };
        this.#logger.debug('recovery timed out, re-queued', { tabId: entry.tabId });
      }
    }

    // Abandon anything that has been waiting absurdly long (worker slept).
    for (const entry of Object.values(this.#state.queue)) {
      if (now - entry.enqueuedAt <= QUEUE_ENTRY_MAX_AGE_MS) continue;
      delete this.#state.queue[entry.tabId];
      changed = true;
      this.#logger.debug('dropped stale queue entry', { tabId: entry.tabId });
    }

    // Gates in the past no longer hold anything back.
    for (const [host, allowedAt] of Object.entries(this.#state.hostNextAllowedAt)) {
      if (allowedAt <= now) delete this.#state.hostNextAllowedAt[host];
    }

    if (!this.#isOnline()) {
      this.#logger.debug('offline, deferring recovery');
      if (changed) await this.#persistState();
      this.#scheduleNextTick(BACKOFF_BASE_MS);
      return;
    }

    const due = Object.values(this.#state.queue)
      .filter((entry) => entry.notBefore <= now)
      .sort((a, b) => a.notBefore - b.notBefore || a.enqueuedAt - b.enqueuedAt);

    for (const entry of due) {
      if (Object.keys(this.#state.inFlight).length >= MAX_CONCURRENT_RECOVERIES) break;
      const hostGate = this.#state.hostNextAllowedAt[entry.host] ?? 0;
      if (hostGate > now) continue;

      delete this.#state.queue[entry.tabId];
      changed = true;

      const issued = await this.#issueRecovery(entry);
      if (!issued) continue;

      this.#state.hostNextAllowedAt[entry.host] = now + settings.originStaggerMs;
      this.#state.inFlight[entry.tabId] = {
        ...entry,
        attempts: entry.attempts + 1,
        startedAt: now,
      };
    }

    if (changed) {
      await this.#persistState();
      this.#onStateChanged(this.snapshot());
    }
    this.#scheduleNextTick(this.#msUntilNextDeadline());
  }

  async #issueRecovery(entry) {
    try {
      // A fresh navigation to the same URL: unlike a cache-only restore load,
      // this goes to the network and lets Cloudflare hand out a new clearance.
      await chrome.tabs.update(entry.tabId, { url: entry.url });
      this.#logger.info('recovery navigation issued', {
        tabId: entry.tabId, host: entry.host, attempt: entry.attempts + 1,
      });
      return true;
    } catch (error) {
      // Usually the tab was closed between the error and the retry.
      this.#logger.warn('could not navigate tab', {
        tabId: entry.tabId, message: error?.message ?? String(error),
      });
      return false;
    }
  }

  /** Milliseconds until the next scheduled deadline, or null when idle. */
  #msUntilNextDeadline() {
    const now = this.#now();
    const deadlines = [];

    for (const entry of Object.values(this.#state.queue)) {
      const hostGate = this.#state.hostNextAllowedAt[entry.host] ?? 0;
      deadlines.push(Math.max(entry.notBefore, hostGate));
    }
    for (const entry of Object.values(this.#state.inFlight)) {
      deadlines.push(entry.startedAt + RECOVERY_TIMEOUT_MS);
    }
    if (deadlines.length === 0) return null;
    return Math.max(0, Math.min(...deadlines) - now);
  }

  #scheduleNextTick(delayMs) {
    if (this.#timerId !== null) {
      this.#clearTimer(this.#timerId);
      this.#timerId = null;
    }
    if (delayMs === null) return;
    // The promise is returned so a test clock can await the tick; setTimeout
    // itself ignores it.
    this.#timerId = this.#setTimer(() => {
      this.#timerId = null;
      return this.tick().catch((error) => {
        this.#logger.error('tick failed', error?.message ?? String(error));
      });
    }, delayMs);
  }
}
