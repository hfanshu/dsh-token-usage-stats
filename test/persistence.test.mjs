/**
 * Scenario tests for dsh-token-usage-stats' SQLite persistence layer.
 *
 * Runs the real `apply()` against a stub Cordis context: no Harness needed.
 * Covers fresh database creation, the fold (settlement replacement, retry
 * accumulation, turn timing), legacy JSON import, retention pruning, restart
 * durability, `:memory:` mode, and foreign-database rejection.
 *
 * Usage: node --test test/persistence.test.mjs   (from the plugin directory)
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { apply as applyPlugin } from '../index.js';
import { assistantMessage, requestHeader, sessionTitle, turnEnd, turnStart, writeSessionLog } from './session-log-fixture.mjs';

/**
 * `apply()` with the historical replay disabled unless a test opts in: the
 * default session-log root is the real `$DSH_HOME/sessions`, and a suite must
 * never read (or slow down on) the operator's own history.
 */
function apply(ctx, config) {
  return applyPlugin(ctx, { backfillHistory: false, ...config });
}

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A leaked handle on Windows only leaves a temp directory behind.
    }
  }
});

/** A fresh scratch directory, removed when the suite finishes. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'tus-test-'));
  scratchDirs.push(dir);
  return dir;
}

/** Minimal Cordis-shaped context capturing logs, effects, and the HTTP route. */
function fakeContext() {
  const logs = [];
  const disposers = [];
  const handlers = [];
  const routes = [];
  const commands = [];
  const ctx = {
    logs,
    logger: {
      info: (fmt, ...args) => logs.push(['info', fmt, ...args]),
      warn: (fmt, ...args) => logs.push(['warn', fmt, ...args]),
      debug: () => {},
    },
    effect(factory) {
      disposers.push(factory());
      return () => {};
    },
    on(name, handler) {
      handlers.push({ name, handler });
    },
    inject(names, callback) {
      callback();
    },
    commands: {
      register(command) {
        commands.push(command);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  return {
    ctx,
    logs,
    routes,
    commands,
    emit: (session, event) => {
      for (const entry of handlers) if (entry.name === 'session/event') entry.handler(session, event);
    },
    /** Fire every registered effect disposer (simulates plugin unmount). */
    dispose: async () => {
      for (const disposer of disposers.reverse()) await disposer?.();
    },
  };
}

/** Drive the registered HTTP route and parse its JSON body. */
async function summaryOf(routes) {
  const route = routes.find((entry) => entry.path === '/api/token-stats');
  assert.ok(route, 'the /api/token-stats route must be registered');
  return JSON.parse(await bodyOf(route, { method: 'GET' }));
}

/** Drive the breakdown route for one dimension and parse its JSON body. */
async function breakdownOf(routes, query) {
  const route = routes.find((entry) => entry.path === '/api/token-stats/breakdown');
  assert.ok(route, 'the breakdown route must be registered');
  const url = `/api/token-stats/breakdown?${new URLSearchParams(query).toString()}`;
  return JSON.parse(await bodyOf(route, { method: 'GET', url }));
}

/** Invoke one route handler and return its body plus status. */
async function invoke(routes, path, request) {
  const route = routes.find((entry) => entry.path === path);
  assert.ok(route, `route ${path} must be registered`);
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      if (typeof chunk === 'string') body = chunk;
    },
  };
  await route.handler(request, res);
  return { status, body };
}

/** Invoke one route handler and return only its body. */
async function bodyOf(route, request) {
  let body = '';
  const res = {
    writeHead() {},
    end(chunk) {
      if (typeof chunk === 'string') body = chunk;
    },
  };
  await route.handler(request, res);
  return body;
}

/** Let the coalesced flush chain drain (it is promise-chained, not timed). */
async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const DAY = 86400000;
const BASE = new Date(2026, 9, 20, 12, 0, 0).getTime(); // 2026-10-20 12:00 local

/** Local calendar day key of one epoch millisecond, matching the host's days. */
function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A session stub shaped like the host's live Session: `header` carries the
 * durable identity (`id`, `cwd`), which is what project/session keying reads.
 * @param {string} id - session id.
 * @param {string} [cwd] - working directory (the project identity).
 */
function sessionOf(id, cwd = 'E:\\project\\demo') {
  return { id, header: { id, cwd, version: 4, createdAt: BASE } };
}

/** One assistant settlement event carrying usage. */
function settlement(turn, step, usage, time = BASE) {
  return {
    type: 'assistant/message',
    time,
    data: { turn, step, usage },
  };
}

/** One usage stream chunk carried by an assistant/attempt event. */
function attempt(turn, step, usage, time = BASE) {
  return {
    type: 'assistant/attempt',
    time,
    data: {
      turn,
      step,
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }],
    },
  };
}

const usageA = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 5 };
const usageB = { inputTokens: 200, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 7 };

test('fresh database: creates the file, persists a settlement, and survives restart', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'nested', 'stats.sqlite');
  const session = { id: 'session-1' };

  const first = fakeContext();
  apply(first.ctx, { dbPath });
  await settle();
  first.emit(session, { type: 'request/header', time: BASE, data: { header: { config: { provider: 'deepseek', model: 'v4' } } } });
  first.emit(session, settlement(1, 0, usageA));
  await settle();

  assert.ok(existsSync(dbPath), 'the SQLite file must exist after the first flush');
  const before = await summaryOf(first.routes);
  assert.equal(before.v, 3);
  assert.equal(before.persisted, true);
  assert.equal(before.allTime.total, 1115);
  assert.equal(before.allTime.settlements, 1);
  assert.deepEqual(before.models.map((row) => row.id), ['deepseek/v4']);
  assert.equal(before.models[0].settlements, 1);
  await first.dispose();

  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const after = await summaryOf(second.routes);
  assert.equal(after.allTime.total, 1115, 'restart must reload the persisted day');
  assert.equal(after.allTime.settlements, 1);
  assert.equal(after.models[0].input, 100);
  await second.dispose();
});

test('activity distribution: per-project/session daily series survives restart', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const now = Date.now();
  const alpha = { id: 'act-alpha', header: { id: 'act-alpha', cwd: 'E:\\project\\alpha' } };
  const beta = { id: 'act-beta', header: { id: 'act-beta', cwd: 'E:\\project\\beta' } };
  const readActivity = async (harness) => {
    const route = harness.routes.find((entry) => entry.path === '/api/token-stats/activity');
    assert.ok(route, 'the activity route must be registered');
    return JSON.parse(await bodyOf(route, { method: 'GET' }));
  };

  const first = fakeContext();
  apply(first.ctx, { dbPath });
  await settle();
  first.emit(alpha, settlement(1, 0, usageA, now));
  first.emit(alpha, settlement(2, 0, usageA, now));
  first.emit(beta, settlement(1, 0, usageB, now));
  await settle();

  const live = await readActivity(first);
  assert.equal(live.v, 1);
  assert.equal(live.days.length, 30);
  assert.equal(live.days[29], localDayKey(now), 'the series must end on the local today');
  const alphaRow = live.workspaces.find((row) => row.title === 'alpha');
  assert.ok(alphaRow, 'the alpha workspace must appear');
  assert.equal(alphaRow.total, 2230);
  assert.equal(alphaRow.sessions, 1);
  assert.equal(alphaRow.series[29], 2230, 'today carries both settlements');
  assert.equal(alphaRow.series.reduce((sum, value) => sum + value, 0), 2230);
  const betaRow = live.workspaces.find((row) => row.title === 'beta');
  assert.equal(betaRow.total, 2227);
  assert.equal(live.workspaceTotal, 4457);
  const alphaSession = live.sessions.find((row) => row.id === 'act-alpha');
  assert.ok(alphaSession, 'the session row must appear');
  assert.equal(alphaSession.series[29], 2230);
  assert.equal(live.sessionTotal, 4457);
  assert.equal(live.sessionRequests, 3);
  await first.dispose();

  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const replayed = await readActivity(second);
  const alphaAgain = replayed.workspaces.find((row) => row.title === 'alpha');
  assert.equal(alphaAgain.series[29], 2230, 'restart must rebuild the series from the requests table');
  assert.equal(alphaAgain.total, 2230);
  await second.dispose();
});

test('activity distribution: memory-only mode still tracks the daily series', async () => {
  const dir = scratch();
  const blocked = join(dir, 'not-a-database');
  mkdirSync(blocked, { recursive: true });
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: blocked });
  await settle();
  const now = Date.now();
  const session = { id: 'mem-alpha', header: { id: 'mem-alpha', cwd: 'E:\\project\\memory' } };
  harness.emit(session, settlement(1, 0, usageA, now));
  await settle();
  const route = harness.routes.find((entry) => entry.path === '/api/token-stats/activity');
  assert.ok(route, 'the activity route must be registered without SQLite');
  const data = JSON.parse(await bodyOf(route, { method: 'GET' }));
  const row = data.workspaces.find((entry) => entry.title === 'memory');
  assert.equal(row.series[29], 1115);
  await harness.dispose();
});

test('insights route: hourly grid, daily model mix and request-size percentiles', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const recent = Date.now() - 2 * 3600 * 1000;
  const later = Date.now() - 60 * 60 * 1000;
  const session = { id: 'ins-a', header: { id: 'ins-a', cwd: 'E:\\project\\insights' } };
  harness.emit(session, { type: 'request/header', time: recent, data: { header: { config: { provider: 'deepseek', model: 'v4' } } } });
  harness.emit(session, settlement(1, 0, usageA, recent));
  harness.emit(session, { type: 'request/header', time: later, data: { header: { config: { provider: 'deepseek', model: 'v5' } } } });
  harness.emit(session, settlement(2, 0, usageB, later));
  await settle();

  const route = harness.routes.find((entry) => entry.path === '/api/token-stats/insights');
  assert.ok(route, 'the insights route must be registered');
  const data = JSON.parse(await bodyOf(route, { method: 'GET' }));
  assert.equal(data.v, 1);
  assert.equal(data.hourly.days.length, 14);
  assert.equal(data.hourly.byDay.length, 14);
  const byDayTotal = data.hourly.byDay.reduce((sum, row) => sum + row.hours.reduce((inner, value) => inner + value, 0), 0);
  assert.equal(byDayTotal, 3342, 'both settlements must land in the 14-day hour grid');
  assert.equal(data.hourly.total, 3342);
  const share = data.hourly.buckets.reduce((sum, bucket) => sum + bucket.share, 0);
  assert.ok(Math.abs(share - 1) < 1e-9, 'the four time buckets must cover the window');
  assert.equal(data.hourly.byModel.length, 2);
  assert.deepEqual(data.hourly.byModel.map((row) => row.model).sort(), ['deepseek/v4', 'deepseek/v5']);
  assert.ok(data.hourly.byDay.some((row) => row.hours.some((value) => value > 0)), 'at least one hour must carry usage');

  const legend = data.daily.models.map((row) => row.id);
  assert.ok(legend.includes('deepseek/v4'), 'the daily mix must attribute v4');
  assert.ok(legend.includes('deepseek/v5'), 'the daily mix must attribute v5');
  assert.equal(data.daily.days.length, 30);

  assert.equal(data.sizes.total, 2);
  assert.equal(data.sizes.models.length, 2);
  const v4 = data.sizes.models.find((row) => row.model === 'deepseek/v4');
  assert.equal(v4.count, 1);
  assert.equal(v4.p50, 1115);
  assert.equal(v4.p90, 1115);
  assert.equal(v4.buckets.reduce((sum, value) => sum + value, 0), 1);
  assert.ok(data.sizes.axisMax >= v4.p90);
  await harness.dispose();
});

test('same (turn, step) sample replaces instead of double counting; retry accumulates', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const session = { id: 'session-replace' };
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();

  harness.emit(session, settlement(1, 0, usageA));
  harness.emit(session, settlement(1, 0, usageB)); // replacement
  await settle();
  let data = await summaryOf(harness.routes);
  assert.equal(data.allTime.settlements, 1, 'replacement must not add a second settlement');
  assert.equal(data.allTime.input, 200);
  assert.equal(data.allTime.total, 2227);

  // A retry closes the slot, so the retried attempt accumulates.
  harness.emit(session, { type: 'llm/retry-started', time: BASE, data: { turn: 1, step: 0 } });
  harness.emit(session, settlement(1, 0, usageA));
  await settle();
  data = await summaryOf(harness.routes);
  assert.equal(data.allTime.settlements, 2);
  assert.equal(data.allTime.input, 300);

  // A usage stream chunk is read when no message-level usage exists.
  harness.emit(session, attempt(2, 0, usageA));
  await settle();
  data = await summaryOf(harness.routes);
  assert.equal(data.allTime.settlements, 3);
  await harness.dispose();
});

test('turn wall time accrues to the turn start day', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = { id: 'session-turns' };
  // The start day has to sit inside the `recent` window, which is relative to
  // "now": anchor the turn at today 23:59 so crossing midnight never drifts
  // out of the window as the calendar advances.
  const startDate = new Date();
  startDate.setHours(23, 59, 0, 0);
  const start = startDate.getTime();
  const expectedDay = [
    String(startDate.getFullYear()),
    String(startDate.getMonth() + 1).padStart(2, '0'),
    String(startDate.getDate()).padStart(2, '0'),
  ].join('-');
  const end = start + 90 * 60 * 1000; // crosses local midnight
  harness.emit(session, { type: 'turn/start', time: start, data: { turn: 7 } });
  harness.emit(session, { type: 'turn/end', time: end, data: { turn: 7 } });
  await settle();
  const data = await summaryOf(harness.routes);
  const row = data.recent.find((day) => day.date === expectedDay);
  assert.ok(row, 'the start day must be in the recent window');
  assert.equal(row.turnMs, 90 * 60 * 1000);
  assert.equal(data.stats.longestTurnMs, 90 * 60 * 1000);
  await harness.dispose();
});

test('legacy JSON store is imported once and renamed', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const legacyPath = join(dir, 'token_usage_stats.json');
  const legacy = {
    unit: { name: 'token_usage_stats', version: 1 },
    global: null,
    tables: {
      days: {
        '2026-10-19': {
          input: 500,
          output: 50,
          cacheRead: 5000,
          cacheWrite: 0,
          settlements: 4,
          turnMs: 60000,
          longestMs: 30000,
          models: { 'xiaomi/mimo': { input: 500, output: 50, cacheRead: 5000, cacheWrite: 0, settlements: 4 } },
        },
        'not-a-day': { input: 1 },
        '2026-10-18': { input: 'bad' },
      },
    },
  };
  writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8');

  const first = fakeContext();
  apply(first.ctx, { dbPath });
  await settle();
  const data = await summaryOf(first.routes);
  assert.equal(data.allTime.input, 500, 'the valid legacy day must be imported');
  assert.equal(data.allTime.settlements, 4);
  assert.ok(data.models.some((row) => row.id === 'xiaomi/mimo'));
  assert.ok(!existsSync(legacyPath), 'the legacy file must be renamed after import');
  assert.ok(existsSync(`${legacyPath}.migrated`), 'the migrated file keeps the history for the operator');
  await first.dispose();

  // A second start must not re-import (the meta flag and the rename both guard).
  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const again = await summaryOf(second.routes);
  assert.equal(again.allTime.input, 500, 'importing must not double count');
  await second.dispose();
});

test('legacy records already in SQLite win over a stale JSON copy', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const legacyPath = join(dir, 'token_usage_stats.json');

  // Build the database first, with no legacy file in sight.
  const first = fakeContext();
  apply(first.ctx, { dbPath });
  await settle();
  first.emit({ id: 's' }, settlement(1, 0, usageA, new Date(2026, 9, 19, 9, 0, 0).getTime()));
  await settle();
  await first.dispose();

  // A stale JSON copy appears afterwards, describing the same day.
  writeFileSync(legacyPath, JSON.stringify({ tables: { days: { '2026-10-19': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, settlements: 1 } } } }), 'utf8');

  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const data = await summaryOf(second.routes);
  assert.equal(data.allTime.input, 100, 'the SQLite record must not be overwritten by the import');
  assert.equal(data.allTime.settlements, 1);
  await second.dispose();
});

test('a custom dbPath never imports a profile history from another directory', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'nested', 'stats.sqlite');
  // A legacy file in the harness storage root must stay untouched: only the
  // database's own directory is a migration source.
  const homeDir = scratch();
  const storageRoot = join(homeDir, 'storages');
  mkdirSync(storageRoot, { recursive: true });
  const foreignLegacy = join(storageRoot, 'token_usage_stats.json');
  writeFileSync(foreignLegacy, JSON.stringify({ tables: { days: { '2026-10-19': { input: 999, settlements: 1 } } } }), 'utf8');

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = homeDir;
  try {
    const harness = fakeContext();
    apply(harness.ctx, { dbPath });
    await settle();
    const data = await summaryOf(harness.routes);
    assert.equal(data.allTime.input, 0, 'a custom dbPath must not adopt an unrelated profile history');
    assert.ok(existsSync(foreignLegacy), 'the foreign legacy file must be left in place');
    await harness.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('retention pruning deletes day rows past the window', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const oldTime = Date.now() - 500 * DAY;
  const first = fakeContext();
  apply(first.ctx, { dbPath, retentionDays: 400 });
  await settle();
  const session = { id: 'old' };
  first.emit(session, settlement(1, 0, usageA, oldTime));
  await settle();
  await first.dispose();

  const second = fakeContext();
  apply(second.ctx, { dbPath, retentionDays: 400 });
  await settle();
  const data = await summaryOf(second.routes);
  assert.equal(data.allTime.total, 0, 'records older than retentionDays must be pruned');
  await second.dispose();

  // The row must also be gone from the database, not just from memory.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM days').get();
  db.close();
  assert.equal(Number(rows.n), 0);
});

test('an unusable database path degrades to memory-only instead of failing', async () => {
  const dir = scratch();
  const blocker = join(dir, 'blocker');
  mkdirSync(blocker);
  const dbPath = join(blocker, 'nested', 'stats.sqlite');
  // A file where a directory must be created: mkdir fails, so the open fails.
  writeFileSync(join(dir, 'blocker', 'nested'), 'not a directory');
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const session = { id: 'mem' };
  harness.emit(session, settlement(1, 0, usageA));
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.persisted, false, 'the payload must report memory-only mode');
  assert.equal(data.allTime.input, 100, 'the fold must keep working without SQLite');
  assert.ok(harness.logs.some(([level, fmt]) => level === 'warn' && String(fmt).includes('memory-only')));
  await harness.dispose();
});

test('a database belonging to another application is refused', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA application_id = 12345');
  db.exec('CREATE TABLE foreign_table (a INTEGER) STRICT');
  db.close();

  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.persisted, false);
  assert.ok(harness.logs.some(([level, fmt]) => level === 'warn' && String(fmt).includes('sqlite unavailable')));
  await harness.dispose();
});

test(':memory: keeps statistics out of the filesystem', async () => {
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: ':memory:' });
  await settle();
  const session = { id: 'mem-db' };
  harness.emit(session, settlement(1, 0, usageA));
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.persisted, true, ':memory: is still a live database handle');
  assert.equal(data.allTime.input, 100);
  await harness.dispose();
});

test('model cardinality is capped per day while scalar totals stay correct', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = { id: 'many-models' };
  for (let index = 0; index < 30; index += 1) {
    harness.emit(session, {
      type: 'request/header',
      time: BASE,
      data: { header: { config: { provider: 'p', model: `m${index}` } } },
    });
    harness.emit(session, settlement(index, 0, usageA));
  }
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.models.length, 24, 'per-day model attribution is capped');
  assert.equal(data.allTime.settlements, 30, 'scalar totals keep every settlement');
  await harness.dispose();
});

test('the /tokenstats command renders text and --json', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const command = harness.commands.find((entry) => entry.name === 'tokenstats');
  assert.ok(command, 'the command must be registered when ctx.commands exists');
  harness.emit({ id: 'cmd' }, settlement(1, 0, usageA));
  await settle();
  const text = await command.handler({ rawInput: '' });
  assert.equal(text.kind, 'success');
  assert.ok(text.text.includes('Token 用量统计'));
  const json = await command.handler({ rawInput: '--json' });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.v, 3);
  assert.equal(parsed.allTime.input, 100);
  await harness.dispose();
});

test('an imported legacy day cannot exceed the per-day model cap', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const models = {};
  for (let index = 0; index < 30; index += 1) {
    models[`p/m${String(index).padStart(2, '0')}`] = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, settlements: 1 };
  }
  writeFileSync(join(dir, 'token_usage_stats.json'), JSON.stringify({
    tables: { days: { '2026-10-15': { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, settlements: 30, models } } },
  }), 'utf8');

  const first = fakeContext();
  apply(first.ctx, { dbPath });
  await settle();
  const firstRun = await summaryOf(first.routes);
  assert.equal(firstRun.models.length, 24, 'the import must respect the per-day attribution cap');
  assert.equal(firstRun.allTime.input, 300, 'scalars keep the whole imported day');
  await first.dispose();

  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const secondRun = await summaryOf(second.routes);
  assert.equal(secondRun.models.length, 24, 'a restart must read back the same capped attribution');
  assert.equal(secondRun.allTime.input, 300);
  await second.dispose();

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const count = db.prepare('SELECT COUNT(*) AS n FROM day_models').get();
  db.close();
  assert.equal(Number(count.n), 24, 'the database itself must not store more than the cap');
});

test('a legacy JSON file with a UTF-8 BOM still imports', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const payload = JSON.stringify({ tables: { days: { '2026-10-14': { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, settlements: 1 } } } });
  writeFileSync(join(dir, 'token_usage_stats.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload, 'utf8')]));
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.allTime.input, 7, 'a BOM must not make the legacy store unreadable');
  assert.ok(!existsSync(join(dir, 'token_usage_stats.json')), 'the migrated file must be renamed');
  await harness.dispose();
});

test('startup overflow folds merge with stored rows instead of being overwritten', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const dayTime = BASE;
  // Seed the database with 100 settlements for the same day.
  const seed = fakeContext();
  apply(seed.ctx, { dbPath });
  await settle();
  const seedSession = { id: 'seed' };
  for (let index = 0; index < 100; index += 1) seed.emit(seedSession, settlement(index, 0, usageA, dayTime));
  await settle();
  await seed.dispose();

  // Restart and synchronously emit more events than the startup buffer holds,
  // all before the asynchronous open can settle.
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  const burst = { id: 'burst' };
  const extra = 5000;
  for (let index = 0; index < extra; index += 1) harness.emit(burst, settlement(1000 + index, 0, usageA, dayTime));
  await settle();
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.allTime.settlements, 100 + extra, 'no early fold may be lost to the loaded rows');
  assert.equal(data.allTime.input, (100 + extra) * 100);
  await harness.dispose();

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT input, settlements FROM days WHERE day = ?').get('2026-10-20');
  db.close();
  assert.equal(Number(row.settlements), 100 + extra, 'the merged total must reach the database');
  assert.equal(Number(row.input), (100 + extra) * 100);
});

test('the database files stay under the configured directory only', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  harness.emit({ id: 'fs' }, settlement(1, 0, usageA));
  await settle();
  await harness.dispose();
  const names = readdirSync(dir).filter((name) => name.startsWith('stats.sqlite'));
  assert.ok(names.includes('stats.sqlite'), 'the main database file must exist');
  assert.ok(!names.some((name) => name.startsWith('token_usage_stats.json')), 'no JSON store may be written');
});

test('malformed session events are contained instead of crashing the listener', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = { id: 'malformed' };
  const badEvents = [
    { type: 'assistant/message', time: BASE, data: null },
    { type: 'turn/start', time: BASE, data: null },
    { type: 'turn/end', time: BASE, data: undefined },
    { type: 'request/header', time: BASE, data: null },
    { type: 'llm/retry-started', time: BASE, data: null },
    { type: 'assistant/message', time: BASE, data: { turn: 1, step: 0, usage: { inputTokens: Number.POSITIVE_INFINITY } } },
  ];
  for (const event of badEvents) assert.doesNotThrow(() => harness.emit(session, event));
  await settle();
  // A good event after the bad ones must still be folded.
  harness.emit(session, settlement(9, 0, usageA));
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.allTime.input, 100);
  assert.equal(data.persisted, true);
  await harness.dispose();
});

test('disposing while a flush is pending neither throws nor writes afterwards', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const session = { id: 'dispose-race' };
  // Schedule several mutations, then dispose before the chain drains.
  harness.emit(session, settlement(1, 0, usageA));
  harness.emit(session, settlement(2, 0, usageB));
  await harness.dispose();
  await settle();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT input, settlements FROM days WHERE day = ?').get('2026-10-20');
  db.close();
  assert.ok(row, 'the final flush must persist before close');
  assert.equal(Number(row.input), 300, 'both settlements must be durable');
  assert.equal(Number(row.settlements), 2);
  // Writing after dispose must be inert rather than throwing.
  assert.doesNotThrow(() => harness.emit(session, settlement(3, 0, usageA)));
  await settle();
});

test('rapid events coalesce into one consistent transaction per flush', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = { id: 'burst' };
  for (let index = 0; index < 200; index += 1) {
    harness.emit(session, settlement(index, 0, usageA));
  }
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.allTime.settlements, 200);
  assert.equal(data.allTime.input, 20000);
  await harness.dispose();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'stats.sqlite'));
  const row = db.prepare('SELECT input, settlements FROM days').get();
  db.close();
  assert.equal(Number(row.input), 20000, 'the database must agree with memory');
  assert.equal(Number(row.settlements), 200);
});

test('unmounting before the database finishes opening releases the handle', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const first = fakeContext();
  apply(first.ctx, { dbPath });
  // Dispose synchronously: the async open has not settled yet.
  await first.dispose();
  await settle();

  // A second instance must open the same file without contention, and the
  // directory must be removable afterwards, proving no lock leaked.
  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const data = await summaryOf(second.routes);
  assert.equal(data.persisted, true, 'a later instance must still open the database');
  await second.dispose();
  await settle();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  assert.ok(!existsSync(dir), 'no handle may outlive the unmount');
});

// ---- project / session / turn dimensions ----------------------------------

test('requests roll up into project, session, and turn rows with the cache split', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();

  const sessionA = sessionOf('session-a', 'E:\\project\\alpha');
  const sessionB = sessionOf('session-b', 'E:\\project\\beta');
  // Two turns in A (2 requests + 1 retried request), one turn in B.
  harness.emit(sessionA, { type: 'turn/start', time: BASE, data: { turn: 1 } });
  harness.emit(sessionA, settlement(1, 0, usageA));
  harness.emit(sessionA, settlement(1, 1, usageB));
  harness.emit(sessionA, { type: 'turn/end', time: BASE + 60000, data: { turn: 1 } });
  harness.emit(sessionB, settlement(1, 0, usageA));
  await settle();

  const data = await summaryOf(harness.routes);
  assert.equal(data.v, 3);
  assert.equal(data.requestCount, 3, 'one row per billed request');
  assert.equal(data.projects.length, 2);

  const alpha = data.projects.find((row) => row.id === 'E:\\project\\alpha');
  const beta = data.projects.find((row) => row.id === 'E:\\project\\beta');
  assert.ok(alpha && beta, 'both project directories must appear');
  assert.equal(alpha.title, 'alpha', 'the project title is the final path segment');
  assert.equal(alpha.sessions, 1);
  assert.equal(alpha.requests, 2);
  // usageA = in 100 / out 10 / cacheRead 1000 / cacheWrite 5, usageB = 200/20/2000/7
  assert.equal(alpha.input, 300, 'input is the uncached input');
  assert.equal(alpha.cacheRead, 3000, 'cacheRead is the cached input');
  assert.equal(alpha.cacheWrite, 12);
  assert.equal(alpha.output, 30);
  assert.equal(alpha.total, 300 + 3000 + 12 + 30);
  assert.equal(beta.requests, 1);
  assert.equal(beta.input, 100);

  const sessionRow = data.sessions.find((row) => row.id === 'session-a');
  assert.ok(sessionRow, 'the session must appear in the summary');
  assert.equal(sessionRow.project, 'E:\\project\\alpha');
  assert.equal(sessionRow.projectTitle, 'alpha');
  assert.equal(sessionRow.requests, 2);
  assert.equal(sessionRow.total, alpha.total);

  const turnRow = data.turns.find((row) => row.sessionId === 'session-a' && row.turn === 1);
  assert.ok(turnRow, 'the turn must appear in the summary');
  assert.equal(turnRow.requests, 2);
  assert.equal(turnRow.durationMs, 60000);
  assert.equal(turnRow.projectTitle, 'alpha');
  await harness.dispose();
});

test('a same-slot replacement overwrites its request row instead of adding one', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = sessionOf('replace', 'E:\\project\\one');
  harness.emit(session, settlement(1, 0, usageA));
  harness.emit(session, settlement(1, 0, usageB)); // replacement
  await settle();
  let data = await summaryOf(harness.routes);
  assert.equal(data.requestCount, 1, 'a replacement must not add a second request');
  assert.equal(data.projects[0].input, 200);
  assert.equal(data.projects[0].cacheRead, 2000);

  // A retry closes the slot, so the retried attempt adds a request.
  harness.emit(session, { type: 'llm/retry-started', time: BASE, data: { turn: 1, step: 0 } });
  harness.emit(session, settlement(1, 0, usageA));
  await settle();
  data = await summaryOf(harness.routes);
  assert.equal(data.requestCount, 2, 'a retry adds one billed request');
  assert.equal(data.projects[0].input, 300);
  assert.equal(data.projects[0].requests, 2);
  await harness.dispose();
});

test('dimensions survive a restart without drift', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const first = fakeContext();
  apply(first.ctx, { dbPath });
  await settle();
  const session = sessionOf('durable', 'E:\\project\\durable');
  first.emit(session, settlement(1, 0, usageA));
  first.emit(session, settlement(1, 1, usageB));
  await settle();
  const before = await summaryOf(first.routes);
  await first.dispose();

  const second = fakeContext();
  apply(second.ctx, { dbPath });
  await settle();
  const after = await summaryOf(second.routes);
  assert.deepEqual(after.projects, before.projects, 'project rows must reload exactly');
  assert.deepEqual(after.sessions, before.sessions, 'session rows must reload exactly');
  assert.deepEqual(after.turns, before.turns, 'turn rows must reload exactly');
  assert.equal(after.requestCount, 2);
  await second.dispose();

  // Reopening twice more must not double count (the request table is the truth).
  const third = fakeContext();
  apply(third.ctx, { dbPath });
  await settle();
  const again = await summaryOf(third.routes);
  assert.equal(again.requestCount, 2, 'reopening must not duplicate request rows');
  assert.equal(again.projects[0].input, 300);
  await third.dispose();
});

test('the breakdown route slices by dimension with filters and limits', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const alpha = sessionOf('a1', 'E:\\project\\alpha');
  const alpha2 = sessionOf('a2', 'E:\\project\\alpha');
  const beta = sessionOf('b1', 'E:\\project\\beta');
  harness.emit(alpha, settlement(1, 0, usageB));
  harness.emit(alpha2, settlement(1, 0, usageA));
  harness.emit(beta, settlement(1, 0, usageA));
  harness.emit(beta, settlement(2, 0, usageA));
  await settle();

  const byProject = await breakdownOf(harness.routes, { by: 'project' });
  assert.equal(byProject.by, 'project');
  assert.equal(byProject.rows.length, 2);
  assert.equal(byProject.totals.requests, 4);
  assert.equal(byProject.totals.total, 2227 + 1115 + 1115 + 1115);

  const bySession = await breakdownOf(harness.routes, { by: 'session', project: 'E:\\project\\alpha' });
  assert.equal(bySession.rows.length, 2, 'the project filter narrows sessions');
  assert.ok(bySession.rows.every((row) => row.project === 'E:\\project\\alpha'));
  assert.equal(bySession.totals.requests, 2);

  const byTurn = await breakdownOf(harness.routes, { by: 'turn', session: 'b1' });
  assert.equal(byTurn.rows.length, 2, 'the session filter narrows turns');
  assert.deepEqual(byTurn.rows.map((row) => row.turn).sort(), [1, 2]);

  const limited = await breakdownOf(harness.routes, { by: 'project', limit: 1 });
  assert.equal(limited.rows.length, 1, 'limit caps the row count');
  assert.equal(limited.totals.requests, 4, 'totals still describe the whole filtered set');

  const rejected = await invoke(harness.routes, '/api/token-stats/breakdown', {
    method: 'GET',
    url: '/api/token-stats/breakdown?by=nonsense',
  });
  assert.equal(rejected.status, 400, 'an unknown dimension is rejected');
  assert.ok(JSON.parse(rejected.body).error.includes('by'));
  await harness.dispose();
});

test('a session title event labels the session row', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = sessionOf('titled', 'E:\\project\\titled');
  harness.emit(session, settlement(1, 0, usageA));
  harness.emit(session, { type: 'session/title', time: BASE + 1000, data: { title: 'Fix the parser', source: { kind: 'fallback' }, messageSeqs: [1] } });
  await settle();
  const data = await summaryOf(harness.routes);
  const row = data.sessions.find((entry) => entry.id === 'titled');
  assert.equal(row.title, 'Fix the parser', 'the logged title must label the session');
  const turn = data.turns.find((entry) => entry.sessionId === 'titled');
  assert.equal(turn.sessionTitle, 'Fix the parser', 'turn rows inherit the session title');
  await harness.dispose();

  // The title must also survive a restart.
  const second = fakeContext();
  apply(second.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const reloaded = await summaryOf(second.routes);
  assert.equal(reloaded.sessions.find((entry) => entry.id === 'titled').title, 'Fix the parser');
  await second.dispose();
});

test('a session without a cwd falls into the unknown project', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  harness.emit({ id: 'no-cwd', header: { id: 'no-cwd' } }, settlement(1, 0, usageA));
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].id, 'unknown');
  assert.equal(data.projects[0].title, 'unknown');
  assert.equal(data.sessions[0].project, 'unknown');
  await harness.dispose();
});

test('pruning a day also deletes its request rows, aggregates, and empty identities', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const oldTime = Date.now() - 500 * DAY;
  const first = fakeContext();
  apply(first.ctx, { dbPath, retentionDays: 400 });
  await settle();
  const session = sessionOf('old', 'E:\\project\\old');
  first.emit(session, settlement(1, 0, usageA, oldTime));
  await settle();
  // The day is already outside the retention window, so the very next flush
  // prunes it: no stale project/session/turn row may survive in the summary.
  const before = await summaryOf(first.routes);
  assert.equal(before.requestCount, 0, 'an out-of-window request must not linger in memory');
  assert.equal(before.allTime.total, 0);
  assert.deepEqual(before.projects, [], 'no zero-token project may remain after pruning');
  assert.deepEqual(before.sessions, []);
  assert.deepEqual(before.turns, []);
  await first.dispose();

  const second = fakeContext();
  apply(second.ctx, { dbPath, retentionDays: 400 });
  await settle();
  const data = await summaryOf(second.routes);
  assert.equal(data.requestCount, 0, 'pruned days must drop their request rows');
  assert.equal(data.allTime.total, 0);
  assert.deepEqual(data.projects, [], 'a restart must not resurrect a pruned project');
  await second.dispose();

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const requests = db.prepare('SELECT COUNT(*) AS n FROM requests').get();
  const days = db.prepare('SELECT COUNT(*) AS n FROM days').get();
  const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
  db.close();
  assert.equal(Number(requests.n), 0);
  assert.equal(Number(days.n), 0);
  assert.equal(Number(projects.n), 0, 'the identity row must be deleted with its last request');
});

test('a live turn with timing but no usage is never pruned away', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite'), retentionDays: 400 });
  await settle();
  const session = sessionOf('live-turn', 'E:\\project\\live');
  const recent = Date.now() - 60_000;
  harness.emit(session, { type: 'turn/start', time: recent, data: { turn: 1 } });
  harness.emit(session, { type: 'turn/end', time: recent + 5000, data: { turn: 1 } });
  await settle();
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.turns.length, 1, 'a turn that only has timing must survive the prune');
  assert.equal(data.turns[0].turn, 1);
  assert.equal(data.turns[0].durationMs, 5000);
  assert.equal(data.projects.length, 1, 'its project identity must survive too');
  await harness.dispose();
});

test('a malformed settlement cannot wedge persistence (D1 regression)', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const session = sessionOf('bad-events', 'E:\\project\\bad');
  // Every shape that used to reach a STRICT bind and poison the flush batch.
  const malformed = [
    { type: 'assistant/message', time: BASE, data: { step: 0, usage: usageA } },              // no turn
    { type: 'assistant/message', time: BASE, data: { turn: null, step: 0, usage: usageA } },
    { type: 'assistant/message', time: BASE, data: { turn: 1.5, step: 0, usage: usageA } },
    { type: 'assistant/message', time: BASE, data: { turn: 1, step: null, usage: usageA } },
    { type: 'assistant/message', time: null, data: { turn: 1, step: 0, usage: usageA } },
    { type: 'assistant/message', time: 'now', data: { turn: 1, step: 0, usage: usageA } },
    { type: 'assistant/message', data: { turn: 1, step: 0, usage: usageA } },
    { type: 'turn/start', time: BASE, data: { turn: null } },
    { type: 'turn/start', time: BASE, data: null },
    { type: 'turn/end', time: BASE, data: { turn: 'x' } },
    { type: 'session/title', time: null, data: { title: 'bad time' } },
  ];
  for (const event of malformed) assert.doesNotThrow(() => harness.emit(session, event));
  await settle();
  // Ten valid settlements AFTER the malformed ones must still persist.
  for (let index = 0; index < 10; index += 1) harness.emit(session, settlement(100 + index, 0, usageA));
  await settle();
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.requestCount, 10, 'valid events after malformed ones must still be recorded');
  // Four malformed events above still carried a usable BASE time, so they are
  // real billed samples for the day totals — just not attributable to a
  // conversation. (The ones with a null/'now'/missing time are dropped.)
  assert.equal(data.allTime.input, 14 * 100, 'day totals keep every timed sample');
  await harness.dispose();

  // The durable side must agree: a restart may not reveal a split brain.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const requestRows = db.prepare('SELECT COUNT(*) AS n FROM requests').get();
  const dayRows = db.prepare('SELECT COUNT(*) AS n FROM days').get();
  db.close();
  assert.equal(Number(requestRows.n), 10, 'the request rows must have reached SQLite');
  assert.ok(Number(dayRows.n) >= 1, 'the day row must have reached SQLite');

  const restarted = fakeContext();
  apply(restarted.ctx, { dbPath });
  await settle();
  const after = await summaryOf(restarted.routes);
  assert.equal(after.requestCount, 10, 'a restart must not lose the persisted requests');
  assert.equal(after.allTime.total, 14 * 1115, 'the restart must agree with the live day totals');
  await restarted.dispose();
});

test('malformed events never reach the flush (no persist warning is emitted)', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = sessionOf('quiet', 'E:\\project\\quiet');
  const malformed = [
    { type: 'assistant/message', time: BASE, data: { step: 0, usage: usageA } },
    { type: 'assistant/message', time: null, data: { turn: 1, step: 0, usage: usageA } },
    { type: 'assistant/message', time: BASE, data: { turn: 1.5, step: 0, usage: usageA } },
    { type: 'turn/start', time: BASE, data: { turn: null } },
    { type: 'turn/end', time: BASE, data: { turn: 'x' } },
    { type: 'session/title', time: null, data: { title: 'bad' } },
  ];
  for (const event of malformed) harness.emit(session, event);
  await settle();
  await settle();
  // Rejected events are filtered before any SQL bind, so persistence never
  // fails and no "persist failed" warning is logged.
  const persistWarnings = harness.logs.filter(([level, fmt]) => level === 'warn' && String(fmt).includes('persist failed'));
  assert.deepEqual(persistWarnings, [], 'a malformed event must not surface as a persist failure');
  const data = await summaryOf(harness.routes);
  assert.equal(data.persisted, true, 'the database must stay healthy');
  await harness.dispose();
});

test('the turn cap never evicts an aggregated turn (D2 regression)', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = sessionOf('many-turns', 'E:\\project\\many');
  // Far more turns than the in-memory cap, every one with usage.
  const total = 600;
  for (let index = 0; index < total; index += 1) {
    harness.emit(session, settlement(index, 0, usageA, BASE + index * 1000));
  }
  await settle();
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.requestCount, total, 'every request must be recorded');
  const turnTotals = data.turns.reduce((sum, row) => sum + row.requests, 0);
  assert.ok(turnTotals > 0, 'the summary must carry turn rows');
  const breakdown = await breakdownOf(harness.routes, { by: 'turn', limit: 500 });
  assert.equal(breakdown.totals.requests, total, 'by=turn must not under-report after eviction');
  await harness.dispose();

  const restarted = fakeContext();
  apply(restarted.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const after = await breakdownOf(restarted.routes, { by: 'turn', limit: 500 });
  assert.equal(after.totals.requests, total, 'a restart must rebuild every turn row');
});

test('startup overflow keeps dimension aggregates consistent with day totals (D3 regression)', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  // Seed one settlement so the database exists and loads a day.
  const seed = fakeContext();
  apply(seed.ctx, { dbPath });
  await settle();
  seed.emit(sessionOf('seed', 'E:\\project\\burst'), settlement(1, 0, usageA));
  await settle();
  await seed.dispose();

  // Restart and burst synchronously before the async open can settle.
  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  const session = sessionOf('burst', 'E:\\project\\burst');
  const burst = 5000;
  for (let index = 0; index < burst; index += 1) harness.emit(session, settlement(1000 + index, 0, usageA));
  await settle();
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.requestCount, 1 + burst, 'no early fold may be lost from the dimensions');
  assert.equal(data.allTime.settlements, 1 + burst, 'the legacy day totals stay correct');
  const projectSum = data.projects.reduce((sum, row) => sum + row.requests, 0);
  assert.equal(projectSum, data.requestCount, 'project aggregates must agree with requestCount');
  assert.equal(data.allTime.input, (1 + burst) * 100);
  await harness.dispose();
});

test('aggregate spans follow a replacement to an earlier timestamp (D4 regression)', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const session = sessionOf('span', 'E:\\project\\span');
  const late = BASE + 100000;
  const early = BASE + 1000;
  harness.emit(session, settlement(1, 0, usageA, late));
  harness.emit(session, settlement(1, 0, usageB, early)); // replacement, earlier ts
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.requestCount, 1, 'the replacement collapsed into one row');
  const project = data.projects[0];
  assert.equal(project.firstTs, early, 'the span must move to the replacement timestamp');
  assert.equal(project.lastTs, early, 'a single-row identity spans exactly its one timestamp');
  assert.ok(project.lastTs <= late, 'the stale wider bound must be gone');
  await harness.dispose();

  const restarted = fakeContext();
  apply(restarted.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const after = await summaryOf(restarted.routes);
  assert.equal(after.projects[0].lastTs, early, 'the corrected span must persist');
});

test('the breakdown route rejects malformed limits and over-long filters', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  for (const query of ['limit=0', 'limit=abc', 'limit=-3', `session=${'x'.repeat(300)}`]) {
    const result = await invoke(harness.routes, '/api/token-stats/breakdown', {
      method: 'GET',
      url: `/api/token-stats/breakdown?by=turn&${query}`,
    });
    assert.equal(result.status, 400, `query '${query}' must be rejected`);
  }
  const huge = await breakdownOf(harness.routes, { by: 'project', limit: 99999 });
  assert.equal(huge.by, 'project', 'an oversized limit is clamped, not rejected');
  await harness.dispose();
});

test('a head request returns no body on the breakdown route', async () => {
  const dir = scratch();
  const harness = fakeContext();
  apply(harness.ctx, { dbPath: join(dir, 'stats.sqlite') });
  await settle();
  const result = await invoke(harness.routes, '/api/token-stats/breakdown', { method: 'HEAD', url: '/api/token-stats/breakdown?by=project' });
  assert.equal(result.status, 200);
  assert.equal(result.body, '', 'HEAD must not write a body');
  const rejected = await invoke(harness.routes, '/api/token-stats/breakdown', { method: 'POST' });
  assert.equal(rejected.status, 405);
  await harness.dispose();
});

test('a v1 database upgrades in place and keeps its day records', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const APPLICATION_ID = 0x54555331;
  // Build exactly what the previous release wrote: user_version 1, two tables.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  legacy.exec('PRAGMA user_version = 1');
  legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
  legacy.exec('CREATE TABLE days (day TEXT PRIMARY KEY, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, settlements INTEGER NOT NULL DEFAULT 0, turn_ms INTEGER NOT NULL DEFAULT 0, longest_ms INTEGER NOT NULL DEFAULT 0) STRICT');
  legacy.exec('CREATE TABLE day_models (day TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, settlements INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, model)) STRICT');
  legacy.prepare('INSERT INTO days VALUES (?,?,?,?,?,?,?,?)').run('2026-10-20', 100, 10, 1000, 5, 1, 5000, 5000);
  legacy.close();

  const harness = fakeContext();
  apply(harness.ctx, { dbPath });
  await settle();
  const data = await summaryOf(harness.routes);
  assert.equal(data.v, 3);
  assert.equal(data.allTime.total, 1115, 'the v1 day record must survive the upgrade');
  assert.equal(data.requestCount, 0, 'the v1 schema has no request rows to invent');
  assert.equal(data.persisted, true);
  await harness.dispose();

  const upgraded = new DatabaseSync(dbPath);
  assert.equal(Number(upgraded.prepare('PRAGMA user_version').get().user_version), 2, 'the schema version must advance');
  const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map((row) => row.name);
  for (const name of ['projects', 'sessions', 'turns', 'requests', 'days', 'day_models', 'meta']) {
    assert.ok(tables.includes(name), `table '${name}' must exist after the upgrade`);
  }
  upgraded.close();
});

/**
 * Poll until a predicate holds; the historical replay runs in the background,
 * so its completion has to be awaited rather than assumed.
 */
async function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the plugin to catch up');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('historical session logs are replayed into the statistics', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const sessionsDir = join(dir, 'sessions');
  writeSessionLog(sessionsDir, {
    id: 'hist-1',
    cwd: 'E:\\project\\demo',
    records: [
      requestHeader('deepseek', 'v4', BASE),
      turnStart(1, BASE),
      assistantMessage(1, 0, usageA, BASE + 1000),
      assistantMessage(1, 1, usageB, BASE + 2000),
      turnEnd(1, BASE + 65000),
      sessionTitle('历史会话', BASE + 70000),
    ],
  });

  const harness = fakeContext();
  apply(harness.ctx, { dbPath, sessionsDir, backfillHistory: true });
  await waitFor(async () => (await summaryOf(harness.routes)).allTime.total > 0);
  const data = await summaryOf(harness.routes);
  assert.equal(data.allTime.total, 1115 + 2227, 'both settlements must be counted');
  assert.equal(data.allTime.settlements, 2);
  const session = data.sessions.find((row) => row.id === 'hist-1');
  assert.ok(session, 'the historical session must appear in the session dimension');
  assert.equal(session.title, '历史会话');
  assert.equal(session.projectTitle, 'demo');
  assert.equal(session.total, 1115 + 2227);
  assert.equal(data.projects.some((row) => row.id === 'E:\\project\\demo'), true);
  assert.equal(data.models[0].id, 'deepseek/v4', 'the replayed request header drives model attribution');

  const turns = await breakdownOf(harness.routes, { by: 'turn', session: 'hist-1' });
  assert.equal(turns.rows.length, 1);
  assert.equal(turns.rows[0].durationMs, 65000, 'turn timing comes from the replayed turn boundaries');
  assert.equal(turns.rows[0].total, 1115 + 2227);

  // A restart must not replay the same session again: its row is already there.
  await harness.dispose();
  const second = fakeContext();
  apply(second.ctx, { dbPath, sessionsDir, backfillHistory: true });
  await waitFor(async () => (await summaryOf(second.routes)).allTime.total > 0);
  await settle();
  const again = await summaryOf(second.routes);
  assert.equal(again.allTime.total, 1115 + 2227, 'replaying a known session would double count');
  await second.dispose();
});

test('a session the listener recorded live is never replayed twice', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const sessionsDir = join(dir, 'sessions');

  // First run: the live listener records the session (and persists it).
  const first = fakeContext();
  apply(first.ctx, { dbPath, sessionsDir, backfillHistory: true }); // empty root
  await settle();
  first.emit(sessionOf('session-live'), settlement(1, 0, usageA));
  await settle();
  await first.dispose();

  // The Host's log for that same session shows up afterwards.
  writeSessionLog(sessionsDir, { id: 'session-live', records: [assistantMessage(1, 0, usageA, BASE)] });

  const second = fakeContext();
  apply(second.ctx, { dbPath, sessionsDir, backfillHistory: true });
  await waitFor(async () => (await summaryOf(second.routes)).allTime.total > 0);
  await settle();
  const data = await summaryOf(second.routes);
  assert.equal(data.allTime.total, 1115, 'the recorded session must be skipped by the replay');
  await second.dispose();
});

test('backfillHistory: false leaves the session logs alone', async () => {
  const dir = scratch();
  const dbPath = join(dir, 'stats.sqlite');
  const sessionsDir = join(dir, 'sessions');
  writeSessionLog(sessionsDir, { id: 'ignored', records: [assistantMessage(1, 0, usageA, BASE)] });

  const harness = fakeContext();
  apply(harness.ctx, { dbPath, sessionsDir, backfillHistory: false });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const data = await summaryOf(harness.routes);
  assert.equal(data.allTime.total, 0, 'the replay must not run when disabled');
  await harness.dispose();
});
