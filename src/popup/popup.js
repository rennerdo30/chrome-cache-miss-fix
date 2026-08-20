/** Popup: current state at a glance, the on/off switch, and a manual retry. */

import { MESSAGE_TYPES } from '../constants.js';
import { formatDateTime, formatNumber, localiseDocument, t } from '../ui/i18n.js';
import { initTheme } from '../ui/theme.js';
import { updateSettings } from '../settings.js';

const TOAST_VISIBLE_MS = 2200;
const FAILED_LIST_MAX_ITEMS = 8;

const elements = {
  statusBadge: document.getElementById('status-badge'),
  enabled: document.getElementById('enabled'),
  queued: document.getElementById('count-queued'),
  inFlight: document.getElementById('count-inflight'),
  failed: document.getElementById('count-failed'),
  recovered: document.getElementById('count-recovered'),
  lastRecovery: document.getElementById('last-recovery'),
  failedList: document.getElementById('failed-list'),
  noIssues: document.getElementById('no-issues'),
  retryAll: document.getElementById('retry-all'),
  openOptions: document.getElementById('open-options'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;

function showToast(message, kind = 'info') {
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.dataset.visible = 'true';
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.dataset.visible = 'false';
  }, TOAST_VISIBLE_MS);
}

/** Talks to the service worker; surfaces failures instead of failing silently. */
async function send(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) {
    throw new Error(response?.error ?? t('toastError', ['unknown']));
  }
  return response.result;
}

function render({ settings, stats, recovery }) {
  elements.enabled.checked = settings.enabled;
  const statusKey = settings.enabled ? 'popupStatusActive' : 'popupStatusPaused';
  elements.statusBadge.textContent = t(statusKey);
  elements.statusBadge.className = `badge ${settings.enabled ? 'ok' : 'off'}`;

  elements.queued.textContent = formatNumber(recovery.queued);
  elements.inFlight.textContent = formatNumber(recovery.inFlight);
  elements.failed.textContent = formatNumber(recovery.failed.length);
  elements.recovered.textContent = formatNumber(stats.recovered);

  const when = formatDateTime(stats.lastRecoveryAt);
  elements.lastRecovery.textContent = t('popupLastRecovery', [when ?? t('popupNever')]);

  elements.failedList.replaceChildren(
    ...recovery.failed.slice(0, FAILED_LIST_MAX_ITEMS).map((entry) => {
      const item = document.createElement('li');
      item.className = 'mono';
      item.textContent = entry.host;
      item.title = entry.url;
      return item;
    }),
  );
  elements.failedList.hidden = recovery.failed.length === 0;
  elements.retryAll.disabled = recovery.failed.length === 0;

  const idle = recovery.failed.length === 0 && recovery.queued === 0 && recovery.inFlight === 0;
  elements.noIssues.hidden = !idle;
}

async function refresh() {
  try {
    render(await send(MESSAGE_TYPES.getStatus));
  } catch (error) {
    showToast(t('toastError', [String(error.message ?? error)]), 'error');
  }
}

elements.enabled.addEventListener('change', async () => {
  try {
    await updateSettings({ enabled: elements.enabled.checked });
    await refresh();
  } catch (error) {
    showToast(t('toastError', [String(error.message ?? error)]), 'error');
  }
});

elements.retryAll.addEventListener('click', async () => {
  try {
    const { retried } = await send(MESSAGE_TYPES.retryAll);
    showToast(t('popupRetryStarted', [formatNumber(retried)]));
    await refresh();
  } catch (error) {
    showToast(t('toastError', [String(error.message ?? error)]), 'error');
  }
});

elements.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

await initTheme();
localiseDocument();
await refresh();
