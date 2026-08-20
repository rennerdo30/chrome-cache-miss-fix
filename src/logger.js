/**
 * Logging with levels, to the console and to a persisted ring buffer that can
 * be exported as a text file from the options page.
 *
 * The logger never throws: a broken log must not break tab recovery.
 */

import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  LOG_MAX_ENTRIES,
  LOG_MESSAGE_MAX_LENGTH,
  LOG_PERSIST_DEBOUNCE_MS,
  STORAGE_KEYS,
} from './constants.js';

const CONSOLE_METHOD_BY_LEVEL = Object.freeze({
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'debug',
});

/** Structured detail objects are stringified defensively for the file log. */
function stringifyDetail(detail) {
  if (detail === undefined) return '';
  try {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (typeof text !== 'string') return String(detail);
    return text.length > LOG_MESSAGE_MAX_LENGTH
      ? `${text.slice(0, LOG_MESSAGE_MAX_LENGTH)}…`
      : text;
  } catch {
    return '[unserialisable]';
  }
}

export class Logger {
  #level = LOG_LEVELS[DEFAULT_LOG_LEVEL];
  #entries = [];
  #persistTimer = null;
  #loaded = false;
  #scope;

  constructor(scope) {
    this.#scope = scope;
  }

  /** Loads previously persisted entries so the log survives worker restarts. */
  async init(level = DEFAULT_LOG_LEVEL) {
    this.setLevel(level);
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.log);
      const entries = stored?.[STORAGE_KEYS.log];
      if (Array.isArray(entries)) {
        // Anything logged while this read was in flight belongs after the
        // persisted entries, not instead of them.
        this.#entries = [...entries, ...this.#entries].slice(-LOG_MAX_ENTRIES);
      }
    } catch (error) {
      console.warn('[cache-miss-fix] could not read persisted log', error);
    }
  }

  setLevel(level) {
    if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
      this.#level = LOG_LEVELS[level];
    }
  }

  get level() {
    return Object.keys(LOG_LEVELS).find((name) => LOG_LEVELS[name] === this.#level)
      ?? DEFAULT_LOG_LEVEL;
  }

  isEnabled(level) {
    return LOG_LEVELS[level] <= this.#level;
  }

  error(message, detail) { this.#log('error', message, detail); }
  warn(message, detail) { this.#log('warn', message, detail); }
  info(message, detail) { this.#log('info', message, detail); }
  debug(message, detail) { this.#log('debug', message, detail); }
  trace(message, detail) { this.#log('trace', message, detail); }

  #log(level, message, detail) {
    if (!this.isEnabled(level)) return;
    const entry = {
      at: new Date().toISOString(),
      level,
      scope: this.#scope,
      message: String(message),
      detail: stringifyDetail(detail),
    };

    const method = CONSOLE_METHOD_BY_LEVEL[level] ?? 'log';
    const prefix = `[cache-miss-fix:${entry.scope}]`;
    if (detail === undefined) {
      console[method](prefix, entry.message);
    } else {
      console[method](prefix, entry.message, detail);
    }

    this.#entries.push(entry);
    if (this.#entries.length > LOG_MAX_ENTRIES) {
      this.#entries.splice(0, this.#entries.length - LOG_MAX_ENTRIES);
    }
    this.#schedulePersist();
  }

  #schedulePersist() {
    if (this.#persistTimer !== null) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.flush();
    }, LOG_PERSIST_DEBOUNCE_MS);
  }

  /** Writes the buffer out immediately. Safe to call at any time. */
  async flush() {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.log]: this.#entries });
    } catch (error) {
      console.warn('[cache-miss-fix] could not persist log', error);
    }
  }

  entries() {
    return this.#entries.slice();
  }

  async clear() {
    this.#entries = [];
    await this.flush();
  }
}

/** Reads the persisted log without instantiating a logger (used by the UI). */
export async function readPersistedLog() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.log);
    const entries = stored?.[STORAGE_KEYS.log];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/** Renders log entries as plain text for export. */
export function formatLogAsText(entries) {
  return entries
    .map((entry) => {
      const detail = entry.detail ? ` ${entry.detail}` : '';
      return `${entry.at} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}${detail}`;
    })
    .join('\n');
}
