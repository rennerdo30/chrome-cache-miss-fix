/**
 * Settings and statistics persistence, with validation on the way in and out.
 *
 * Anything read from storage is treated as untrusted (a user may have edited it,
 * or it may come from an older version) and is clamped to the documented range.
 */

import {
  CACHEABLE_MAX_AGE_SECONDS_DEFAULT,
  CACHEABLE_MAX_AGE_SECONDS_MAX,
  CACHEABLE_MAX_AGE_SECONDS_MIN,
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  LOG_LEVELS,
  MAX_ATTEMPTS_DEFAULT,
  MAX_ATTEMPTS_MAX,
  MAX_ATTEMPTS_MIN,
  ORIGIN_STAGGER_MS_DEFAULT,
  ORIGIN_STAGGER_MS_MAX,
  ORIGIN_STAGGER_MS_MIN,
  STARTUP_WINDOW_MINUTES_DEFAULT,
  STARTUP_WINDOW_MINUTES_MAX,
  STARTUP_WINDOW_MINUTES_MIN,
  STORAGE_KEYS,
  SUGGESTION_MAX_ENTRIES,
  SUGGESTION_MIN_RECOVERIES,
} from './constants.js';
import { normaliseHostPattern } from './host-match.js';

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asHostList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    const host = normaliseHostPattern(entry);
    if (host) seen.add(host);
  }
  return [...seen].sort();
}

/** Fills in defaults and clamps every field to its valid range. */
export function normaliseSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const cacheableInput = input.cacheable && typeof input.cacheable === 'object'
    ? input.cacheable
    : {};

  return {
    enabled: asBoolean(input.enabled, DEFAULT_SETTINGS.enabled),
    logLevel: Object.prototype.hasOwnProperty.call(LOG_LEVELS, input.logLevel)
      ? input.logLevel
      : DEFAULT_SETTINGS.logLevel,
    maxAttempts: clampInteger(
      input.maxAttempts, MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX, MAX_ATTEMPTS_DEFAULT,
    ),
    originStaggerMs: clampInteger(
      input.originStaggerMs,
      ORIGIN_STAGGER_MS_MIN,
      ORIGIN_STAGGER_MS_MAX,
      ORIGIN_STAGGER_MS_DEFAULT,
    ),
    recoverNetworkErrors: asBoolean(
      input.recoverNetworkErrors, DEFAULT_SETTINGS.recoverNetworkErrors,
    ),
    restrictToStartupWindow: asBoolean(
      input.restrictToStartupWindow, DEFAULT_SETTINGS.restrictToStartupWindow,
    ),
    startupWindowMinutes: clampInteger(
      input.startupWindowMinutes,
      STARTUP_WINDOW_MINUTES_MIN,
      STARTUP_WINDOW_MINUTES_MAX,
      STARTUP_WINDOW_MINUTES_DEFAULT,
    ),
    preemptiveReloadOnActivate: asBoolean(
      input.preemptiveReloadOnActivate, DEFAULT_SETTINGS.preemptiveReloadOnActivate,
    ),
    showBadge: asBoolean(input.showBadge, DEFAULT_SETTINGS.showBadge),
    hostAllowlist: asHostList(input.hostAllowlist),
    hostDenylist: asHostList(input.hostDenylist),
    cacheable: {
      enabled: asBoolean(cacheableInput.enabled, DEFAULT_SETTINGS.cacheable.enabled),
      domains: asHostList(cacheableInput.domains),
      maxAgeSeconds: clampInteger(
        cacheableInput.maxAgeSeconds,
        CACHEABLE_MAX_AGE_SECONDS_MIN,
        CACHEABLE_MAX_AGE_SECONDS_MAX,
        CACHEABLE_MAX_AGE_SECONDS_DEFAULT,
      ),
    },
  };
}

export async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return normaliseSettings(stored?.[STORAGE_KEYS.settings]);
  } catch (error) {
    console.warn('[cache-miss-fix] falling back to default settings', error);
    return normaliseSettings(null);
  }
}

/** Persists a full settings object; returns the normalised value written. */
export async function saveSettings(settings) {
  const normalised = normaliseSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: normalised });
  return normalised;
}

/** Merges a partial update into the stored settings. */
export async function updateSettings(patch) {
  const current = await loadSettings();
  return saveSettings({ ...current, ...patch });
}

/** Subscribes to settings changes made anywhere in the extension. */
export function onSettingsChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEYS.settings];
    if (!change) return;
    callback(normaliseSettings(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* --------------------------------------------------------------- statistics */

export function normaliseStats(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const byHost = {};
  if (input.byHost && typeof input.byHost === 'object') {
    for (const [host, count] of Object.entries(input.byHost)) {
      const numeric = Number(count);
      if (Number.isFinite(numeric) && numeric > 0) byHost[host] = Math.round(numeric);
    }
  }
  return {
    recovered: clampInteger(input.recovered, 0, Number.MAX_SAFE_INTEGER, 0),
    failed: clampInteger(input.failed, 0, Number.MAX_SAFE_INTEGER, 0),
    byHost,
    lastRecoveryAt: typeof input.lastRecoveryAt === 'string' ? input.lastRecoveryAt : null,
  };
}

export async function loadStats() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.stats);
    return normaliseStats(stored?.[STORAGE_KEYS.stats]);
  } catch {
    return normaliseStats(null);
  }
}

/** Records the outcome of one recovery attempt. */
export async function recordOutcome({ host, succeeded }) {
  const stats = await loadStats();
  if (succeeded) {
    stats.recovered += 1;
    stats.lastRecoveryAt = new Date().toISOString();
    if (host) stats.byHost[host] = (stats.byHost[host] ?? 0) + 1;
  } else {
    stats.failed += 1;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.stats]: stats });
  return stats;
}

export async function clearStats() {
  const stats = normaliseStats(DEFAULT_STATS);
  await chrome.storage.local.set({ [STORAGE_KEYS.stats]: stats });
  return stats;
}

/**
 * Hosts that needed recovering often enough to be worth putting into the
 * preventive rewrite list, most affected first.
 */
export function suggestedHosts(stats, alreadyConfigured = []) {
  const configured = new Set(alreadyConfigured);
  return Object.entries(stats?.byHost ?? {})
    .filter(([host, count]) => count >= SUGGESTION_MIN_RECOVERIES && !configured.has(host))
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUGGESTION_MAX_ENTRIES)
    .map(([host, count]) => ({ host, count }));
}
