/**
 * Minimal stand-in for the parts of the `chrome` API the background logic uses,
 * plus a manual clock, so the recovery scheduling can be tested in Node.
 */

export function installFakeChrome() {
  const local = new Map();
  const session = new Map();

  const area = (store) => ({
    async get(key) {
      if (key === undefined || key === null) return Object.fromEntries(store);
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const k of keys) if (store.has(k)) result[k] = store.get(k);
      return result;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, JSON.parse(JSON.stringify(v)));
      }
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
  });

  const tabs = new Map();
  const navigations = [];

  const fake = {
    storage: {
      local: area(local),
      session: area(session),
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error(`No tab with id ${tabId}`);
        return tabs.get(tabId);
      },
      async update(tabId, properties) {
        if (!tabs.has(tabId)) throw new Error(`No tab with id ${tabId}`);
        navigations.push({ tabId, ...properties });
        return { ...tabs.get(tabId), ...properties };
      },
    },
  };

  globalThis.chrome = fake;

  return {
    fake,
    navigations,
    setTab(tab) { tabs.set(tab.id, tab); },
    removeTab(tabId) { tabs.delete(tabId); },
    localStore: local,
    sessionStore: session,
    reset() {
      local.clear();
      session.clear();
      tabs.clear();
      navigations.length = 0;
    },
  };
}

/** A clock whose timers only fire when the test advances it. */
export function createManualClock(startAt = 1_000_000) {
  let current = startAt;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimer(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pendingCount: () => timers.size,
    /** Advances time, running due timers in order (awaiting async callbacks). */
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        current = Math.max(current, timer.at);
        await timer.callback();
      }
      current = target;
    },
  };
}

/** Collects log output instead of printing it. */
export function createTestLogger() {
  const entries = [];
  const record = (level) => (message, detail) => entries.push({ level, message, detail });
  return {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    setLevel() {},
    isEnabled: () => true,
  };
}
