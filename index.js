/**
 * dsh-token-usage-stats — Host half of the bundle (v2 dashboard edition).
 *
 * Aggregates provider-reported token usage across every session of this
 * profile into local-calendar-day records and serves a full statistics
 * payload (summary cards, activity heatmap, trend, per-model usage) to the
 * Client over a small same-origin HTTP route, plus a `/tokenstats` command.
 *
 * Data source and fold semantics:
 *   - `session/event` publishes every LIVE committed session event; seed
 *     (resumed/fork-inherited) history never publishes, so replays cannot
 *     double-count.
 *   - Historical usage the live listener never saw (the plugin was installed
 *     later, or the profile ran without it) is replayed once from the Host's
 *     own session logs under `$DSH_HOME/sessions` (`history.js`). A session
 *     already present in `sessions` is skipped, so a replay can never double
 *     count a session the listener recorded.
 *   - Each durable Assistant settlement (`assistant/message`, or
 *     `assistant/attempt` when no message assembled) contributes the last
 *     usage sample it reports — `event.data.usage`, else the final `usage`
 *     stream chunk. Within one (turn, step) attempt slot a new sample
 *     REPLACES the previous one; `llm/retry-started` closes the slot so a
 *     retried attempt adds on top. This mirrors the fold of the shipped
 *     `@deepseek-ai/dsh-token-meter` `tokenUsage` projection.
 *   - Samples are bucketed by the host's LOCAL calendar day of the commit
 *     time (`event.time`), and attributed to the latest `request/header`
 *     provider/model of the same session for the per-model breakdown.
 *   - `turn/start` → `turn/end` wall time accrues to the turn's START day
 *     (`turnMs` summed, `longestMs` maximal) for the longest-chat card.
 *
 * Persistence: one embedded SQLite database, written through Node's built-in
 * `node:sqlite` (`DatabaseSync`) with zero npm dependencies. The file lives
 * at `$DSH_HOME/storages/token_usage_stats.sqlite` (default
 * `~/.dsh/storages/token_usage_stats.sqlite`); `dbPath` overrides it. Schema:
 * one `days` row per local calendar day (`YYYY-MM-DD` primary key) and one
 * `day_models` row per (day, provider/model). Every coalesced flush writes
 * its dirty days in a single WAL transaction, so a crash never leaves a
 * half-written day. The previous release stored the same records in
 * `storages/token_usage_stats.json` through the storage domain; that file is
 * imported once on first open and renamed to `*.migrated`.
 *
 * If the SQLite binding is unavailable (or the file cannot be opened), the
 * bundle degrades to memory-only statistics instead of failing: the fold,
 * HTTP route, and command all keep working, and the payload reports
 * `persisted: false`.
 *
 * Optional services degrade instead of failing the bundle: the fold and the
 * HTTP route require `webServer` (declared `inject`); the slash command
 * mounts only when `commands` is present.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { listSessionLogs, readHeader, readSessionRecords, supportsZstd } from './history.js';

const SERVICE_ROUTE = '/api/token-stats';
const BREAKDOWN_ROUTE = '/api/token-stats/breakdown';
const ACTIVITY_ROUTE = '/api/token-stats/activity';
const INSIGHTS_ROUTE = '/api/token-stats/insights';
const DB_FILE_NAME = 'token_usage_stats.sqlite';
const LEGACY_JSON_FILE_NAME = 'token_usage_stats.json';
const SCHEMA_VERSION = 2;
/** "TUS1" — protects unrelated databases from being opened as ours. */
const APPLICATION_ID = 0x54555331;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEATMAP_DAYS = 365;
const TREND_DAYS = 30;
/** Day columns carried by the workspace-activity distribution. */
const ACTIVITY_DAYS = 30;
/** Rows the activity route returns per dimension (client sorts/filters them). */
const ACTIVITY_SESSION_ROWS = 80;
/** How long per-day project/session buckets stay resident before pruning. */
const ACTIVITY_RETENTION_DAYS = 90;
/** Rows of the hour x day activity grid. */
const HOURLY_DAYS = 14;
/** Days of the per-model daily usage chart. */
const DAILY_MODEL_DAYS = 30;
/** Requests-size distribution: models shown and histogram buckets. */
const SIZE_MODELS = 8;
const SIZE_BUCKETS = 40;
/** Request samples feeding the size distribution (and the retention bound). */
const SIZE_WINDOW_DAYS = 90;
const MAX_MODELS_PER_DAY = 24;
const UNKNOWN_MODEL = 'unknown';
const UNKNOWN_PROJECT = 'unknown';
const MAX_MODEL_ID_LENGTH = 160;
const MAX_PROJECT_ID_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 200;
const MAX_SESSION_TITLE_LENGTH = 200;
/** Events buffered while the database opens; the cap only warns, never drops. */
const MAX_PENDING_EVENTS = 200000;
/** Consecutive flush failures before a poison batch is dropped (self-heal). */
const MAX_FLUSH_FAILURES = 3;
/** Turn aggregates kept in memory before request-less rows are evicted. */
const MAX_TRACKED_TURNS = 50000;
/** Bounded in-memory turn detail kept for drill-down (oldest evicted first). */
const MAX_BREAKDOWN_LIMIT = 500;
const DEFAULT_BREAKDOWN_LIMIT = 50;
const SUMMARY_SESSION_ROWS = 20;
const SUMMARY_TURN_ROWS = 30;

/** Request bucket fields: `input` is UNCACHED input, `cacheRead` is cached input. */
const REQUEST_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

/** Scalar buckets kept per day; `settlements` counts billed attempts. */
const DAY_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'settlements', 'turnMs', 'longestMs'];

/** Per-model bucket fields (no timing). */
const MODEL_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'settlements'];

/** One zeroed day record. */
function zeroDay() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, settlements: 0, turnMs: 0, longestMs: 0, models: {} };
}

/** One zeroed per-model bucket. */
function zeroModel() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, settlements: 0 };
}

/** One zeroed request bucket (cached/uncached input split, output, reasoning). */
function zeroRequest() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 };
}

/** One zeroed project aggregate: identity, span, and its request bucket. */
function zeroProject(id) {
  return { id, title: id, firstTs: null, lastTs: null, bucket: zeroRequest() };
}

/** One zeroed session aggregate: identity, owning project, span, bucket. */
function zeroSession(id) {
  return { id, projectId: UNKNOWN_PROJECT, title: null, parentId: null, firstTs: null, lastTs: null, bucket: zeroRequest() };
}

/** One zeroed turn aggregate: identity, owning session, span, bucket. */
function zeroTurn(sessionId, projectId, turn) {
  return { sessionId, projectId, turn, startTs: null, endTs: null, bucket: zeroRequest() };
}

/** Extend a record's observed time span with one epoch-ms timestamp. */
function spanOf(record, ts) {
  if (record.firstTs === null || ts < record.firstTs) record.firstTs = ts;
  if (record.lastTs === null || ts > record.lastTs) record.lastTs = ts;
}

/** Stable map key for one (session, turn) pair. */
function turnKeyOf(sessionId, turn) {
  return `${sessionId}\u0000${String(turn)}`;
}

/**
 * Coerce an untrusted turn/step number to a non-negative safe integer.
 * @param {unknown} value - the event payload field.
 * @returns {number|null} the number, or null when it is unusable.
 */
function safeIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Coerce an untrusted event time to a usable epoch-ms number.
 * @param {unknown} value - the event's `time` field.
 * @returns {number|null} the time, or null when it cannot key a local day.
 */
function safeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse and validate the breakdown route's query string.
 * @param {string|undefined} url - the raw request URL.
 * @returns {[('project'|'session'|'turn'), { project?: string, session?: string, limit: number }]}
 * @throws {Error} when a parameter is malformed.
 */
function parseBreakdownQuery(url) {
  const params = new URL(url ?? '/', 'http://localhost').searchParams;
  const by = params.get('by') ?? 'project';
  if (by !== 'project' && by !== 'session' && by !== 'turn') throw new Error(`unsupported 'by' value: ${by}`);
  const rawLimit = params.get('limit');
  let limit = DEFAULT_BREAKDOWN_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`'limit' must be a positive integer`);
    limit = Math.min(MAX_BREAKDOWN_LIMIT, parsed);
  }
  const query = { limit };
  const project = params.get('project');
  if (project !== null && project.length > 0) {
    if (project.length > MAX_PROJECT_ID_LENGTH) throw new Error(`'project' is too long`);
    query.project = project;
  }
  const session = params.get('session');
  if (session !== null && session.length > 0) {
    if (session.length > MAX_SESSION_ID_LENGTH) throw new Error(`'session' is too long`);
    query.session = session;
  }
  return [by, query];
}

/** Clamp an untrusted provider number to a non-negative safe integer. */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value))) : 0;
}

/** Validate one stored per-model bucket; throws on malformed input. */
function parseModelBuckets(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('model buckets must be a plain object');
  const out = zeroModel();
  for (const field of MODEL_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (raw)[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`model bucket field '${field}' must be a non-negative safe integer`);
    out[field] = value;
  }
  return out;
}

/**
 * Validate and normalize one stored day record. Used for rows read back from
 * SQLite and for records imported from the v1 JSON store. The `models` map is
 * best-effort: a malformed map or entry is dropped instead of failing the
 * whole record, because scalars remain a valid v1 record.
 * @param {unknown} raw - the stored record.
 * @returns {ReturnType<typeof zeroDay>}
 * @throws {Error} when the scalar fields are malformed.
 */
function parseDayRecord(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('day record must be a plain object');
  const day = zeroDay();
  for (const field of DAY_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (raw)[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`day record field '${field}' must be a non-negative safe integer`);
    day[field] = value;
  }
  const models = /** @type {Record<string, unknown>} */ (raw).models;
  if (typeof models === 'object' && models !== null && !Array.isArray(models)) {
    for (const [id, buckets] of Object.entries(models)) {
      if (Object.keys(day.models).length >= MAX_MODELS_PER_DAY) break;
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) continue;
      try {
        day.models[id] = parseModelBuckets(buckets);
      } catch {
        // Best-effort: skip a malformed model entry, keep the rest.
      }
    }
  }
  return day;
}

/** Local calendar day key `YYYY-MM-DD` for one epoch-ms commit time. */
function dayKeyOf(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** Parse a `YYYY-MM-DD` key into a local-midnight Date. */
function dateOfDayKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** The next local day key after `key`. */
function nextDayKey(key) {
  return dayKeyOf(dateOfDayKey(key).getTime() + 86400000);
}

/** The Monday-start local week key (its `YYYY-MM-DD` of the first day). */
function weekStartKeyOf(now) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (date.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  date.setDate(date.getDate() - offset);
  return dayKeyOf(date.getTime());
}

/** The local month-start key `YYYY-MM-DD`. */
function monthStartKeyOf(now) {
  return dayKeyOf(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
}

/** Scalar sum of one usage sample (settlements counted by the caller). */
function bucketsOfUsage(usage) {
  return {
    input: countOf(usage.inputTokens),
    output: countOf(usage.outputTokens),
    cacheRead: countOf(usage.cacheReadTokens),
    cacheWrite: countOf(usage.cacheWriteTokens),
  };
}

/**
 * The richer per-request bucket of one usage sample. `input` stays the
 * provider's UNCACHED input (its `inputTokens`), `cacheRead` is the cached
 * input that was reused, `cacheWrite` the cache that was written, and
 * `reasoning` the reasoning share of the output when reported.
 * @param {object} usage - one provider usage sample.
 */
function requestBucketOf(usage) {
  return {
    input: countOf(usage.inputTokens),
    cacheRead: countOf(usage.cacheReadTokens),
    cacheWrite: countOf(usage.cacheWriteTokens),
    output: countOf(usage.outputTokens),
    reasoning: countOf(usage.reasoningTokens),
  };
}

/** Sum two request buckets. */
function addRequestBuckets(a, b) {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    requests: a.requests + b.requests,
  };
}

/** Subtract one request bucket from another, clamping at zero. */
function subtractRequestBuckets(a, b) {
  return {
    input: Math.max(0, a.input - b.input),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
    requests: Math.max(0, a.requests - b.requests),
  };
}

/** Two request buckets identical? (Same-slot replacement collapses to no-op.) */
function sameRequestBuckets(a, b) {
  return a.input === b.input && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
    && a.output === b.output && a.reasoning === b.reasoning;
}

/** Two samples identical? (Same-slot replacement collapses to no-op.) */
function sameBuckets(a, b) {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/** The label a settlement is attributed to, from the latest request header. */
function modelLabelOf(header) {
  if (header === undefined) return UNKNOWN_MODEL;
  const provider = typeof header.provider === 'string' ? header.provider : '';
  const model = typeof header.model === 'string' ? header.model : '';
  if (provider && model) return `${provider}/${model}`;
  return model || provider || UNKNOWN_MODEL;
}

/** Add one sample's buckets to a day record (immutable), incl. model map. */
function addSample(day, buckets, modelId) {
  const models = { ...day.models };
  const model = { ...(models[modelId] ?? zeroModel()) };
  model.input += buckets.input;
  model.output += buckets.output;
  model.cacheRead += buckets.cacheRead;
  model.cacheWrite += buckets.cacheWrite;
  model.settlements += 1;
  if (models[modelId] === undefined && Object.keys(models).length >= MAX_MODELS_PER_DAY) {
    // Cap cardinality: scalar totals stay correct, attribution is dropped.
  } else {
    models[modelId] = model;
  }
  return {
    input: day.input + buckets.input,
    output: day.output + buckets.output,
    cacheRead: day.cacheRead + buckets.cacheRead,
    cacheWrite: day.cacheWrite + buckets.cacheWrite,
    settlements: day.settlements + 1,
    turnMs: day.turnMs,
    longestMs: day.longestMs,
    models,
  };
}

/** Remove one previous sample's buckets from a day record (replacement). */
function removeSample(day, buckets, modelId) {
  const models = { ...day.models };
  const existing = models[modelId];
  if (existing !== undefined) {
    const model = {
      input: Math.max(0, existing.input - buckets.input),
      output: Math.max(0, existing.output - buckets.output),
      cacheRead: Math.max(0, existing.cacheRead - buckets.cacheRead),
      cacheWrite: Math.max(0, existing.cacheWrite - buckets.cacheWrite),
      settlements: Math.max(0, existing.settlements - 1),
    };
    if (model.settlements === 0) delete models[modelId];
    else models[modelId] = model;
  }
  return {
    input: Math.max(0, day.input - buckets.input),
    output: Math.max(0, day.output - buckets.output),
    cacheRead: Math.max(0, day.cacheRead - buckets.cacheRead),
    cacheWrite: Math.max(0, day.cacheWrite - buckets.cacheWrite),
    settlements: Math.max(0, day.settlements - 1),
    turnMs: day.turnMs,
    longestMs: day.longestMs,
    models,
  };
}

/** The last usage sample one durable settlement reports, if any. */
function usageOfEvent(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = event.data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') return record.chunk.usage;
  }
  return undefined;
}

/** Wire-safe total of one request bucket. */
function totalOfRequest(bucket) {
  return bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output;
}

/** The public row shape of one request bucket (without the internal key). */
function requestRowOf(bucket) {
  return {
    requests: bucket.requests,
    input: bucket.input,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    output: bucket.output,
    reasoning: bucket.reasoning,
    total: totalOfRequest(bucket),
  };
}

/** Wire-safe scalar period (input/output/cache/total/settlements). */
function sumDays(records) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, settlements: 0 };
  for (const record of records) {
    sum.input += record.input;
    sum.output += record.output;
    sum.cacheRead += record.cacheRead;
    sum.cacheWrite += record.cacheWrite;
    sum.settlements += record.settlements;
  }
  sum.total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
  return sum;
}

/** One named period in the wire summary. */
function periodOf(startKey, endKey, records) {
  return { start: startKey, end: endKey, ...sumDays(records) };
}

/** One day row for heatmap/trend/recent consumers. */
function dayRowOf(key, record) {
  const { input, output, cacheRead, cacheWrite, settlements, turnMs, longestMs } = record;
  return { date: key, input, output, cacheRead, cacheWrite, settlements, turnMs, longestMs, total: input + output + cacheRead + cacheWrite };
}

/** Nearest-rank percentile of an ascending numeric array. */
function percentileOf(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

/** Zero-filled ascending day rows for the last `count` local days. */function dayRows(count, now, days) {
  const rows = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const key = dayKeyOf(now.getTime() - index * 86400000);
    rows.push(dayRowOf(key, days.get(key) ?? zeroDay()));
  }
  return rows;
}

/** Streak statistics over ascending day rows. */
function streakStats(rows) {
  let activeDays = 0;
  let longest = 0;
  let run = 0;
  for (const row of rows) {
    if (row.total > 0) {
      activeDays += 1;
      run += 1;
      if (run > longest) longest = run;
    } else run = 0;
  }
  // Current streak: ending today, or ending yesterday when today is still
  // empty, so an early morning never zeroes the counter.
  let current = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.total > 0) current += 1;
    else if (current === 0 && index === rows.length - 1) continue; // today may still be empty
    else break;
  }
  return { activeDays, longestStreak: longest, currentStreak: current };
}

// ---- persistence: SQLite (node:sqlite) ------------------------------------

/** Expand a leading `~` / `~/` / `~\` against the operating-system home. */
function expandHomePath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** The resolved DeepSeek Harness home (`$DSH_HOME`, else `~/.dsh`). */
function dshHomeDir() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return resolve(configured.length > 0 ? expandHomePath(configured) : join(homedir(), '.dsh'));
}

/** The database file: `config.dbPath` when set, else the profile's storage root. */
function resolveDbPath(config) {
  const configured = typeof config?.dbPath === 'string' ? config.dbPath.trim() : '';
  if (configured.length === 0) return join(dshHomeDir(), 'storages', DB_FILE_NAME);
  if (configured === ':memory:') return configured;
  const expanded = expandHomePath(configured);
  // A relative override lands under the harness home, not the process cwd, so
  // the database location never depends on how the app was launched.
  return resolve(expanded === configured && !isAbsolute(expanded) ? join(dshHomeDir(), expanded) : expanded);
}

/**
 * The session-log root used for the one-time historical replay:
 * `config.sessionsDir` when set, else `$DSH_HOME/sessions` (where the Host's
 * JSONL persistence writes every session). A missing directory is not an error
 * — that profile simply has no history to backfill.
 */
function resolveSessionsRoot(config) {
  const configured = typeof config?.sessionsDir === 'string' ? config.sessionsDir.trim() : '';
  if (configured.length === 0) return join(dshHomeDir(), 'sessions');
  const expanded = expandHomePath(configured);
  return resolve(expanded === configured && !isAbsolute(expanded) ? join(dshHomeDir(), expanded) : expanded);
}

/**
 * Legacy v1 JSON candidate: the file the previous release wrote next to the
 * database. Only the database's own directory is considered, so a custom
 * `dbPath` never imports an unrelated profile's history.
 */
function legacyJsonCandidates(dbPath) {
  if (dbPath === ':memory:') return [];
  return [join(dirname(dbPath), LEGACY_JSON_FILE_NAME)];
}

/** Table names in one SQLite file, excluding SQLite's own tables. */
function listUserTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map((row) => row.name);
}

/**
 * Open (and if needed initialize) the statistics database.
 * @param {string} filePath - absolute database path; `:memory:` is allowed.
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
async function openDatabase(filePath) {
  const { DatabaseSync } = await import('node:sqlite');
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  try {
    const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0);
    const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    const tables = listUserTables(db);
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new Error(`database at ${filePath} belongs to another application (application_id ${applicationId})`);
    }
    if (applicationId === 0 && tables.length > 0) {
      throw new Error(`database at ${filePath} contains unrecognized tables: ${tables.join(', ')}`);
    }
    if (userVersion > SCHEMA_VERSION) {
      throw new Error(`database at ${filePath} uses schema version ${userVersion}; this build supports ${SCHEMA_VERSION}`);
    }
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // A medium without WAL support keeps SQLite's default journal.
    }
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS days (
        day          TEXT PRIMARY KEY,
        input        INTEGER NOT NULL DEFAULT 0,
        output       INTEGER NOT NULL DEFAULT 0,
        cache_read   INTEGER NOT NULL DEFAULT 0,
        cache_write  INTEGER NOT NULL DEFAULT 0,
        settlements  INTEGER NOT NULL DEFAULT 0,
        turn_ms      INTEGER NOT NULL DEFAULT 0,
        longest_ms   INTEGER NOT NULL DEFAULT 0
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS day_models (
        day          TEXT NOT NULL,
        model        TEXT NOT NULL,
        input        INTEGER NOT NULL DEFAULT 0,
        output       INTEGER NOT NULL DEFAULT 0,
        cache_read   INTEGER NOT NULL DEFAULT 0,
        cache_write  INTEGER NOT NULL DEFAULT 0,
        settlements  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, model)
      ) STRICT
    `);
    // ---- v2 dimensions: project / session / turn / request ---------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        first_ts   INTEGER NOT NULL,
        last_ts    INTEGER NOT NULL
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        title        TEXT,
        first_ts     INTEGER NOT NULL,
        last_ts      INTEGER NOT NULL,
        parent_id    TEXT
      ) STRICT
    `);
    db.exec('CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions (project_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        session_id   TEXT NOT NULL,
        turn         INTEGER NOT NULL,
        start_ts     INTEGER,
        end_ts       INTEGER,
        PRIMARY KEY (session_id, turn)
      ) STRICT
    `);
    db.exec('CREATE INDEX IF NOT EXISTS turns_by_start ON turns (start_ts)');
    // One row per billed attempt. `attempt` is the per-slot generation: a
    // same-slot replacement overwrites its row, a retry adds one.
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id           TEXT PRIMARY KEY,
        day          TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        project_id   TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        turn         INTEGER NOT NULL,
        step         INTEGER NOT NULL,
        attempt      INTEGER NOT NULL,
        model        TEXT,
        input        INTEGER NOT NULL DEFAULT 0,
        cache_read   INTEGER NOT NULL DEFAULT 0,
        cache_write  INTEGER NOT NULL DEFAULT 0,
        output       INTEGER NOT NULL DEFAULT 0,
        reasoning    INTEGER NOT NULL DEFAULT 0
      ) STRICT
    `);
    db.exec('CREATE INDEX IF NOT EXISTS requests_by_day ON requests (day)');
    db.exec('CREATE INDEX IF NOT EXISTS requests_by_project ON requests (project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS requests_by_session ON requests (session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS requests_by_turn ON requests (session_id, turn)');
    if (userVersion < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
}

/** Prepared statements reused by every flush and by the legacy import. */
function prepareStatements(db) {
  return {
    upsertDay: db.prepare(`
      INSERT INTO days (day, input, output, cache_read, cache_write, settlements, turn_ms, longest_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        input = excluded.input, output = excluded.output,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        settlements = excluded.settlements, turn_ms = excluded.turn_ms,
        longest_ms = excluded.longest_ms
    `),
    deleteDay: db.prepare('DELETE FROM days WHERE day = ?'),
    deleteDayModels: db.prepare('DELETE FROM day_models WHERE day = ?'),
    upsertModel: db.prepare(`
      INSERT INTO day_models (day, model, input, output, cache_read, cache_write, settlements)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, model) DO UPDATE SET
        input = excluded.input, output = excluded.output,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        settlements = excluded.settlements
    `),
    getDay: db.prepare('SELECT day FROM days WHERE day = ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    // ---- v2 dimensions ---------------------------------------------------
    upsertProject: db.prepare(`
      INSERT INTO projects (id, title, first_ts, last_ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        first_ts = CASE
          WHEN projects.first_ts IS NULL THEN excluded.first_ts
          WHEN excluded.first_ts IS NULL THEN projects.first_ts
          ELSE MIN(projects.first_ts, excluded.first_ts) END,
        last_ts = CASE
          WHEN projects.last_ts IS NULL THEN excluded.last_ts
          WHEN excluded.last_ts IS NULL THEN projects.last_ts
          ELSE MAX(projects.last_ts, excluded.last_ts) END
    `),
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, project_id, title, first_ts, last_ts, parent_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = COALESCE(excluded.title, sessions.title),
        first_ts = CASE
          WHEN sessions.first_ts IS NULL THEN excluded.first_ts
          WHEN excluded.first_ts IS NULL THEN sessions.first_ts
          ELSE MIN(sessions.first_ts, excluded.first_ts) END,
        last_ts = CASE
          WHEN sessions.last_ts IS NULL THEN excluded.last_ts
          WHEN excluded.last_ts IS NULL THEN sessions.last_ts
          ELSE MAX(sessions.last_ts, excluded.last_ts) END
    `),
    setSessionTitle: db.prepare('UPDATE sessions SET title = ? WHERE id = ?'),
    getSession: db.prepare('SELECT id, project_id, title FROM sessions WHERE id = ?'),
    upsertTurn: db.prepare(`
      INSERT INTO turns (session_id, turn, start_ts, end_ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET
        start_ts = CASE
          WHEN turns.start_ts IS NULL THEN excluded.start_ts
          WHEN excluded.start_ts IS NULL THEN turns.start_ts
          ELSE MIN(turns.start_ts, excluded.start_ts) END,
        end_ts = CASE
          WHEN turns.end_ts IS NULL THEN excluded.end_ts
          WHEN excluded.end_ts IS NULL THEN turns.end_ts
          ELSE MAX(turns.end_ts, excluded.end_ts) END
    `),
    setTurnEnd: db.prepare('UPDATE turns SET end_ts = ? WHERE session_id = ? AND turn = ?'),
    upsertRequest: db.prepare(`
      INSERT INTO requests (id, day, ts, project_id, session_id, turn, step, attempt, model, input, cache_read, cache_write, output, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ts = excluded.ts, project_id = excluded.project_id, model = excluded.model,
        input = excluded.input, cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        output = excluded.output, reasoning = excluded.reasoning
    `),
    deleteRequest: db.prepare('DELETE FROM requests WHERE id = ?'),
    deleteRequestsByDay: db.prepare('DELETE FROM requests WHERE day = ?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteTurn: db.prepare('DELETE FROM turns WHERE session_id = ? AND turn = ?'),
    getRequest: db.prepare(`
      SELECT id, day, ts, project_id, session_id, turn, step, attempt, model,
             input, cache_read, cache_write, output, reasoning
      FROM requests WHERE id = ?
    `),
    loadProjects: db.prepare('SELECT id, title, first_ts, last_ts FROM projects'),
    loadSessions: db.prepare('SELECT id, project_id, title, first_ts, last_ts, parent_id FROM sessions'),
    loadTurns: db.prepare('SELECT session_id, turn, start_ts, end_ts FROM turns'),
    sumRequestsByProject: db.prepare(`
      SELECT project_id AS id, COUNT(*) AS requests,
             COALESCE(SUM(input),0) AS input, COALESCE(SUM(cache_read),0) AS cache_read,
             COALESCE(SUM(cache_write),0) AS cache_write, COALESCE(SUM(output),0) AS output,
             COALESCE(SUM(reasoning),0) AS reasoning
      FROM requests GROUP BY project_id
    `),
    sumRequestsBySession: db.prepare(`
      SELECT session_id AS id, COUNT(*) AS requests,
             COALESCE(SUM(input),0) AS input, COALESCE(SUM(cache_read),0) AS cache_read,
             COALESCE(SUM(cache_write),0) AS cache_write, COALESCE(SUM(output),0) AS output,
             COALESCE(SUM(reasoning),0) AS reasoning
      FROM requests GROUP BY session_id
    `),
    sumRequestsByTurn: db.prepare(`
      SELECT session_id, turn, COUNT(*) AS requests,
             COALESCE(SUM(input),0) AS input, COALESCE(SUM(cache_read),0) AS cache_read,
             COALESCE(SUM(cache_write),0) AS cache_write, COALESCE(SUM(output),0) AS output,
             COALESCE(SUM(reasoning),0) AS reasoning
      FROM requests GROUP BY session_id, turn
    `),
  };
}

/**
 * Write one day record (and its model rows) through prepared statements.
 * The model rows are capped exactly like the in-memory fold, so an imported
 * record cannot persist more attribution than a reload will read back.
 */
function writeDayRecord(stmts, key, record) {
  stmts.deleteDayModels.run(key);
  if (record === undefined) {
    stmts.deleteDay.run(key);
    return;
  }
  stmts.upsertDay.run(key, record.input, record.output, record.cacheRead, record.cacheWrite, record.settlements, record.turnMs, record.longestMs);
  let written = 0;
  for (const [id, buckets] of Object.entries(record.models)) {
    if (written >= MAX_MODELS_PER_DAY) break;
    stmts.upsertModel.run(key, id, buckets.input, buckets.output, buckets.cacheRead, buckets.cacheWrite, buckets.settlements);
    written += 1;
  }
}

/** One coalesced transaction: every dirty day plus its model rows. */
function writeDirtyDays(db, stmts, keys, days) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const key of keys) writeDayRecord(stmts, key, days.get(key));
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback leaves the original error as the useful signal.
    }
    throw error;
  }
}

/**
 * One coalesced transaction covering every dirty dimension: day rows, request
 * rows, identity rows, and their pruned deletions.
 * @param {import('node:sqlite').DatabaseSync} db - the open database.
 * @param {object} stmts - prepared statements.
 * @param {object} batch - the dirty sets plus their source maps.
 */
function writeDirty(db, stmts, batch) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const key of batch.keys) writeDayRecord(stmts, key, batch.days.get(key));
    for (const id of batch.deletions) stmts.deleteRequest.run(id);
    for (const request of batch.requests) {
      stmts.upsertRequest.run(
        request.id, request.day, request.ts, request.projectId, request.sessionId,
        request.turn, request.step, request.attempt, request.model,
        request.input, request.cacheRead, request.cacheWrite, request.output, request.reasoning,
      );
    }
    for (const id of batch.projectIds) {
      const record = batch.projects.get(id);
      if (record === undefined) continue;
      stmts.upsertProject.run(id, record.title, record.firstTs, record.lastTs);
    }
    for (const id of batch.sessionIds) {
      const record = batch.sessions.get(id);
      if (record === undefined) continue;
      stmts.upsertSession.run(id, record.projectId, record.title, record.firstTs, record.lastTs, record.parentId);
    }
    for (const key of batch.turnKeys) {
      const record = batch.turns.get(key);
      if (record === undefined) continue;
      stmts.upsertTurn.run(record.sessionId, record.turn, record.startTs, record.endTs);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback leaves the original error as the useful signal.
    }
    throw error;
  }
}

/**
 * Combine two day records without losing either side: scalars add, turn time
 * adds, the longest turn takes the maximum, and model buckets merge up to the
 * per-day attribution cap. Used when events were folded before the database
 * finished loading (startup overflow) and their day also has stored rows.
 * @param {ReturnType<typeof zeroDay>} base - the durable record.
 * @param {ReturnType<typeof zeroDay>} extra - the already-folded record.
 * @returns {ReturnType<typeof zeroDay>}
 */
function mergeDayRecord(base, extra) {
  const models = { ...base.models };
  for (const [id, buckets] of Object.entries(extra.models)) {
    const existing = models[id];
    if (existing !== undefined) {
      models[id] = {
        input: existing.input + buckets.input,
        output: existing.output + buckets.output,
        cacheRead: existing.cacheRead + buckets.cacheRead,
        cacheWrite: existing.cacheWrite + buckets.cacheWrite,
        settlements: existing.settlements + buckets.settlements,
      };
    } else if (Object.keys(models).length < MAX_MODELS_PER_DAY) {
      models[id] = { ...buckets };
    }
  }
  return {
    input: base.input + extra.input,
    output: base.output + extra.output,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    settlements: base.settlements + extra.settlements,
    turnMs: base.turnMs + extra.turnMs,
    longestMs: Math.max(base.longestMs, extra.longestMs),
    models,
  };
}

/** Load every stored day and its model buckets into memory. */
function loadDays(db) {
  const days = new Map();
  const dayRows = db.prepare(`
    SELECT day, input, output, cache_read, cache_write, settlements, turn_ms, longest_ms
    FROM days ORDER BY day
  `).all();
  for (const row of dayRows) {
    if (typeof row.day !== 'string' || !DAY_KEY_RE.test(row.day)) continue;
    days.set(row.day, {
      input: countOf(row.input),
      output: countOf(row.output),
      cacheRead: countOf(row.cache_read),
      cacheWrite: countOf(row.cache_write),
      settlements: countOf(row.settlements),
      turnMs: countOf(row.turn_ms),
      longestMs: countOf(row.longest_ms),
      models: {},
    });
  }
  const modelRows = db.prepare(`
    SELECT day, model, input, output, cache_read, cache_write, settlements FROM day_models
  `).all();
  for (const row of modelRows) {
    const day = days.get(row.day);
    if (day === undefined) continue;
    if (typeof row.model !== 'string' || row.model.length === 0 || row.model.length > MAX_MODEL_ID_LENGTH) continue;
    if (day.models[row.model] !== undefined) continue;
    if (Object.keys(day.models).length >= MAX_MODELS_PER_DAY) continue;
    day.models[row.model] = {
      input: countOf(row.input),
      output: countOf(row.output),
      cacheRead: countOf(row.cache_read),
      cacheWrite: countOf(row.cache_write),
      settlements: countOf(row.settlements),
    };
  }
  return days;
}

/**
 * Read the v1 JSON store written by the previous release through the storage
 * domain (`{ unit, global, tables: { days: { '<YYYY-MM-DD>': record } } }`).
 * A leading UTF-8 BOM is tolerated: the old writer did not emit one, but an
 * editor that re-saved the file may have added it.
 * @param {string} filePath - the legacy JSON file.
 * @returns {Array<[string, ReturnType<typeof zeroDay>]>} valid day records.
 */
function readLegacyDays(filePath) {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text);
  const rawDays = parsed?.tables?.days;
  if (typeof rawDays !== 'object' || rawDays === null || Array.isArray(rawDays)) throw new Error('missing tables.days object');
  const entries = [];
  for (const [key, raw] of Object.entries(rawDays)) {
    if (!DAY_KEY_RE.test(key)) continue;
    try {
      entries.push([key, parseDayRecord(raw)]);
    } catch {
      // One malformed record must not block the rest of the history.
    }
  }
  return entries;
}

/** A backup name for the imported legacy file that does not collide. */
function migratedPathOf(filePath) {
  const base = `${filePath}.migrated`;
  if (!existsSync(base)) return base;
  return `${base}-${Date.now()}`;
}

/**
 * Import the v1 JSON store once, then rename it so it is never re-imported.
 * Records already present in SQLite win, so a partially written database
 * never loses newer data to stale JSON.
 * @returns {Array<[string, ReturnType<typeof zeroDay>]>} imported records.
 */
function migrateLegacyJson(db, stmts, candidates, logger) {
  if (stmts.getMeta.get('legacy_json_imported') !== undefined) return [];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (source === undefined) return [];
  let entries;
  try {
    entries = readLegacyDays(source);
  } catch (error) {
    logger?.warn?.('token-usage-stats: legacy JSON at %s is unreadable, leaving it in place: %s', source, error?.message ?? String(error));
    return [];
  }
  const imported = entries.filter(([key]) => stmts.getDay.get(key) === undefined);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, record] of imported) writeDayRecord(stmts, key, record);
    stmts.setMeta.run('legacy_json_imported', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the write failure as the reported cause.
    }
    throw error;
  }
  try {
    renameSync(source, migratedPathOf(source));
  } catch (error) {
    // The meta flag already prevents a second import; the stale file is only
    // a leftover for the operator to delete.
    logger?.warn?.('token-usage-stats: imported legacy JSON but could not rename %s: %s', source, error?.message ?? String(error));
  }
  return imported;
}

export const inject = ['webServer'];

export function apply(ctx, config) {
  const retentionDays = Number.isSafeInteger(config?.retentionDays) && config.retentionDays > 0 ? config.retentionDays : 400;
  const detailDays = Number.isSafeInteger(config?.detailDays) && config.detailDays > 0 ? config.detailDays : 14;
  const dbPath = resolveDbPath(config);
  const legacyCandidates = legacyJsonCandidates(dbPath);
  // Historical backfill replays session logs the live listener never saw.
  // `backfillHistory: false` turns it off entirely (air-gapped or huge logs).
  const backfillHistory = config?.backfillHistory !== false;
  const sessionsRoot = resolveSessionsRoot(config);

  /** @type {Map<string, ReturnType<typeof zeroDay>>} day key -> record */
  const days = new Map();
  /** Day keys whose in-memory record outruns the durable table. */
  const dirtyKeys = new Set();
  /** @type {Map<string, ReturnType<typeof zeroProject>>} project id -> record */
  const projects = new Map();
  /** @type {Map<string, ReturnType<typeof zeroSession>>} session id -> record */
  const sessions = new Map();
  /** @type {Map<string, ReturnType<typeof zeroTurn>>} turn key -> record */
  const turns = new Map();
  /**
   * Per-project daily token totals for the activity distribution
   * (project id -> Map<day key, tokens>). Hydrated from `requests` on open and
   * kept in step by every fold, so the panel works with or without SQLite.
   * @type {Map<string, Map<string, number>>}
   */
  const activityProjects = new Map();
  /** Per-session daily token totals (session id -> Map<day key, tokens>). */
  const activitySessions = new Map();
  /** Request rows awaiting a write (request id -> row). */
  const pendingRequests = new Map();
  /** Request ids to delete on the next flush (pruned days). */
  const deletedRequests = new Set();
  const dirtyProjects = new Set();
  const dirtySessions = new Set();
  const dirtyTurns = new Set();
  /** Per-session attempt slot: replacement bookkeeping (WeakMap, no leak). */
  const slots = new WeakMap();
  /** Per-session open-turn start times by turn number. */
  const turnStarts = new WeakMap();
  /** Per-session latest request-header provider/model. */
  const headers = new WeakMap();
  /** Per-session project/session identity derived from the session header. */
  const identities = new WeakMap();
  /** Per-session attempt generation counters, keyed `turn:step`. */
  const attemptCounters = new WeakMap();
  /** Monotonic request-row id source, unique across process runs. */
  let requestSeq = 0;
  const requestRunId = `${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(36)}`;
  /** Consecutive failed flush attempts, used to drop an unpersistable batch. */
  let flushFailures = 0;
  /** Open database handle plus its prepared statements; null = memory-only. */
  let state = { db: null, stmts: null };
  /** Whether the open (or its failure) has settled and buffered events ran. */
  let ready = false;
  /** Set on dispose so no new flush is scheduled against a closed handle. */
  let closed = false;
  /** Set when the plugin unmounts, including before the open finishes. */
  let disposed = false;
  /** Events observed before the database finished loading, replayed in order. */
  const pendingEvents = [];
  let flushChain = Promise.resolve();
  /**
   * Set while one historical session is being replayed. The replay already
   * batches a whole session, so per-event flushes are coalesced into one.
   */
  let backfilling = false;

  // Registered synchronously so an unmount that races the async open still
  // tears the database down: the open path checks `disposed` right after it
  // installs the handle and closes immediately in that case.
  ctx.effect(() => () => {
    disposed = true;
    closed = true;
    const finish = flushChain.then(() => {
      const current = state;
      state = { db: null, stmts: null };
      if (current.db === null) return;
      if (dirtyKeys.size > 0) {
        const keys = [...dirtyKeys];
        dirtyKeys.clear();
        try {
          writeDirtyDays(current.db, current.stmts, keys, days);
        } catch (error) {
          ctx.logger.warn('token-usage-stats: final persist failed: %s', error?.message ?? String(error));
        }
      }
      try {
        current.db.close();
      } catch (error) {
        ctx.logger.warn('token-usage-stats: database close failed: %s', error?.message ?? String(error));
      }
    });
    return finish;
  }, 'dsh-token-usage-stats: sqlite close');

  /**
   * Drop in-memory day records older than the retention window and mark them
   * dirty so the next flush deletes their durable rows. Request rows and their
   * aggregates are handled by `pruneDurable`, which rebuilds from `requests`.
   */
  const pruneOld = () => {
    const cutoff = dayKeyOf(Date.now() - retentionDays * 86400000);
    for (const key of [...days.keys()]) {
      if (key < cutoff) {
        days.delete(key);
        dirtyKeys.add(key); // absent record -> delete on the database
      }
    }
    // The activity strips only read the recent window; older buckets are dead
    // weight once a replay or a long uptime pushed them in.
    const activityCutoff = dayKeyOf(Date.now() - ACTIVITY_RETENTION_DAYS * 86400000);
    for (const map of [activityProjects, activitySessions]) {
      for (const [id, series] of map) {
        for (const key of [...series.keys()]) if (key < activityCutoff) series.delete(key);
        if (series.size === 0) map.delete(id);
      }
    }
  };

  /**
   * Delete every durable row older than the retention window in one pass,
   * including request rows whose day never loaded into memory (a restart must
   * prune just as a live flush does). Identity rows left with no remaining
   * requests are removed too, so a pruned project never lingers as a zero row.
   */
  const pruneDurable = () => {
    const current = state;
    if (current.db === null) return;
    const cutoff = dayKeyOf(Date.now() - retentionDays * 86400000);
    const stale = current.db.prepare('SELECT id FROM requests WHERE day < ?').all(cutoff);
    if (stale.length === 0) {
      pruneEmptyIdentities();
      return;
    }
    current.db.exec('BEGIN IMMEDIATE');
    try {
      current.db.prepare('DELETE FROM requests WHERE day < ?').run(cutoff);
      current.db.exec('COMMIT');
    } catch (error) {
      try {
        current.db.exec('ROLLBACK');
      } catch {
        // The original failure is the reported cause.
      }
      throw error;
    }
    // Rebuild the aggregates so the in-memory rows match the durable truth.
    for (const record of projects.values()) record.bucket = zeroRequest();
    for (const record of sessions.values()) record.bucket = zeroRequest();
    for (const record of turns.values()) record.bucket = zeroRequest();
    rebuildAggregates(current.stmts);
    pruneEmptyIdentities();
  };

  /**
   * Drop identity rows (project/session/turn) that no longer own any request
   * and whose entire observed span is older than the retention cutoff. Without
   * this, a pruned day would leave zero-token projects in the dashboard and
   * the breakdown route forever. A live identity that merely has no usage yet
   * (a turn with timing, a freshly titled session) is never removed.
   */
  const pruneEmptyIdentities = () => {
    const current = state;
    if (current.db === null) return;
    const cutoffMs = Date.now() - retentionDays * 86400000;
    // The newest timestamp each kind of record tracks (turns use start/end).
    const lastSeenOf = (record) => {
      if (record.startTs !== undefined || record.endTs !== undefined) {
        return Math.max(record.startTs ?? -Infinity, record.endTs ?? -Infinity);
      }
      return record.lastTs ?? -Infinity;
    };
    const expired = (record) => record.bucket.requests === 0 && lastSeenOf(record) < cutoffMs;
    const emptyProjects = [...projects.values()].filter(expired);
    const emptySessions = [...sessions.values()].filter(expired);
    const emptyTurns = [...turns.values()].filter(expired);
    if (emptyProjects.length === 0 && emptySessions.length === 0 && emptyTurns.length === 0) return;
    current.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of emptyTurns) {
        current.stmts.deleteTurn.run(record.sessionId, record.turn);
        turns.delete(turnKeyOf(record.sessionId, record.turn));
      }
      for (const record of emptySessions) {
        current.stmts.deleteSession.run(record.id);
        sessions.delete(record.id);
      }
      for (const record of emptyProjects) {
        current.stmts.deleteProject.run(record.id);
        projects.delete(record.id);
      }
      current.db.exec('COMMIT');
    } catch (error) {
      try {
        current.db.exec('ROLLBACK');
      } catch {
        // The original failure is the reported cause.
      }
      throw error;
    }
  };

  /** Persist every dirty day and dimension row in one transaction. */
  const flushDirty = async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      const current = state;
      if (current.db === null) return;
      if (dirtyKeys.size === 0 && pendingRequests.size === 0 && deletedRequests.size === 0
        && dirtyProjects.size === 0 && dirtySessions.size === 0 && dirtyTurns.size === 0) return;
      const keys = [...dirtyKeys];
      const requests = [...pendingRequests.values()];
      const deletions = [...deletedRequests];
      const projectIds = [...dirtyProjects];
      const sessionIds = [...dirtySessions];
      const turnKeys = [...dirtyTurns];
      dirtyKeys.clear();
      pendingRequests.clear();
      deletedRequests.clear();
      dirtyProjects.clear();
      dirtySessions.clear();
      dirtyTurns.clear();
      try {
        writeDirty(current.db, current.stmts, {
          keys, requests, deletions, projectIds, sessionIds, turnKeys,
          days, projects, sessions, turns,
        });
      } catch (error) {
        // A retry keeps the batch for the next flush. A batch that keeps
        // failing must not wedge persistence forever: after a few attempts the
        // poison rows are dropped (with a loud warning) so later events still
        // reach the database. Every field is validated before it can reach a
        // bind, so this is a last-resort guard, not the normal path.
        flushFailures += 1;
        if (flushFailures < MAX_FLUSH_FAILURES) {
          for (const key of keys) dirtyKeys.add(key);
          for (const request of requests) pendingRequests.set(request.id, request);
          for (const id of deletions) deletedRequests.add(id);
          for (const id of projectIds) dirtyProjects.add(id);
          for (const id of sessionIds) dirtySessions.add(id);
          for (const key of turnKeys) dirtyTurns.add(key);
        } else {
          flushFailures = 0;
          ctx.logger.warn(
            'token-usage-stats: dropping %d unpersistable row(s) after %d failed flushes: %s',
            requests.length + keys.length, MAX_FLUSH_FAILURES, error?.message ?? String(error),
          );
        }
        throw error;
      }
      flushFailures = 0;
      pruneOld();
      pruneDurable();
      if (dirtyKeys.size === 0 && pendingRequests.size === 0 && deletedRequests.size === 0
        && dirtyProjects.size === 0 && dirtySessions.size === 0 && dirtyTurns.size === 0) return;
    }
  };

  /** Coalesce pending day writes onto one ordered chain. */
  const scheduleFlush = () => {
    if (closed) return;
    // One replay batch flushes once, when the session's records are folded.
    if (backfilling) return;
    flushChain = flushChain.then(flushDirty).catch((error) => {
      ctx.logger.warn('token-usage-stats: persist failed: %s', error?.message ?? String(error));
    });
  };

  /** Apply one in-memory day mutation and schedule its persist. */
  const setDay = (dayKey, record) => {
    days.set(dayKey, record);
    dirtyKeys.add(dayKey);
    scheduleFlush();
  };

  // Open the durable database; failures degrade to memory-only statistics.
  const opened = (async () => {
    let db = null;
    try {
      db = await openDatabase(dbPath);
      const stmts = prepareStatements(db);
      adoptLoadedDays(loadDays(db));
      loadDimensions(db, stmts);
      state = { db, stmts };
      if (disposed) {
        // The plugin unmounted while the database was opening: release the
        // handle instead of keeping a file lock for a dead instance.
        state = { db: null, stmts: null };
        try {
          db.close();
        } catch {
          // Nothing is registered against it; the unmount is the real signal.
        }
        ready = true;
        pendingEvents.length = 0;
        return;
      }
      let imported = [];
      try {
        imported = migrateLegacyJson(db, stmts, legacyCandidates, ctx.logger);
      } catch (error) {
        // A failed import is not a reason to abandon durable storage: the
        // database is open and future days persist normally.
        ctx.logger.warn('token-usage-stats: legacy JSON import failed: %s', error?.message ?? String(error));
      }
      for (const [key, record] of imported) if (!days.has(key)) days.set(key, record);
      pruneOld();
      pruneDurable();
      scheduleFlush();
      if (imported.length > 0) {
        ctx.logger.info('token-usage-stats: imported %d day(s) from the legacy JSON store', imported.length);
      }
    } catch (error) {
      ctx.logger.warn('token-usage-stats: sqlite unavailable, running memory-only: %s', error?.message ?? String(error));
      // Abandon a half-initialized handle: nothing is registered against it
      // yet, and memory-only mode must not keep a file lock open.
      const current = state;
      state = { db: null, stmts: null };
      if (current.db !== null) {
        try {
          current.db.close();
        } catch {
          // The initialization failure is the reported cause.
        }
      }
      if (db !== null && db !== current.db) {
        try {
          db.close();
        } catch {
          // Same: keep the original cause.
        }
      }
    }
    ready = true;
    for (const [session, event] of pendingEvents.splice(0)) safeFold(session, event);
    // Historical replay is background work: it never blocks activation, and a
    // failure only costs history, never the live stream.
    if (backfillHistory) {
      if (!supportsZstd()) {
        // Older Node runtimes have no Zstandard decoder (added in 22.15/23.8).
        // Live folding and the routes keep working; only history is skipped.
        ctx.logger.warn('token-usage-stats: historical replay needs a Zstandard-capable Node runtime (Node >= 22.15); skipping session logs');
      } else {
        backfillFromLogs().catch((error) => {
          ctx.logger.warn('token-usage-stats: historical backfill failed: %s', error?.message ?? String(error));
        });
      }
    }
  })();

  /**
   * Fold one event, containing any malformed payload: a single bad event must
   * never take down the listener (and with it the host's commit path).
   * @param {object} session - the session identity.
   * @param {object} event - the committed session event.
   */
  function safeFold(session, event) {
    try {
      fold(session, event);
    } catch (error) {
      ctx.logger.warn('token-usage-stats: skipped malformed session event: %s', error?.message ?? String(error));
    }
  }

  /**
   * Replay historical usage from the Host's session logs.
   *
   * The live listener only sees events committed while the plugin is mounted,
   * so everything from before the install is missing. `history.js` decodes the
   * JSONL logs (multi-frame Zstandard) and this function folds their records
   * through the SAME `fold` the live path uses, which keeps replacement,
   * retry, day-bucketing, model attribution, project/session/turn aggregation,
   * and turn timing identical by construction.
   *
   * Double-count safety:
   *   - a session already in `sessions` (recorded live, or imported by an
   *     earlier run and therefore loaded at startup) is skipped before its
   *     event frames are decoded;
   *   - only the highest log generation per session directory is read;
   *   - every replayed row belongs to one session, so a restart either sees
   *     the session row (skip) or replays it whole (the flush is the commit).
   *
   * Runs after the database is loaded and after the buffered live events were
   * folded, one file at a time, yielding to the event loop between files so a
   * large history never stalls the app. Malformed or unreadable logs are
   * skipped with a warning and retried on the next start.
   */
  const backfillFromLogs = async () => {
    let logs;
    try {
      logs = listSessionLogs(sessionsRoot);
    } catch (error) {
      ctx.logger.warn('token-usage-stats: cannot list session logs under %s: %s', sessionsRoot, error?.message ?? String(error));
      return;
    }
    if (logs.length === 0) return;
    // Logs whose last write predates the retention window would be imported
    // and pruned again on the very next flush: skip them instead.
    const cutoffMs = Date.now() - retentionDays * 86400000;
    let importedSessions = 0;
    let importedRequests = 0;
    let skipped = 0;
    let failed = 0;
    for (const log of logs) {
      if (closed || disposed) return;
      if (log.mtime > 0 && log.mtime < cutoffMs) {
        skipped += 1;
        continue;
      }
      let header = null;
      try {
        header = readHeader(log.path);
      } catch (error) {
        failed += 1;
        ctx.logger.warn('token-usage-stats: unreadable session log %s: %s', log.path, error?.message ?? String(error));
        continue;
      }
      const id = header !== null && typeof header.id === 'string' ? header.id : '';
      if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH || sessions.has(id)) {
        skipped += 1;
        continue;
      }
      let records;
      try {
        records = readSessionRecords(log.path);
      } catch (error) {
        failed += 1;
        ctx.logger.warn('token-usage-stats: cannot decode session log %s: %s', log.path, error?.message ?? String(error));
        continue;
      }
      // A synthetic session identity: `fold` keys its per-session bookkeeping
      // (replacement slots, retry counters, header model) on this object, so a
      // fresh one per log keeps historical sessions isolated from each other.
      const session = { header: { id, cwd: typeof header.cwd === 'string' ? header.cwd : undefined } };
      backfilling = true;
      try {
        for (const record of records) safeFold(session, record);
      } finally {
        backfilling = false;
      }
      const imported = sessions.get(id);
      if (imported !== undefined) {
        importedSessions += 1;
        importedRequests += imported.bucket.requests;
      }
      scheduleFlush();
      await flushChain;
      await new Promise((resolveYield) => setImmediate(resolveYield));
    }
    if (importedSessions > 0) {
      ctx.logger.info('token-usage-stats: replayed %d historical session(s), %d request(s) from %s', importedSessions, importedRequests, sessionsRoot);
    } else if (failed > 0 || skipped !== logs.length) {
      ctx.logger.info('token-usage-stats: no new historical sessions in %s (%d skipped, %d unreadable)', sessionsRoot, skipped, failed);
    }
  };

  /**
   * Replace the in-memory map with the loaded rows without dropping folds that
   * ran before the open settled: a day present on both sides is merged, not
   * overwritten. Early folds are still in `dirtyKeys` (the flush cannot run
   * before the handle exists), so the merge is written by the next flush.
   * @param {Map<string, ReturnType<typeof zeroDay>>} loaded - durable records.
   */
  function adoptLoadedDays(loaded) {
    for (const [key, record] of loaded) {
      const early = days.get(key);
      days.set(key, early === undefined ? record : mergeDayRecord(record, early));
    }
  }

  /**
   * The project/session identity of one live session. Derived from the
   * session header's `id` and `cwd` (the project is the working directory);
   * a header without `cwd` falls back to the unknown project. Cached per
   * session object, since the header is immutable for the session lifetime.
   * @param {object} session - the live session.
   * @param {number} ts - the event time, used for the first-seen span.
   * @returns {{ sessionId: string, projectId: string }}
   */
  function identityOf(session, ts) {
    const cached = identities.get(session);
    if (cached !== undefined) return cached;
    const header = session?.header;
    const rawId = typeof header?.id === 'string' ? header.id : (typeof session?.id === 'string' ? session.id : '');
    const sessionId = rawId.length > 0 && rawId.length <= MAX_SESSION_ID_LENGTH ? rawId : UNKNOWN_MODEL;
    const rawCwd = typeof header?.cwd === 'string' ? header.cwd : '';
    const projectId = rawCwd.length > 0 && rawCwd.length <= MAX_PROJECT_ID_LENGTH ? rawCwd : UNKNOWN_PROJECT;
    const identity = { sessionId, projectId };
    identities.set(session, identity);
    ensureProject(identity, ts);
    ensureSession(identity, ts);
    return identity;
  }

  /** Project display title: the final path segment, or the raw id. */
  function projectTitleOf(projectId) {
    if (projectId === UNKNOWN_PROJECT) return UNKNOWN_PROJECT;
    const parts = projectId.split(/[\\/]+/).filter((part) => part.length > 0);
    const last = parts.length > 0 ? parts[parts.length - 1] : projectId;
    return last.length > 0 ? last : projectId;
  }

  /** Create or touch the project aggregate for one identity. */
  function ensureProject(identity, ts) {
    let record = projects.get(identity.projectId);
    if (record === undefined) {
      record = zeroProject(identity.projectId);
      record.title = projectTitleOf(identity.projectId);
      projects.set(identity.projectId, record);
    }
    if (Number.isFinite(ts)) spanOf(record, ts);
    return record;
  }

  /** Create or touch the session aggregate for one identity. */
  function ensureSession(identity, ts) {
    let record = sessions.get(identity.sessionId);
    if (record === undefined) {
      record = zeroSession(identity.sessionId);
      sessions.set(identity.sessionId, record);
    }
    if (record.projectId !== identity.projectId) record.projectId = identity.projectId;
    if (Number.isFinite(ts)) spanOf(record, ts);
    return record;
  }

  /**
   * Create or touch the turn aggregate for one identity and turn number.
   * The in-memory map is bounded by evicting only turns that own NO requests:
   * evicting an aggregated turn would silently under-report `by=turn`, while a
   * request-less turn carries no tokens and is already handled by pruning.
   */
  function ensureTurn(identity, turnNumber, ts) {
    const key = turnKeyOf(identity.sessionId, turnNumber);
    let record = turns.get(key);
    if (record === undefined) {
      record = zeroTurn(identity.sessionId, identity.projectId, turnNumber);
      turns.set(key, record);
      if (turns.size > MAX_TRACKED_TURNS) evictRequestlessTurns(key);
    }
    if (record.projectId !== identity.projectId) record.projectId = identity.projectId;
    if (Number.isFinite(ts)) spanOf(record, ts);
    return record;
  }

  /**
   * Drop the oldest request-less turn rows until the map is back under the
   * cap, always keeping `keepKey`. Aggregated turns are never candidates.
   * @param {string} keepKey - the turn currently being written.
   */
  function evictRequestlessTurns(keepKey) {
    if (turns.size <= MAX_TRACKED_TURNS) return;
    const candidates = [...turns.entries()]
      .filter(([candidateKey, candidate]) => candidateKey !== keepKey && candidate.bucket.requests === 0)
      .map(([candidateKey, candidate]) => [candidateKey, Math.max(candidate.startTs ?? -Infinity, candidate.endTs ?? -Infinity, candidate.lastTs ?? -Infinity)])
      .sort((a, b) => a[1] - b[1]);
    const excess = turns.size - MAX_TRACKED_TURNS;
    for (let index = 0; index < Math.min(excess, candidates.length); index += 1) turns.delete(candidates[index][0]);
  }

  /** The next attempt generation for one (turn, step) of a session. */
  function nextAttemptOf(session, turnNumber, step) {
    let counters = attemptCounters.get(session);
    if (counters === undefined) {
      counters = new Map();
      attemptCounters.set(session, counters);
    }
    const key = `${String(turnNumber)}:${String(step)}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  }

  /**
   * Record one billed request row and add its buckets to the project, session,
   * and turn aggregates. A replacement (same `requestId`) subtracts the prior
   * row before adding the new one, so aggregates never double count.
   */
  function recordRequest(identity, turnNumber, step, attempt, requestId, ts, dayKey, modelId, bucket) {
    const previous = pendingRequests.get(requestId) ?? persistedRequestOf(requestId);
    if (previous !== null) {
      // Drop the old row first: the span scan below must not see the row it is
      // about to subtract, or an earlier replacement could never contract it.
      pendingRequests.delete(requestId);
      applyRequestBuckets(previous, -1);
    }
    const row = {
      id: requestId,
      day: dayKey,
      ts,
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      turn: turnNumber,
      step,
      attempt,
      model: modelId,
      ...bucket,
      requests: 1,
    };
    pendingRequests.set(requestId, row);
    deletedRequests.delete(requestId);
    applyRequestBuckets(row, 1);
    const project = ensureProject(identity, ts);
    const session = ensureSession(identity, ts);
    const turn = ensureTurn(identity, turnNumber, ts);
    dirtyProjects.add(project.id);
    dirtySessions.add(session.id);
    dirtyTurns.add(turnKeyOf(turn.sessionId, turn.turn));
    scheduleFlush();
  }

  /** Total tokens one request row contributes to the activity strips. */
  function requestTokensOf(row) {
    return (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
  }

  /** Add one daily token delta to one activity dimension map. */
  function addActivityTo(map, id, day, tokens) {
    if (typeof id !== 'string' || id.length === 0 || typeof day !== 'string') return;
    if (!Number.isFinite(tokens) || tokens === 0) return;
    let series = map.get(id);
    if (series === undefined) {
      series = new Map();
      map.set(id, series);
    }
    const next = (series.get(day) ?? 0) + tokens;
    if (next === 0) series.delete(day);
    else series.set(day, next);
  }

  /** Mirror one request row into the project/session daily activity maps. */
  function trackActivity(row, sign) {
    const tokens = sign * requestTokensOf(row);
    addActivityTo(activityProjects, row.projectId, row.day, tokens);
    addActivityTo(activitySessions, row.sessionId, row.day, tokens);
  }

  /** Add (sign 1) or subtract (sign -1) one request row from its aggregates. */
  function applyRequestBuckets(row, sign) {
    const project = projects.get(row.projectId) ?? ensureProject({ projectId: row.projectId }, row.ts);
    const session = sessions.get(row.sessionId) ?? ensureSession({ sessionId: row.sessionId, projectId: row.projectId }, row.ts);
    const turn = turns.get(turnKeyOf(row.sessionId, row.turn)) ?? ensureTurn({ sessionId: row.sessionId, projectId: row.projectId }, row.turn, row.ts);
    for (const [target, bucket] of [[project.bucket, row], [session.bucket, row], [turn.bucket, row]]) {
      target.input += sign * bucket.input;
      target.cacheRead += sign * bucket.cacheRead;
      target.cacheWrite += sign * bucket.cacheWrite;
      target.output += sign * bucket.output;
      target.reasoning += sign * bucket.reasoning;
      target.requests += sign;
    }
    trackActivity(row, sign);
    if (sign > 0) {
      spanOf(project, row.ts);
      spanOf(session, row.ts);
      spanOf(turn, row.ts);
    } else {
      // A replacement may carry an earlier timestamp; the aggregate span has
      // to follow the request rows, not only ever widen.
      rescindSpan(project, row.ts, requestSpanOf(row.projectId, 'project'));
      rescindSpan(session, row.ts, requestSpanOf(row.sessionId, 'session'));
      rescindSpan(turn, row.ts, requestSpanOf(row.sessionId, 'turn'));
    }
  }

  /**
   * The newest timestamp still owned by one identity's request rows.
   * @param {string} id - project id or session id.
   * @param {'project'|'session'|'turn'} scope - which identity to scan.
   * @returns {{ first: number|null, last: number|null }}
   */
  function requestSpanOf(id, scope) {
    let first = null;
    let last = null;
    for (const row of pendingRequests.values()) {
      const matches = scope === 'project' ? row.projectId === id : row.sessionId === id;
      if (!matches) continue;
      if (first === null || row.ts < first) first = row.ts;
      if (last === null || row.ts > last) last = row.ts;
    }
    return { first, last };
  }

  /**
   * Recompute one record's span after a subtraction, preferring the still-live
   * request rows and falling back to the widest bound the record still holds.
   * @param {object} record - the aggregate record to adjust.
   * @param {number} removedTs - the timestamp that was subtracted.
   * @param {{ first: number|null, last: number|null }} live - surviving span.
   */
  function rescindSpan(record, removedTs, live) {
    if (record.lastTs !== null && record.lastTs === removedTs) {
      record.lastTs = live.last ?? (record.firstTs !== null && record.firstTs < removedTs ? record.firstTs : null);
    }
    if (record.firstTs !== null && record.firstTs === removedTs) {
      record.firstTs = live.first ?? (record.lastTs !== null && record.lastTs > removedTs ? record.lastTs : null);
    }
  }

  /** A request row already in the database, or null when it is new. */
  function persistedRequestOf(requestId) {
    const current = state;
    if (current.db === null) return null;
    const row = current.stmts.getRequest.get(requestId);
    if (row === undefined) return null;
    return {
      id: row.id,
      day: row.day,
      ts: Number(row.ts),
      projectId: row.project_id,
      sessionId: row.session_id,
      turn: Number(row.turn),
      step: Number(row.step),
      attempt: Number(row.attempt),
      model: row.model ?? UNKNOWN_MODEL,
      input: Number(row.input),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      output: Number(row.output),
      reasoning: Number(row.reasoning),
      requests: 1,
    };
  }

  /**
   * Rebuild the per-day activity maps from the durable `requests` table plus
   * the folds that ran before the open settled. Rows pending replacement or
   * deletion are skipped, so a restart cannot double count them.
   * @param {import('node:sqlite').DatabaseSync} db - the open database.
   */
  function hydrateActivity(db) {
    activityProjects.clear();
    activitySessions.clear();
    const cutoff = dayKeyOf(Date.now() - ACTIVITY_RETENTION_DAYS * 86400000);
    const rows = db.prepare(
      'SELECT id, project_id, session_id, day, input + output + cache_read + cache_write AS tokens FROM requests WHERE day >= ?',
    ).all(cutoff);
    for (const row of rows) {
      if (typeof row.id === 'string' && (pendingRequests.has(row.id) || deletedRequests.has(row.id))) continue;
      const tokens = Number(row.tokens);
      addActivityTo(activityProjects, row.project_id, row.day, tokens);
      addActivityTo(activitySessions, row.session_id, row.day, tokens);
    }
    for (const request of pendingRequests.values()) {
      const tokens = requestTokensOf(request);
      addActivityTo(activityProjects, request.projectId, request.day, tokens);
      addActivityTo(activitySessions, request.sessionId, request.day, tokens);
    }
  }

  /**
   * Load the project/session/turn identity rows and rebuild their aggregates
   * from the durable `requests` table. The request table is the single source
   * of truth, so a reload can never inherit incremental drift — but folds that
   * ran before the open settled are real and must be preserved, so their
   * aggregate contribution is re-applied on top of the rebuilt state.
   * @param {import('node:sqlite').DatabaseSync} db - the open database.
   * @param {object} stmts - prepared statements.
   */
  function loadDimensions(db, stmts) {
    for (const row of stmts.loadProjects.all()) {
      if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > MAX_PROJECT_ID_LENGTH) continue;
      const record = zeroProject(row.id);
      record.title = typeof row.title === 'string' && row.title.length > 0 ? row.title : projectTitleOf(row.id);
      record.firstTs = Number(row.first_ts);
      record.lastTs = Number(row.last_ts);
      projects.set(row.id, record);
    }
    for (const row of stmts.loadSessions.all()) {
      if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > MAX_SESSION_ID_LENGTH) continue;
      const record = zeroSession(row.id);
      record.projectId = typeof row.project_id === 'string' && row.project_id.length > 0 ? row.project_id : UNKNOWN_PROJECT;
      record.title = typeof row.title === 'string' && row.title.length > 0 ? row.title : null;
      record.parentId = typeof row.parent_id === 'string' ? row.parent_id : null;
      record.firstTs = Number(row.first_ts);
      record.lastTs = Number(row.last_ts);
      sessions.set(row.id, record);
    }
    for (const row of stmts.loadTurns.all()) {
      if (typeof row.session_id !== 'string' || row.session_id.length === 0) continue;
      const turnNumber = Number(row.turn);
      if (!Number.isSafeInteger(turnNumber) || turnNumber < 0) continue;
      const record = zeroTurn(row.session_id, sessions.get(row.session_id)?.projectId ?? UNKNOWN_PROJECT, turnNumber);
      record.startTs = row.start_ts === null ? null : Number(row.start_ts);
      record.endTs = row.end_ts === null ? null : Number(row.end_ts);
      turns.set(turnKeyOf(record.sessionId, record.turn), record);
    }
    // Snapshot the folds that happened before the open settled: they are not
    // in the durable tables yet, so rebuilding alone would erase them.
    const early = {
      projects: new Map([...projects].map(([id, record]) => [id, { bucket: { ...record.bucket }, title: record.title, firstTs: record.firstTs, lastTs: record.lastTs }])),
      sessions: new Map([...sessions].map(([id, record]) => [id, { bucket: { ...record.bucket }, title: record.title, projectId: record.projectId }])),
      turns: new Map([...turns].map(([key, record]) => [key, { bucket: { ...record.bucket } }])),
    };
    rebuildAggregates(stmts);
    for (const [id, saved] of early.projects) {
      const record = projects.get(id);
      if (record === undefined) {
        projects.set(id, { ...zeroProject(id), title: saved.title, firstTs: saved.firstTs, lastTs: saved.lastTs, bucket: saved.bucket });
        continue;
      }
      record.bucket = addRequestBuckets(record.bucket, saved.bucket);
      if (saved.firstTs !== null) record.firstTs = record.firstTs === null ? saved.firstTs : Math.min(record.firstTs, saved.firstTs);
      if (saved.lastTs !== null) record.lastTs = record.lastTs === null ? saved.lastTs : Math.max(record.lastTs, saved.lastTs);
      if (saved.bucket.requests > 0 && saved.title !== undefined) record.title = record.title || saved.title;
    }
    for (const [id, saved] of early.sessions) {
      const record = sessions.get(id);
      if (record === undefined) {
        sessions.set(id, { ...zeroSession(id), projectId: saved.projectId, title: saved.title, bucket: saved.bucket });
        continue;
      }
      record.bucket = addRequestBuckets(record.bucket, saved.bucket);
      if (saved.title !== null) record.title = record.title || saved.title;
    }
    for (const [key, saved] of early.turns) {
      const record = turns.get(key);
      if (record === undefined) {
        const [sessionId, turnText] = key.split('\u0000');
        turns.set(key, { ...zeroTurn(sessionId, sessions.get(sessionId)?.projectId ?? UNKNOWN_PROJECT, Number(turnText)), bucket: saved.bucket });
        continue;
      }
      record.bucket = addRequestBuckets(record.bucket, saved.bucket);
    }
    // Early-folded request rows still have to reach the database.
    for (const request of pendingRequests.values()) {
      dirtyProjects.add(request.projectId);
      dirtySessions.add(request.sessionId);
      dirtyTurns.add(turnKeyOf(request.sessionId, request.turn));
    }
    hydrateActivity(db);
  }

  /** Recompute every aggregate bucket from the durable `requests` table. */
  function rebuildAggregates(stmts) {
    for (const record of projects.values()) record.bucket = zeroRequest();
    for (const record of sessions.values()) record.bucket = zeroRequest();
    for (const record of turns.values()) record.bucket = zeroRequest();
    for (const row of stmts.sumRequestsByProject.all()) {
      if (!projects.has(row.id)) projects.set(row.id, zeroProject(row.id));
      projects.get(row.id).bucket = bucketFromSum(row);
    }
    for (const row of stmts.sumRequestsBySession.all()) {
      if (!sessions.has(row.id)) sessions.set(row.id, zeroSession(row.id));
      sessions.get(row.id).bucket = bucketFromSum(row);
    }
    for (const row of stmts.sumRequestsByTurn.all()) {
      const turnNumber = Number(row.turn);
      const key = turnKeyOf(row.session_id, turnNumber);
      if (!turns.has(key)) {
        const projectId = sessions.get(row.session_id)?.projectId ?? UNKNOWN_PROJECT;
        turns.set(key, zeroTurn(row.session_id, projectId, turnNumber));
      }
      turns.get(key).bucket = bucketFromSum(row);
    }
  }

  /** One aggregate bucket from a SQL SUM row. */
  function bucketFromSum(row) {
    return {
      input: Number(row.input) || 0,
      cacheRead: Number(row.cache_read) || 0,
      cacheWrite: Number(row.cache_write) || 0,
      output: Number(row.output) || 0,
      reasoning: Number(row.reasoning) || 0,
      requests: Number(row.requests) || 0,
    };
  }

  // ---- the fold -----------------------------------------------------------
  /**
   * Fold one committed session event into the in-memory records.
   * @param {object} session - the session identity used as a WeakMap key.
   * @param {object} event - the committed session event.
   */
  function fold(session, event) {
    if (event.type === 'session/title') {
      const title = typeof event.data?.title === 'string' ? event.data.title : '';
      if (title.length > 0 && title.length <= MAX_SESSION_TITLE_LENGTH) {
        const titleTime = safeTime(event.time);
        if (titleTime === null) return;
        const identity = identityOf(session, titleTime);
        const record = ensureSession(identity, titleTime);
        record.title = title;
        dirtySessions.add(record.id);
        scheduleFlush();
      }
      return;
    }
    if (event.type === 'request/header') {
      const header = event.data?.header?.config;
      if (header !== undefined && (typeof header.provider === 'string' || typeof header.model === 'string')) {
        headers.set(session, { provider: header.provider, model: header.model });
      }
      return;
    }
    if (event.type === 'turn/start') {
      const startTurn = safeIndex(event.data?.turn);
      const startTime = safeTime(event.time);
      if (startTurn === null || startTime === null) return;
      let starts = turnStarts.get(session);
      if (starts === undefined) {
        starts = new Map();
        turnStarts.set(session, starts);
      }
      starts.set(startTurn, startTime);
      const identity = identityOf(session, startTime);
      const turn = ensureTurn(identity, startTurn, startTime);
      turn.startTs = turn.startTs === null ? startTime : Math.min(turn.startTs, startTime);
      dirtyTurns.add(turnKeyOf(turn.sessionId, turn.turn));
      scheduleFlush();
      return;
    }
    if (event.type === 'turn/end') {
      const endTurn = safeIndex(event.data?.turn);
      const endTime = safeTime(event.time);
      if (endTurn === null || endTime === null) return;
      const starts = turnStarts.get(session);
      const start = starts?.get(endTurn);
      if (starts !== undefined) starts.delete(endTurn);
      if (start === undefined) return;
      const identity = identityOf(session, start);
      const turn = ensureTurn(identity, endTurn, start);
      // Never let a backwards timestamp shrink a turn: the stored pair must
      // satisfy endTs >= startTs so durationMs is meaningful.
      turn.endTs = turn.endTs === null ? endTime : Math.max(turn.endTs, endTime);
      dirtyTurns.add(turnKeyOf(turn.sessionId, turn.turn));
      const duration = Math.max(0, endTime - start);
      if (duration === 0) {
        scheduleFlush();
        return;
      }
      const dayKey = dayKeyOf(start);
      const day = days.get(dayKey) ?? zeroDay();
      setDay(dayKey, {
        ...day,
        turnMs: day.turnMs + duration,
        longestMs: Math.max(day.longestMs, duration),
        models: { ...day.models },
      });
      return;
    }
    if (event.type === 'llm/retry-started') {
      const slot = slots.get(session);
      if (slot !== undefined && slot !== null && slot.turn === event.data.turn && slot.step === event.data.step) slots.set(session, null);
      return;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
    const usage = usageOfEvent(event);
    if (usage === undefined) return;
    const buckets = bucketsOfUsage(usage);
    const requestBucket = requestBucketOf(usage);
    // Every field that reaches a STRICT SQLite column is validated here: an
    // unvalidated bind would poison the whole flush batch and, because the
    // dirty sets are retried, wedge persistence for the process lifetime.
    const turn = safeIndex(event.data.turn);
    const step = safeIndex(event.data.step);
    const eventTime = safeTime(event.time);
    if (eventTime === null) return; // cannot key a local day: skip the sample
    const previous = slots.get(session);
    const sameSlot = previous != null && turn !== null && step !== null
      && previous.turn === turn && previous.step === step ? previous : null;
    if (sameSlot !== null && sameBuckets(sameSlot.buckets, buckets)) return;
    // A replacement subtracts from the day its first sample landed on, so a
    // retry crossing midnight never double-counts.
    const dayKey = sameSlot !== null ? sameSlot.dayKey : dayKeyOf(eventTime);
    const modelId = modelLabelOf(headers.get(session));
    const current = days.get(dayKey) ?? zeroDay();
    const updated = sameSlot !== null
      ? addSample(removeSample(current, sameSlot.buckets, sameSlot.modelId), buckets, modelId)
      : addSample(current, buckets, modelId);
    setDay(dayKey, updated);
    // A malformed turn/step still contributes to the day totals above, but it
    // cannot be attributed to a conversation: keep it out of the dimensions.
    if (turn === null || step === null) return;
    // ---- the new dimensions ------------------------------------------------
    // A same-slot replacement overwrites its request row in place; a retry
    // keeps the previous row and adds a new attempt generation.
    const identity = identityOf(session, eventTime);
    const attempt = sameSlot !== null ? sameSlot.attempt : nextAttemptOf(session, turn, step);
    const requestId = sameSlot !== null ? sameSlot.requestId : `${identity.sessionId}|${requestRunId}|${++requestSeq}`;
    recordRequest(identity, turn, step, attempt, requestId, eventTime, dayKey, modelId, requestBucket);
    slots.set(session, { turn, step, buckets, dayKey, modelId, attempt, requestId });
  }

  ctx.on('session/event', (session, event) => {
    if (!ready) {
      if (pendingEvents.length < MAX_PENDING_EVENTS) {
        pendingEvents.push([session, event]);
        return;
      }
      ctx.logger.warn('token-usage-stats: startup event buffer full, folding without loaded history');
    }
    safeFold(session, event);
  });

  // ---- the wire summary ---------------------------------------------------
  const summary = () => {
    const now = new Date();
    const todayKey = dayKeyOf(now.getTime());
    const weekStart = weekStartKeyOf(now);
    const monthStart = monthStartKeyOf(now);
    const rangeRecords = (startKey, endKey) => {
      const records = [];
      for (let key = startKey; key <= endKey;) {
        records.push(days.get(key) ?? zeroDay());
        key = nextDayKey(key);
      }
      return records;
    };
    const sortedKeys = [...days.keys()].sort();
    const allRows = sortedKeys.map((key) => dayRowOf(key, days.get(key)));
    let peak = { date: null, total: 0 };
    for (const row of allRows) if (row.total > peak.total) peak = { date: row.date, total: row.total };
    const streaks = streakStats(dayRows(Math.max(HEATMAP_DAYS, retentionDays), now, days));
    let longestTurnMs = 0;
    for (const record of days.values()) if (record.longestMs > longestTurnMs) longestTurnMs = record.longestMs;
    const models = new Map();
    for (const record of days.values()) {
      for (const [id, buckets] of Object.entries(record.models)) {
        let entry = models.get(id);
        if (entry === undefined) {
          entry = zeroModel();
          models.set(id, entry);
        }
        entry.input += buckets.input;
        entry.output += buckets.output;
        entry.cacheRead += buckets.cacheRead;
        entry.cacheWrite += buckets.cacheWrite;
        entry.settlements += buckets.settlements;
      }
    }
    const modelRows = [...models.entries()]
      .map(([id, buckets]) => ({ id, ...buckets, total: buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite }))
      .sort((a, b) => b.total - a.total);
    const projectRows = [...projects.values()]
      .map((record) => ({
        id: record.id,
        title: record.title,
        sessions: countSessionsOf(record.id),
        ...requestRowOf(record.bucket),
        firstTs: record.firstTs,
        lastTs: record.lastTs,
      }))
      .sort((a, b) => b.total - a.total);
    const sessionRows = [...sessions.values()]
      .map(sessionRowOf)
      .sort((a, b) => b.total - a.total);
    const turnRows = [...turns.values()]
      .map(turnRowOf)
      .sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0));
    return {
      v: 3,
      now: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      today: periodOf(todayKey, todayKey, [days.get(todayKey) ?? zeroDay()]),
      week: periodOf(weekStart, todayKey, rangeRecords(weekStart, todayKey)),
      month: periodOf(monthStart, todayKey, rangeRecords(monthStart, todayKey)),
      recent: dayRows(detailDays, now, days),
      trend: dayRows(TREND_DAYS, now, days),
      heatmap: dayRows(HEATMAP_DAYS, now, days),
      stats: {
        peak,
        longestTurnMs,
        activeDays: streaks.activeDays,
        currentStreak: streaks.currentStreak,
        longestStreak: streaks.longestStreak,
      },
      models: modelRows,
      allTime: sumDays([...days.values()]),
      requestCount: projectRows.reduce((sum, row) => sum + row.requests, 0),
      projects: projectRows,
      sessions: sessionRows.slice(0, SUMMARY_SESSION_ROWS),
      turns: turnRows.slice(0, SUMMARY_TURN_ROWS),
      persisted: state.db !== null,
    };
  };

  /**
   * The workspace-activity distribution: every project and the most active
   * sessions, each with a zero-filled per-day token series for the last
   * ACTIVITY_DAYS days. Totals are all-time, matching the summary rows, so the
   * strip reads as "how recently / how much this identity worked".
   * @returns {object} the wire payload.
   */
  const activityOf = () => {
    const now = new Date();
    const dayKeys = [];
    for (let index = ACTIVITY_DAYS - 1; index >= 0; index -= 1) dayKeys.push(dayKeyOf(now.getTime() - index * 86400000));
    const indexOfDay = new Map(dayKeys.map((key, index) => [key, index]));
    const seriesOf = (map, id) => {
      const series = new Array(dayKeys.length).fill(0);
      const buckets = map.get(id);
      if (buckets !== undefined) {
        for (const [day, tokens] of buckets) {
          const index = indexOfDay.get(day);
          if (index !== undefined) series[index] = tokens;
        }
      }
      return series;
    };
    const workspaceRows = [...projects.values()]
      .map((record) => ({
        id: record.id,
        title: record.title,
        sessions: countSessionsOf(record.id),
        ...requestRowOf(record.bucket),
        series: seriesOf(activityProjects, record.id),
      }))
      .sort((a, b) => b.total - a.total);
    const allSessionRows = [...sessions.values()]
      .map(sessionRowOf)
      .sort((a, b) => b.total - a.total);
    const sessionRows = allSessionRows
      .slice(0, ACTIVITY_SESSION_ROWS)
      .map((row) => ({ ...row, series: seriesOf(activitySessions, row.id) }));
    const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
    return {
      v: 1,
      now: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      days: dayKeys,
      workspaces: workspaceRows,
      workspaceTotal: sum(workspaceRows, 'total'),
      workspaceSessions: sum(workspaceRows, 'sessions'),
      workspaceRequests: sum(workspaceRows, 'requests'),
      sessions: sessionRows,
      sessionTotal: sum(allSessionRows, 'total'),
      sessionRequests: sum(allSessionRows, 'requests'),
      truncatedSessions: allSessionRows.length > sessionRows.length,
    };
  };

  /**
   * The remaining dashboard charts: hour x day activity, 24-hour model
   * activity, the daily model mix, and the per-model request-size
   * distribution. Every series is derived on demand from the retained
   * `requests` rows (or the in-memory pending rows without SQLite), so no
   * additional state has to be persisted.
   * @returns {object} the wire payload.
   */
  const insightsOf = () => {
    const now = new Date();
    const hourlyKeys = [];
    for (let index = HOURLY_DAYS - 1; index >= 0; index -= 1) hourlyKeys.push(dayKeyOf(now.getTime() - index * 86400000));
    const hourlyIndex = new Map(hourlyKeys.map((key, index) => [key, index]));
    const byDay = hourlyKeys.map((day) => ({ day, hours: new Array(24).fill(0) }));
    const hourlyTotals = new Array(24).fill(0);
    const modelHours = new Map();
    const modelSizes = new Map();
    const sizeCutoff = dayKeyOf(now.getTime() - SIZE_WINDOW_DAYS * 86400000);
    const modelOf = (row) => (typeof row.model === 'string' && row.model.length > 0 ? row.model : UNKNOWN_MODEL);
    const ingest = (row) => {
      const tokens = (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? row.cache_read ?? 0) + (row.cacheWrite ?? row.cache_write ?? 0);
      const ts = Number(row.ts);
      if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(ts)) return;
      const day = typeof row.day === 'string' ? row.day : '';
      const hour = new Date(ts).getHours();
      const daySlot = hourlyIndex.get(day);
      if (daySlot !== undefined) {
        byDay[daySlot].hours[hour] += tokens;
        hourlyTotals[hour] += tokens;
        const model = modelOf(row);
        let hours = modelHours.get(model);
        if (hours === undefined) {
          hours = new Array(24).fill(0);
          modelHours.set(model, hours);
        }
        hours[hour] += tokens;
      }
      if (day >= sizeCutoff) {
        const model = modelOf(row);
        let values = modelSizes.get(model);
        if (values === undefined) {
          values = [];
          modelSizes.set(model, values);
        }
        values.push(tokens);
      }
    };
    const current = state;
    if (current.db !== null) {
      const rows = current.db.prepare(
        'SELECT day, ts, model, input, output, cache_read, cache_write FROM requests WHERE day >= ?',
      ).all(sizeCutoff);
      for (const row of rows) ingest(row);
    }
    for (const row of pendingRequests.values()) ingest(row);

    const windowTotal = hourlyTotals.reduce((sum, value) => sum + value, 0);
    const buckets = [['night', 0, 6], ['morning', 6, 12], ['afternoon', 12, 18], ['evening', 18, 24]].map(([id, from, to]) => {
      let tokens = 0;
      for (let hour = from; hour < to; hour += 1) tokens += hourlyTotals[hour];
      return { id, from, to, tokens, share: windowTotal > 0 ? tokens / windowTotal : 0 };
    });
    const modelHourRows = [...modelHours.entries()]
      .map(([model, hours]) => ({ model, hours, total: hours.reduce((sum, value) => sum + value, 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    const dailyKeys = [];
    for (let index = DAILY_MODEL_DAYS - 1; index >= 0; index -= 1) dailyKeys.push(dayKeyOf(now.getTime() - index * 86400000));
    const totalsByModel = new Map();
    const rawDaily = dailyKeys.map((dayKey) => {
      const record = days.get(dayKey);
      const models = {};
      if (record !== undefined) {
        for (const [id, bucket] of Object.entries(record.models)) {
          const tokens = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
          if (tokens <= 0) continue;
          models[id] = tokens;
          totalsByModel.set(id, (totalsByModel.get(id) || 0) + tokens);
        }
      }
      return { day: dayKey, models };
    });
    const rankedModels = [...totalsByModel.entries()].sort((a, b) => b[1] - a[1]);
    const topModels = rankedModels.slice(0, 8).map(([id]) => id);
    const topSet = new Set(topModels);
    const dailyRows = rawDaily.map((row) => {
      const models = {};
      let other = 0;
      for (const [id, tokens] of Object.entries(row.models)) {
        if (topSet.has(id)) models[id] = tokens;
        else other += tokens;
      }
      if (other > 0) models.other = other;
      return { day: row.day, models };
    });
    const dailyLegend = topModels.map((id) => ({ id, total: totalsByModel.get(id) || 0 }));
    if (rankedModels.length > topModels.length) {
      dailyLegend.push({ id: 'other', total: rankedModels.slice(topModels.length).reduce((sum, [, value]) => sum + value, 0) });
    }

    const sizeModels = [...modelSizes.entries()]
      .map(([model, values]) => ({ model, values }))
      .sort((a, b) => b.values.length - a.values.length)
      .slice(0, SIZE_MODELS);
    const allValues = [];
    for (const entry of sizeModels) allValues.push(...entry.values);
    const axisMax = Math.max(1, percentileOf(allValues.slice().sort((a, b) => a - b), 0.99));
    const sizeRows = sizeModels.map((entry) => {
      const sorted = entry.values.slice().sort((a, b) => a - b);
      const histogram = new Array(SIZE_BUCKETS).fill(0);
      let max = 0;
      for (const value of entry.values) {
        if (value > max) max = value;
        const slot = Math.min(SIZE_BUCKETS - 1, Math.floor((value / axisMax) * SIZE_BUCKETS));
        histogram[slot] += 1;
      }
      return {
        model: entry.model,
        count: entry.values.length,
        p50: percentileOf(sorted, 0.5),
        p90: percentileOf(sorted, 0.9),
        max,
        buckets: histogram,
      };
    });

    return {
      v: 1,
      now: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      hourly: { days: hourlyKeys, hours: 24, byDay, byModel: modelHourRows, buckets, total: windowTotal },
      daily: { days: dailyRows, models: dailyLegend },
      sizes: {
        total: sizeRows.reduce((sum, row) => sum + row.count, 0),
        axisMax,
        buckets: SIZE_BUCKETS,
        models: sizeRows,
      },
    };
  };

  /** How many sessions one project owns. */
  function countSessionsOf(projectId) {    let count = 0;
    for (const record of sessions.values()) if (record.projectId === projectId) count += 1;
    return count;
  }

  /** The public row shape of one session aggregate. */
  function sessionRowOf(record) {
    const project = projects.get(record.projectId);
    return {
      id: record.id,
      project: record.projectId,
      projectTitle: project?.title ?? projectTitleOf(record.projectId),
      title: record.title,
      ...requestRowOf(record.bucket),
      firstTs: record.firstTs,
      lastTs: record.lastTs,
    };
  }

  /** The public row shape of one turn aggregate. */
  function turnRowOf(record) {
    const session = sessions.get(record.sessionId);
    const projectId = session?.projectId ?? record.projectId;
    const project = projects.get(projectId);
    const durationMs = record.startTs !== null && record.endTs !== null ? Math.max(0, record.endTs - record.startTs) : null;
    return {
      sessionId: record.sessionId,
      project: projectId,
      projectTitle: project?.title ?? projectTitleOf(projectId),
      sessionTitle: session?.title ?? null,
      turn: record.turn,
      startTs: record.startTs,
      endTs: record.endTs,
      durationMs,
      ...requestRowOf(record.bucket),
    };
  }

  /**
   * One dimension slice for the breakdown route.
   * @param {'project'|'session'|'turn'} by - the dimension.
   * @param {{ project?: string, session?: string, limit: number }} query - filters.
   * @returns {{ by: string, rows: object[], totals: object }}
   */
  function breakdownOf(by, query) {
    const limit = query.limit;
    if (by === 'session') {
      const rows = [...sessions.values()]
        .filter((record) => query.project === undefined || record.projectId === query.project)
        .map(sessionRowOf)
        .sort((a, b) => b.total - a.total);
      return { by, rows: rows.slice(0, limit), totals: totalsOf(rows) };
    }
    if (by === 'turn') {
      const rows = [...turns.values()]
        .filter((record) => query.session === undefined || record.sessionId === query.session)
        .filter((record) => query.project === undefined || (sessions.get(record.sessionId)?.projectId ?? record.projectId) === query.project)
        .map(turnRowOf)
        .sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0));
      return { by, rows: rows.slice(0, limit), totals: totalsOf(rows) };
    }
    const rows = [...projects.values()]
      .map((record) => ({
        id: record.id,
        title: record.title,
        sessions: countSessionsOf(record.id),
        ...requestRowOf(record.bucket),
        firstTs: record.firstTs,
        lastTs: record.lastTs,
      }))
      .sort((a, b) => b.total - a.total);
    return { by: 'project', rows: rows.slice(0, limit), totals: totalsOf(rows) };
  }

  /** Sum the public rows of one dimension into a totals object. */
  function totalsOf(rows) {
    const totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
    for (const row of rows) {
      totals.requests += row.requests;
      totals.input += row.input;
      totals.cacheRead += row.cacheRead;
      totals.cacheWrite += row.cacheWrite;
      totals.output += row.output;
      totals.reasoning += row.reasoning;
      totals.total += row.total;
    }
    return totals;
  }

  // ---- HTTP route for the Client bar + dashboard ---------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SERVICE_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const body = JSON.stringify(summary());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  }), 'dsh-token-usage-stats: http route');

  // ---- breakdown route for the project/session/turn drill-down -------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BREAKDOWN_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      let payload;
      try {
        payload = breakdownOf(...parseBreakdownQuery(req.url));
      } catch (error) {
        const body = JSON.stringify({ error: error?.message ?? String(error) });
        res.writeHead(400, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  }), 'dsh-token-usage-stats: breakdown route');

  // ---- workspace activity distribution (dashboard section) ------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTIVITY_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const body = JSON.stringify(activityOf());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  }), 'dsh-token-usage-stats: activity route');

  // ---- hourly / model / request-size charts (dashboard sections) ------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INSIGHTS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const body = JSON.stringify(insightsOf());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  }), 'dsh-token-usage-stats: insights route');

  // ---- /tokenstats slash command (optional) --------------------------------
  ctx.inject(['commands'], () => ctx.commands.register({
    name: 'tokenstats',
    description: '统计今日 / 本周 / 本月的 Token 用量（--json 机器可读）',
    input: { hint: '[--json]' },
    handler: async ({ rawInput }) => {
      await opened;
      const data = summary();
      if (typeof rawInput === 'string' && rawInput.includes('--json')) {
        return { kind: 'success', text: JSON.stringify(data, null, 2) };
      }
      const fmt = (n) => n.toLocaleString('en-US');
      const duration = (ms) => {
        const minutes = Math.round(ms / 60000);
        if (minutes < 60) return `${minutes} 分钟`;
        return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
      };
      const line = (label, period) => `${label} ${period.start === period.end ? period.start : `${period.start} ~ ${period.end}`}: 总计 ${fmt(period.total)}（输入 ${fmt(period.input)} · 输出 ${fmt(period.output)} · 缓存读 ${fmt(period.cacheRead)} · 缓存写 ${fmt(period.cacheWrite)} · 请求 ${fmt(period.settlements)}）`;
      const modelLines = data.models.slice(0, 5).map((row) => `  ${row.id} — ${fmt(row.total)}（${fmt(row.settlements)} 次）`);
      const projectLines = data.projects.slice(0, 5).map((row) => `  ${row.title} — ${fmt(row.total)}（${fmt(row.requests)} 次 / ${fmt(row.sessions)} 个会话）`);
      const recentLines = data.recent
        .filter((day) => day.total > 0)
        .map((day) => `  ${day.date}  ${fmt(day.total)}`)
        .join('\n');
      const text = [
        `Token 用量统计（本地时区 ${data.timeZone ?? 'local'}）`,
        line('今日', data.today),
        line('本周', data.week),
        line('本月', data.month),
        `累计 ${fmt(data.allTime.total)} · 峰值 ${data.stats.peak.date ?? '—'} ${fmt(data.stats.peak.total)} · 活跃 ${data.stats.activeDays} 天`,
        `连续 ${data.stats.currentStreak} 天（最长 ${data.stats.longestStreak} 天）· 最长单轮 ${duration(data.stats.longestTurnMs)}`,
        projectLines.length > 0 ? `项目用量：\n${projectLines.join('\n')}` : '',
        modelLines.length > 0 ? `模型用量：\n${modelLines.join('\n')}` : '',
        recentLines ? `近 ${data.recent.length} 天：\n${recentLines}` : '',
        data.persisted ? '' : '（SQLite 不可用：仅内存统计，重启后清零）',
      ].filter(Boolean).join('\n');
      return { kind: 'success', text };
    },
  }), 'dsh-token-usage-stats: command');
}
