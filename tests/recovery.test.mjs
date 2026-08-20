/**
 * Tests for the recovery scheduling. Run with: node --test tests/
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { createManualClock, createTestLogger, installFakeChrome } from './fake-chrome.mjs';

const environment = installFakeChrome();

const { RecoveryController, SKIP_REASONS, backoffDelayMs } = await import('../src/recovery.js');
const { normaliseSettings } = await import('../src/settings.js');
const { MAX_CONCURRENT_RECOVERIES, RECOVERY_TIMEOUT_MS } = await import('../src/constants.js');
const { buildRules, cacheControlValue } = await import('../src/cacheable-rules.js');
const { hostMatchesPattern, normaliseHostPattern } = await import('../src/host-match.js');

const CACHE_MISS = 'net::ERR_CACHE_MISS';
const OTHER_ERROR = 'net::ERR_NAME_NOT_RESOLVED';

function cacheError(tabId, url, error = CACHE_MISS, frameId = 0) {
  return { tabId, frameId, url, error, timeStamp: 0 };
}

function makeController(settingsPatch = {}, clock = createManualClock()) {
  const settings = normaliseSettings(settingsPatch);
  const outcomes = [];
  const logger = createTestLogger();
  const controller = new RecoveryController({
    logger,
    getSettings: async () => settings,
    recordOutcome: async (outcome) => { outcomes.push(outcome); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isOnline: () => true,
  });
  return { controller, outcomes, logger, clock, settings };
}

describe('host matching', () => {
  it('treats a bare domain as covering its subdomains', () => {
    assert.equal(hostMatchesPattern('www.example.com', 'example.com'), true);
    assert.equal(hostMatchesPattern('example.com', 'example.com'), true);
    assert.equal(hostMatchesPattern('notexample.com', 'example.com'), false);
  });

  it('accepts pasted URLs and wildcard prefixes', () => {
    assert.equal(normaliseHostPattern('https://Shop.Example.com/cart?x=1'), 'shop.example.com');
    assert.equal(normaliseHostPattern('*.example.com'), 'example.com');
    assert.equal(normaliseHostPattern('  '), null);
    assert.equal(normaliseHostPattern('localhost'), null);
  });
});

describe('recovery scheduling', () => {
  beforeEach(() => {
    environment.reset();
  });

  it('re-navigates a tab that failed with a cache error', async () => {
    const { controller, clock } = makeController();
    environment.setTab({ id: 1, url: 'https://protected.example/page', status: 'complete' });

    const skip = await controller.handleNavigationError(
      cacheError(1, 'https://protected.example/page'),
    );

    assert.equal(skip, null);
    assert.deepEqual(environment.navigations, [
      { tabId: 1, url: 'https://protected.example/page' },
    ]);
    assert.equal(controller.snapshot().inFlight, 1);
    assert.ok(clock.pendingCount() > 0, 'a timeout watchdog should be scheduled');
  });

  it('staggers two tabs of the same host', async () => {
    const clock = createManualClock();
    const { controller, settings } = makeController({ originStaggerMs: 1500 }, clock);
    environment.setTab({ id: 1, url: 'https://a.example/one' });
    environment.setTab({ id: 2, url: 'https://a.example/two' });

    await controller.handleNavigationError(cacheError(1, 'https://a.example/one'));
    await controller.handleNavigationError(cacheError(2, 'https://a.example/two'));

    assert.equal(environment.navigations.length, 1, 'second tab must wait');
    assert.equal(controller.snapshot().queued, 1);

    await clock.advance(settings.originStaggerMs);
    assert.deepEqual(
      environment.navigations.map((entry) => entry.tabId),
      [1, 2],
      'second tab runs after the stagger delay',
    );
  });

  it('does not stagger across different hosts, but caps concurrency', async () => {
    const total = MAX_CONCURRENT_RECOVERIES + 1;
    const { controller } = makeController();
    for (let id = 1; id <= total; id += 1) {
      environment.setTab({ id, url: `https://host${id}.example/` });
    }
    for (let id = 1; id <= total; id += 1) {
      await controller.handleNavigationError(cacheError(id, `https://host${id}.example/`));
    }

    assert.equal(environment.navigations.length, MAX_CONCURRENT_RECOVERIES);
    assert.equal(controller.snapshot().queued, 1);
  });

  it('ignores subframes, other schemes and unrelated errors', async () => {
    const { controller } = makeController();
    environment.setTab({ id: 1, url: 'https://a.example/' });

    assert.equal(
      await controller.handleNavigationError(cacheError(1, 'https://a.example/', CACHE_MISS, 7)),
      SKIP_REASONS.subframe,
    );
    assert.equal(
      await controller.handleNavigationError(cacheError(1, 'chrome://newtab')),
      SKIP_REASONS.scheme,
    );
    assert.equal(
      await controller.handleNavigationError(cacheError(1, 'https://a.example/', OTHER_ERROR)),
      SKIP_REASONS.errorNotRecoverable,
    );
    assert.equal(environment.navigations.length, 0);
  });

  it('honours the denylist and the allowlist', async () => {
    environment.setTab({ id: 1, url: 'https://blocked.example/' });
    const denied = makeController({ hostDenylist: ['blocked.example'] });
    assert.equal(
      await denied.controller.handleNavigationError(cacheError(1, 'https://blocked.example/')),
      SKIP_REASONS.denylisted,
    );

    environment.reset();
    environment.setTab({ id: 1, url: 'https://other.example/' });
    const allowed = makeController({ hostAllowlist: ['only.example'] });
    assert.equal(
      await allowed.controller.handleNavigationError(cacheError(1, 'https://other.example/')),
      SKIP_REASONS.notAllowlisted,
    );
    assert.equal(environment.navigations.length, 0);
  });

  it('retries with backoff and gives up after the configured attempts', async () => {
    const clock = createManualClock();
    const { controller, outcomes, settings } = makeController({ maxAttempts: 2 }, clock);
    const url = 'https://a.example/';
    environment.setTab({ id: 1, url });

    await controller.handleNavigationError(cacheError(1, url));
    assert.equal(environment.navigations.length, 1);

    // The recovery navigation fails the same way.
    await controller.handleNavigationError(cacheError(1, url));
    assert.equal(environment.navigations.length, 1, 'retry waits for the backoff');
    await clock.advance(backoffDelayMs(1));
    assert.equal(environment.navigations.length, 2);

    // Second attempt fails too: attempts are exhausted.
    const reason = await controller.handleNavigationError(cacheError(1, url));
    assert.equal(reason, SKIP_REASONS.attemptsExhausted);
    assert.deepEqual(outcomes, [{ host: 'a.example', succeeded: false }]);
    assert.equal(controller.snapshot().failed.length, 1);

    // The manual retry puts it back in the queue with a fresh budget, but the
    // per-host stagger still applies.
    const retried = await controller.retryAllFailed();
    assert.equal(retried, 1);
    assert.equal(environment.navigations.length, 2);
    await clock.advance(settings.originStaggerMs);
    assert.equal(environment.navigations.length, 3);
  });

  it('records success and forgets the tab', async () => {
    const { controller, outcomes } = makeController();
    const url = 'https://a.example/';
    environment.setTab({ id: 1, url });

    await controller.handleNavigationError(cacheError(1, url));
    await controller.handleNavigationSuccess({ tabId: 1, frameId: 0, url });

    assert.deepEqual(outcomes, [{ host: 'a.example', succeeded: true }]);
    assert.deepEqual(controller.snapshot(), {
      queued: 0, inFlight: 0, failed: [], startupAt: null,
    });
  });

  it('re-queues a recovery that never reported an outcome', async () => {
    const clock = createManualClock();
    const { controller } = makeController({ maxAttempts: 3 }, clock);
    const url = 'https://a.example/';
    environment.setTab({ id: 1, url });

    await controller.handleNavigationError(cacheError(1, url));
    assert.equal(environment.navigations.length, 1);

    await clock.advance(RECOVERY_TIMEOUT_MS + backoffDelayMs(1) + 1);
    assert.equal(environment.navigations.length, 2, 'timed-out recovery is retried');
  });

  it('drops state when the tab is closed', async () => {
    const { controller } = makeController();
    const url = 'https://a.example/';
    environment.setTab({ id: 1, url });

    await controller.handleNavigationError(cacheError(1, url));
    await controller.handleTabRemoved(1);

    assert.equal(controller.snapshot().inFlight, 0);
    assert.equal(controller.snapshot().queued, 0);
  });

  it('restricts to the session-restore window when asked', async () => {
    const clock = createManualClock();
    const { controller } = makeController(
      { restrictToStartupWindow: true, startupWindowMinutes: 5 }, clock,
    );
    const url = 'https://a.example/';
    environment.setTab({ id: 1, url });

    assert.equal(
      await controller.handleNavigationError(cacheError(1, url)),
      SKIP_REASONS.outsideStartupWindow,
      'no startup observed yet',
    );

    await controller.markBrowserStartup();
    assert.equal(await controller.handleNavigationError(cacheError(1, url)), null);

    await clock.advance(6 * 60 * 1000);
    environment.navigations.length = 0;
    await controller.handleNavigationError(cacheError(2, url));
    assert.equal(environment.navigations.length, 0, 'window has closed');
  });

  it('survives a worker restart by reloading persisted state', async () => {
    const clock = createManualClock();
    const first = makeController({ originStaggerMs: 5000 }, clock);
    environment.setTab({ id: 1, url: 'https://a.example/one' });
    environment.setTab({ id: 2, url: 'https://a.example/two' });
    await first.controller.handleNavigationError(cacheError(1, 'https://a.example/one'));
    await first.controller.handleNavigationError(cacheError(2, 'https://a.example/two'));
    assert.equal(first.controller.snapshot().queued, 1);

    // A brand new controller reads the queue back out of storage.session.
    const second = makeController({ originStaggerMs: 5000 }, clock);
    await second.controller.ready();
    assert.equal(second.controller.snapshot().queued, 1);
    assert.equal(second.controller.snapshot().inFlight, 1);
  });
});

describe('preemptive reload on activation', () => {
  beforeEach(() => {
    environment.reset();
  });

  it('only touches unloaded tabs of known problem hosts', async () => {
    const { controller } = makeController({ preemptiveReloadOnActivate: true });
    await controller.markBrowserStartup();

    environment.setTab({ id: 1, url: 'https://known.example/', status: 'unloaded' });
    environment.setTab({ id: 2, url: 'https://other.example/', status: 'unloaded' });
    environment.setTab({ id: 3, url: 'https://known.example/x', status: 'complete' });

    assert.equal(await controller.handleTabActivated(1, ['known.example']), true);
    assert.equal(await controller.handleTabActivated(2, ['known.example']), false);
    assert.equal(await controller.handleTabActivated(3, ['known.example']), false);
    assert.deepEqual(
      environment.navigations.map((entry) => entry.tabId),
      [1],
    );
  });

  it('stays out of the way when the option is off', async () => {
    const { controller } = makeController({ preemptiveReloadOnActivate: false });
    await controller.markBrowserStartup();
    environment.setTab({ id: 1, url: 'https://known.example/', status: 'unloaded' });
    assert.equal(await controller.handleTabActivated(1, ['known.example']), false);
    assert.equal(environment.navigations.length, 0);
  });
});

describe('preventive header rules', () => {
  it('builds one main-frame rule per host, sorted and de-duplicated', () => {
    const rules = buildRules({
      enabled: true,
      domains: ['b.example', 'a.example', 'https://a.example/'],
      maxAgeSeconds: 120,
    });

    assert.deepEqual(rules.map((rule) => rule.condition.requestDomains[0]), ['a.example', 'b.example']);
    assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame']);
    const [cacheControl] = rules[0].action.responseHeaders;
    assert.equal(cacheControl.header, 'cache-control');
    assert.equal(cacheControl.operation, 'set');
    assert.equal(cacheControl.value, cacheControlValue(120));
    assert.ok(new Set(rules.map((rule) => rule.id)).size === rules.length, 'rule ids are unique');
  });

  it('produces nothing while disabled', () => {
    assert.deepEqual(buildRules({ enabled: false, domains: ['a.example'], maxAgeSeconds: 60 }), []);
  });
});
