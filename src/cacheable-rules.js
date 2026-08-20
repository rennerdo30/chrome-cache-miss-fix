/**
 * Optional preventive layer: make selected hosts' HTML documents cacheable so
 * that Chrome's cache-first session restore has something to restore from.
 *
 * Cloudflare-protected pages are typically served with
 * `Cache-Control: private, no-cache, no-store, must-revalidate`. Replacing that
 * with a short private max-age lets the restore load succeed instead of failing
 * with ERR_CACHE_MISS — no reload, no flash of an error page.
 *
 * This is off by default and per host, on purpose: it writes authenticated HTML
 * into the browser's on-disk cache, which is a real (if modest) privacy
 * trade-off, and it can serve a few minutes of stale HTML.
 *
 * Only main-frame documents are touched; subresources keep their own headers.
 */

import {
  CACHEABLE_REMOVED_HEADERS,
  CACHEABLE_RESOURCE_TYPES,
  CACHE_CONTROL_HEADER,
  DNR_RULE_ID_BASE,
  DNR_RULE_ID_MAX,
  DNR_RULE_PRIORITY,
} from './constants.js';
import { normaliseHostPattern, originPatternForHost } from './host-match.js';

/** `private` keeps intermediaries out; `must-revalidate` is intentionally dropped. */
export function cacheControlValue(maxAgeSeconds) {
  return `private, max-age=${maxAgeSeconds}`;
}

/**
 * Builds the dynamic rule set. Ids are derived from the host's position in the
 * (sorted, de-duplicated) domain list so they stay inside our reserved range.
 */
export function buildRules(cacheableSettings) {
  if (!cacheableSettings?.enabled) return [];
  const hosts = [...new Set(
    (cacheableSettings.domains ?? [])
      .map((domain) => normaliseHostPattern(domain))
      .filter(Boolean),
  )].sort();

  return hosts.map((host, index) => {
    const id = DNR_RULE_ID_BASE + index;
    if (id > DNR_RULE_ID_MAX) return null;
    return {
      id,
      priority: DNR_RULE_PRIORITY,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          {
            header: CACHE_CONTROL_HEADER,
            operation: 'set',
            value: cacheControlValue(cacheableSettings.maxAgeSeconds),
          },
          ...CACHEABLE_REMOVED_HEADERS.map((header) => ({ header, operation: 'remove' })),
        ],
      },
      condition: {
        requestDomains: [host],
        resourceTypes: [...CACHEABLE_RESOURCE_TYPES],
      },
    };
  }).filter(Boolean);
}

/** Host permissions are required to modify headers; report what is missing. */
export async function missingPermissions(hosts) {
  const missing = [];
  for (const host of hosts) {
    const origin = originPatternForHost(host);
    if (!origin) continue;
    try {
      const granted = await chrome.permissions.contains({ origins: [origin] });
      if (!granted) missing.push(host);
    } catch {
      missing.push(host);
    }
  }
  return missing;
}

/**
 * Replaces our dynamic rules with the ones the current settings ask for.
 * Rules are only installed for hosts we actually hold permission for.
 */
export async function syncRules({ settings, logger }) {
  const wanted = buildRules(settings.cacheable);
  const hosts = wanted.map((rule) => rule.condition.requestDomains[0]);
  const missing = await missingPermissions(hosts);
  const effective = wanted.filter(
    (rule) => !missing.includes(rule.condition.requestDomains[0]),
  );

  let existingIds = [];
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    existingIds = existing
      .filter((rule) => rule.id >= DNR_RULE_ID_BASE && rule.id <= DNR_RULE_ID_MAX)
      .map((rule) => rule.id);
  } catch (error) {
    logger.warn('could not read dynamic rules', error?.message ?? String(error));
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: effective,
    });
    logger.info('header rewrite rules synchronised', {
      active: effective.length,
      skippedForMissingPermission: missing,
    });
  } catch (error) {
    logger.error('could not update dynamic rules', error?.message ?? String(error));
    throw error;
  }

  return { active: effective.length, missing };
}
