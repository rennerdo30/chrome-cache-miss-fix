/**
 * Host and URL helpers shared by the background worker and the UI.
 *
 * A pattern matches a hostname when it is equal to it or is a parent domain of
 * it: `example.com` matches `example.com` and `www.example.com`, but never
 * `notexample.com`. A leading `*.` or `.` is accepted and ignored, because that
 * is how people habitually write such lists.
 */

import { RECOVERABLE_URL_SCHEMES } from './constants.js';

const WILDCARD_PREFIXES = ['*.', '.'];

/** Normalises user input into a bare, lowercase hostname (or null). */
export function normaliseHostPattern(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (value === '') return null;

  // Accept a pasted URL and keep only its host.
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }

  for (const prefix of WILDCARD_PREFIXES) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  value = value.replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (value === '' || value.includes(' ') || !value.includes('.')) return null;
  return value;
}

/** True when `hostname` is `pattern` or a subdomain of it. */
export function hostMatchesPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const host = hostname.toLowerCase();
  const normalised = normaliseHostPattern(pattern);
  if (!normalised) return false;
  return host === normalised || host.endsWith(`.${normalised}`);
}

export function hostMatchesAnyPattern(hostname, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => hostMatchesPattern(hostname, pattern));
}

/** Parses a navigation URL, returning null for anything we must not touch. */
export function parseRecoverableUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!RECOVERABLE_URL_SCHEMES.includes(parsed.protocol)) return null;
  return parsed;
}

/** Builds the `chrome.permissions` origin pattern for a host pattern. */
export function originPatternForHost(hostPattern) {
  const host = normaliseHostPattern(hostPattern);
  return host ? `*://*.${host}/*` : null;
}
