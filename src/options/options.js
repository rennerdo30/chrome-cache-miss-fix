/**
 * Options page: settings, statistics and the log viewer.
 *
 * Settings are saved as soon as a control changes (with a short debounce for
 * text areas), so there is no save button to forget.
 */

import {
  LOG_EXPORT_FILENAME,
  LOG_EXPORT_MIME_TYPE,
  LOG_LEVELS,
  LOG_LEVEL_NAMES,
  MESSAGE_TYPES,
} from '../constants.js';
import { formatLogAsText, readPersistedLog } from '../logger.js';
import { normaliseHostPattern, originPatternForHost } from '../host-match.js';
import {
  loadSettings,
  loadStats,
  saveSettings,
  suggestedHosts,
} from '../settings.js';
import { formatDateTime, formatNumber, formatTime, localiseDocument, t } from '../ui/i18n.js';
import { initTheme, loadTheme, saveTheme } from '../ui/theme.js';

const TEXTAREA_SAVE_DEBOUNCE_MS = 600;
const TOAST_VISIBLE_MS = 1800;
const LOG_RENDER_MAX_ROWS = 400;
const HOST_LIST_SEPARATOR = '\n';

const byId = (id) => document.getElementById(id);

const controls = {
  theme: byId('theme'),
  enabled: byId('enabled'),
  showBadge: byId('showBadge'),
  logLevel: byId('logLevel'),
  maxAttempts: byId('maxAttempts'),
  originStaggerMs: byId('originStaggerMs'),
  recoverNetworkErrors: byId('recoverNetworkErrors'),
  restrictToStartupWindow: byId('restrictToStartupWindow'),
  startupWindowMinutes: byId('startupWindowMinutes'),
  preemptiveReloadOnActivate: byId('preemptiveReloadOnActivate'),
  hostAllowlist: byId('hostAllowlist'),
  hostDenylist: byId('hostDenylist'),
  cacheableEnabled: byId('cacheableEnabled'),
  cacheableDomains: byId('cacheableDomains'),
  cacheableMaxAge: byId('cacheableMaxAge'),
};

const view = {
  grantPermission: byId('grant-permission'),
  permissionStatus: byId('permission-status'),
  suggestions: byId('suggestions'),
  suggestionList: byId('suggestion-list'),
  statRecovered: byId('stat-recovered'),
  statFailed: byId('stat-failed'),
  statLast: byId('stat-last'),
  topHosts: byId('top-hosts'),
  clearStats: byId('clear-stats'),
  logFilter: byId('log-filter'),
  logRefresh: byId('log-refresh'),
  logExport: byId('log-export'),
  logClear: byId('log-clear'),
  logBody: byId('log-body'),
  logEmpty: byId('log-empty'),
  toast: byId('toast'),
};

let toastTimer = null;
let textareaTimer = null;

function showToast(message, kind = 'info') {
  view.toast.textContent = message;
  view.toast.dataset.kind = kind;
  view.toast.dataset.visible = 'true';
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { view.toast.dataset.visible = 'false'; }, TOAST_VISIBLE_MS);
}

function reportError(error) {
  console.error('[cache-miss-fix] options', error);
  showToast(t('toastError', [String(error?.message ?? error)]), 'error');
}

async function send(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error ?? 'unknown');
  return response.result;
}

/* ---------------------------------------------------------------- selects */

function fillLevelSelect(select) {
  select.replaceChildren(...LOG_LEVEL_NAMES.map((level) => {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = t(`level${level.charAt(0).toUpperCase()}${level.slice(1)}`);
    return option;
  }));
}

/* --------------------------------------------------------------- settings */

function textToHostList(value) {
  return value
    .split(HOST_LIST_SEPARATOR)
    .map((line) => normaliseHostPattern(line))
    .filter(Boolean);
}

function hostListToText(list) {
  return (list ?? []).join(HOST_LIST_SEPARATOR);
}

function readForm() {
  return {
    enabled: controls.enabled.checked,
    showBadge: controls.showBadge.checked,
    logLevel: controls.logLevel.value,
    maxAttempts: controls.maxAttempts.value,
    originStaggerMs: controls.originStaggerMs.value,
    recoverNetworkErrors: controls.recoverNetworkErrors.checked,
    restrictToStartupWindow: controls.restrictToStartupWindow.checked,
    startupWindowMinutes: controls.startupWindowMinutes.value,
    preemptiveReloadOnActivate: controls.preemptiveReloadOnActivate.checked,
    hostAllowlist: textToHostList(controls.hostAllowlist.value),
    hostDenylist: textToHostList(controls.hostDenylist.value),
    cacheable: {
      enabled: controls.cacheableEnabled.checked,
      domains: textToHostList(controls.cacheableDomains.value),
      maxAgeSeconds: controls.cacheableMaxAge.value,
    },
  };
}

/** Writes normalised settings back into the form so clamping is visible. */
function writeForm(settings) {
  controls.enabled.checked = settings.enabled;
  controls.showBadge.checked = settings.showBadge;
  controls.logLevel.value = settings.logLevel;
  controls.maxAttempts.value = String(settings.maxAttempts);
  controls.originStaggerMs.value = String(settings.originStaggerMs);
  controls.recoverNetworkErrors.checked = settings.recoverNetworkErrors;
  controls.restrictToStartupWindow.checked = settings.restrictToStartupWindow;
  controls.startupWindowMinutes.value = String(settings.startupWindowMinutes);
  controls.preemptiveReloadOnActivate.checked = settings.preemptiveReloadOnActivate;
  controls.startupWindowMinutes.disabled = !settings.restrictToStartupWindow
    && !settings.preemptiveReloadOnActivate;

  if (document.activeElement !== controls.hostAllowlist) {
    controls.hostAllowlist.value = hostListToText(settings.hostAllowlist);
  }
  if (document.activeElement !== controls.hostDenylist) {
    controls.hostDenylist.value = hostListToText(settings.hostDenylist);
  }
  controls.cacheableEnabled.checked = settings.cacheable.enabled;
  if (document.activeElement !== controls.cacheableDomains) {
    controls.cacheableDomains.value = hostListToText(settings.cacheable.domains);
  }
  controls.cacheableMaxAge.value = String(settings.cacheable.maxAgeSeconds);
  controls.cacheableDomains.disabled = !settings.cacheable.enabled;
  controls.cacheableMaxAge.disabled = !settings.cacheable.enabled;
}

async function persistForm() {
  try {
    const settings = await saveSettings(readForm());
    writeForm(settings);
    showToast(t('toastSaved'));
    await refreshPermissionStatus(settings);
    await refreshSuggestions(settings);
  } catch (error) {
    reportError(error);
  }
}

/* ------------------------------------------------------------ permissions */

async function refreshPermissionStatus(settings) {
  const hosts = settings.cacheable.domains;
  if (!settings.cacheable.enabled || hosts.length === 0) {
    view.permissionStatus.textContent = '';
    view.grantPermission.disabled = hosts.length === 0;
    return;
  }
  const missing = [];
  for (const host of hosts) {
    const origin = originPatternForHost(host);
    if (!origin) continue;
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (!granted) missing.push(host);
  }
  view.grantPermission.disabled = missing.length === 0;
  if (missing.length > 0) {
    view.permissionStatus.textContent = t('permissionMissing', [missing.join(', ')]);
    return;
  }
  try {
    const { active } = await send(MESSAGE_TYPES.syncRules);
    view.permissionStatus.textContent = t('rulesActive', [formatNumber(active)]);
  } catch (error) {
    reportError(error);
  }
}

view.grantPermission.addEventListener('click', async () => {
  try {
    const settings = await loadSettings();
    const origins = settings.cacheable.domains
      .map((host) => originPatternForHost(host))
      .filter(Boolean);
    if (origins.length === 0) return;
    const granted = await chrome.permissions.request({ origins });
    showToast(t(granted ? 'permissionGranted' : 'permissionDenied'), granted ? 'info' : 'error');
    if (granted) await send(MESSAGE_TYPES.syncRules);
    await refreshPermissionStatus(settings);
  } catch (error) {
    reportError(error);
  }
});

/* ------------------------------------------------------------- statistics */

async function refreshSuggestions(settings) {
  const stats = await loadStats();
  const suggestions = suggestedHosts(stats, settings.cacheable.domains);
  view.suggestions.hidden = suggestions.length === 0;
  view.suggestionList.replaceChildren(...suggestions.map(({ host, count }) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'mono';
    label.textContent = host;
    const countLabel = document.createElement('span');
    countLabel.className = 'count small';
    countLabel.textContent = t('suggestionCount', [formatNumber(count)]);
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = t('suggestionAdd');
    add.addEventListener('click', async () => {
      const current = await loadSettings();
      const domains = [...new Set([...current.cacheable.domains, host])];
      const saved = await saveSettings({
        ...current,
        cacheable: { ...current.cacheable, domains, enabled: true },
      });
      writeForm(saved);
      await refreshPermissionStatus(saved);
      await refreshSuggestions(saved);
    });
    item.append(label, countLabel, add);
    return item;
  }));
}

async function refreshStats() {
  const stats = await loadStats();
  view.statRecovered.textContent = formatNumber(stats.recovered);
  view.statFailed.textContent = formatNumber(stats.failed);
  view.statLast.textContent = formatDateTime(stats.lastRecoveryAt) ?? '—';

  const hosts = Object.entries(stats.byHost).sort((a, b) => b[1] - a[1]);
  if (hosts.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = t('statsEmpty');
    view.topHosts.replaceChildren(empty);
    return;
  }
  view.topHosts.replaceChildren(...hosts.map(([host, count]) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'mono';
    label.textContent = host;
    const countLabel = document.createElement('span');
    countLabel.className = 'count small';
    countLabel.textContent = formatNumber(count);
    item.append(label, countLabel);
    return item;
  }));
}

view.clearStats.addEventListener('click', async () => {
  try {
    await send(MESSAGE_TYPES.clearStats);
    await refreshStats();
    await refreshSuggestions(await loadSettings());
    showToast(t('toastSaved'));
  } catch (error) {
    reportError(error);
  }
});

/* -------------------------------------------------------------------- log */

async function refreshLog() {
  const threshold = LOG_LEVELS[view.logFilter.value] ?? LOG_LEVELS.info;
  const entries = (await readPersistedLog())
    .filter((entry) => (LOG_LEVELS[entry.level] ?? LOG_LEVELS.info) <= threshold)
    .slice(-LOG_RENDER_MAX_ROWS)
    .reverse();

  view.logEmpty.hidden = entries.length > 0;
  view.logBody.replaceChildren(...entries.map((entry) => {
    const row = document.createElement('tr');
    row.dataset.level = entry.level;

    const time = document.createElement('td');
    time.className = 'time';
    time.textContent = formatTime(entry.at);

    const level = document.createElement('td');
    level.className = 'level';
    level.textContent = entry.level;

    const message = document.createElement('td');
    message.className = 'message';
    message.textContent = entry.detail ? `${entry.message} ${entry.detail}` : entry.message;

    row.append(time, level, message);
    return row;
  }));
}

view.logRefresh.addEventListener('click', () => refreshLog().catch(reportError));

view.logExport.addEventListener('click', async () => {
  try {
    const text = formatLogAsText(await readPersistedLog());
    const blob = new Blob([text], { type: LOG_EXPORT_MIME_TYPE });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = LOG_EXPORT_FILENAME;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    reportError(error);
  }
});

view.logClear.addEventListener('click', async () => {
  try {
    await send(MESSAGE_TYPES.clearLog);
    await refreshLog();
  } catch (error) {
    reportError(error);
  }
});

/* ------------------------------------------------------------------- init */

function wireForm() {
  for (const control of Object.values(controls)) {
    if (control === controls.theme) continue;
    const isText = control.tagName === 'TEXTAREA';
    control.addEventListener(isText ? 'input' : 'change', () => {
      if (!isText) {
        persistForm().catch(reportError);
        return;
      }
      if (textareaTimer !== null) clearTimeout(textareaTimer);
      textareaTimer = setTimeout(() => {
        textareaTimer = null;
        persistForm().catch(reportError);
      }, TEXTAREA_SAVE_DEBOUNCE_MS);
    });
  }

  controls.theme.addEventListener('change', () => {
    saveTheme(controls.theme.value).catch(reportError);
  });
}

async function init() {
  await initTheme();
  fillLevelSelect(controls.logLevel);
  fillLevelSelect(view.logFilter);
  localiseDocument();

  controls.theme.value = await loadTheme();
  const settings = await loadSettings();
  writeForm(settings);
  view.logFilter.value = settings.logLevel;

  wireForm();
  await Promise.all([
    refreshStats(),
    refreshSuggestions(settings),
    refreshPermissionStatus(settings),
    refreshLog(),
  ]);
}

init().catch(reportError);
