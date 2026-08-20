/**
 * Service worker: wires Chrome's navigation events to the recovery controller.
 *
 * Every listener is registered synchronously at the top level — the worker is
 * started by these events, so late registration would miss them.
 */

import {
  BADGE_BACKGROUND_COLOR,
  BADGE_MAX_COUNT,
  BADGE_TEXT_COLOR,
  MESSAGE_TYPES,
  SUGGESTION_MIN_RECOVERIES,
  WATCHDOG_ALARM_NAME,
  WATCHDOG_ALARM_PERIOD_MINUTES,
} from './constants.js';
import { syncRules } from './cacheable-rules.js';
import { Logger } from './logger.js';
import {
  clearStats,
  loadSettings,
  loadStats,
  onSettingsChanged,
  recordOutcome,
} from './settings.js';
import { RecoveryController } from './recovery.js';

const logger = new Logger('background');

/** Settings are cached per worker lifetime and invalidated by storage events. */
let settingsPromise = null;
function getSettings() {
  if (!settingsPromise) {
    settingsPromise = loadSettings().then((settings) => {
      logger.setLevel(settings.logLevel);
      return settings;
    });
  }
  return settingsPromise;
}

const controller = new RecoveryController({
  logger,
  getSettings,
  recordOutcome,
  onStateChanged: (snapshot) => {
    updateBadge(snapshot).catch((error) => {
      logger.debug('badge update failed', error?.message ?? String(error));
    });
  },
});

async function updateBadge(snapshot) {
  const settings = await getSettings();
  const pending = snapshot.queued + snapshot.inFlight;
  const text = !settings.showBadge || pending === 0
    ? ''
    : String(Math.min(pending, BADGE_MAX_COUNT));
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND_COLOR });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  }
  await chrome.action.setBadgeText({ text });
}

/** Hosts that already needed recovering are the ones worth pre-empting. */
async function knownProblemHosts() {
  const stats = await loadStats();
  return Object.entries(stats.byHost)
    .filter(([, count]) => count >= SUGGESTION_MIN_RECOVERIES)
    .map(([host]) => host);
}

async function bootstrap(reason) {
  const settings = await getSettings();
  await logger.init(settings.logLevel);
  logger.info('worker started', { reason, enabled: settings.enabled });
  try {
    await chrome.alarms.create(WATCHDOG_ALARM_NAME, {
      periodInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES,
    });
  } catch (error) {
    logger.warn('could not create watchdog alarm', error?.message ?? String(error));
  }
  await controller.ready();
  await controller.tick();
}

/* --------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener((details) => {
  bootstrap(`installed:${details.reason}`)
    .then(async () => {
      const settings = await getSettings();
      if (settings.cacheable.enabled) await syncRules({ settings, logger });
    })
    .catch((error) => logger.error('install bootstrap failed', String(error)));
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap('browser-startup')
    .then(() => controller.markBrowserStartup())
    .catch((error) => logger.error('startup bootstrap failed', String(error)));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM_NAME) return;
  controller.tick().catch((error) => logger.error('watchdog tick failed', String(error)));
});

/* -------------------------------------------------------------- navigation */

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  controller.handleNavigationError(details).catch((error) => {
    logger.error('error handler failed', error?.message ?? String(error));
  });
});

chrome.webNavigation.onCompleted.addListener((details) => {
  controller.handleNavigationSuccess(details).catch((error) => {
    logger.error('success handler failed', error?.message ?? String(error));
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  knownProblemHosts()
    .then((hosts) => controller.handleTabActivated(tabId, hosts))
    .catch((error) => logger.debug('activation handler failed', String(error)));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  controller.handleTabRemoved(tabId).catch((error) => {
    logger.debug('remove handler failed', String(error));
  });
});

/* ---------------------------------------------------------------- settings */

onSettingsChanged((settings) => {
  settingsPromise = Promise.resolve(settings);
  logger.setLevel(settings.logLevel);
  logger.debug('settings updated', { enabled: settings.enabled });
  syncRules({ settings, logger })
    .catch((error) => logger.warn('rule sync after settings change failed', String(error)));
  controller.tick().catch((error) => logger.debug('tick after settings change', String(error)));
});

/* ---------------------------------------------------------------- messages */

const MESSAGE_HANDLERS = {
  async [MESSAGE_TYPES.getStatus]() {
    const [settings, stats] = await Promise.all([getSettings(), loadStats()]);
    await controller.ready();
    return { settings, stats, recovery: controller.snapshot() };
  },
  async [MESSAGE_TYPES.retryAll]() {
    const count = await controller.retryAllFailed();
    return { retried: count };
  },
  async [MESSAGE_TYPES.clearStats]() {
    return { stats: await clearStats() };
  },
  async [MESSAGE_TYPES.clearLog]() {
    await logger.clear();
    return { cleared: true };
  },
  async [MESSAGE_TYPES.syncRules]() {
    const settings = await getSettings();
    return syncRules({ settings, logger });
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message?.type];
  if (!handler) return false;
  handler(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      logger.error('message handler failed', { type: message?.type, error: String(error) });
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });
  return true; // response is sent asynchronously
});

// The worker may also be started by an event that is not one of the above.
bootstrap('module-load').catch((error) => {
  console.error('[cache-miss-fix] bootstrap failed', error);
});
