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
 * Persistence: the `token_usage_stats` storage domain (table `days`, keyed
 * by `YYYY-MM-DD`), served by the profile's storage hub + json backend +
 * domain form. The domain spec is a plain object; the table's `valueSchema`
 * only needs `parse`, which keeps this bundle free of external package
 * imports so it resolves under any profile installation layout. Records
 * written by v1 (scalars only) load unchanged; new fields default to 0/{}.
 *
 * Client data path: an exact `webServer` route (`/api/token-stats`) returns
 * the JSON summary; the browser fetches it same-origin (cookies ride along).
 * No remote-service protocol import is required.
 *
 * Optional services degrade instead of failing the bundle: the fold and the
 * HTTP route require `storageDomain` + `webServer` (declared `inject`); the
 * slash command mounts only when `commands` is present.
 */
const SERVICE_ROUTE = '/api/token-stats';
const DOMAIN_NAME = 'token_usage_stats';
const TABLE_DAYS = 'days';
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEATMAP_DAYS = 365;
const TREND_DAYS = 30;
const MAX_MODELS_PER_DAY = 24;
const UNKNOWN_MODEL = 'unknown';

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
 * Validate and normalize one stored day record. Doubles as the domain
 * table's zod-compatible schema surface (`parse` is the only method the
 * domain layer calls for table records). The `models` map is best-effort:
 * a malformed map or entry is dropped instead of failing the whole record,
 * because scalars remain a valid v1 record.
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
      if (typeof id !== 'string' || id.length === 0 || id.length > 160) continue;
      try {
        day.models[id] = parseModelBuckets(buckets);
      } catch {
        // Best-effort: skip a malformed model entry, keep the rest.
      }
    }
  }
  return day;
}

/** The domain spec: plain data, no external schema library required. */
const tokenStatsDomainSpec = {
  name: DOMAIN_NAME,
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { [TABLE_DAYS]: { valueSchema: { parse: parseDayRecord } } },
};

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

/** Zero-filled ascending day rows for the last `count` local days. */
function dayRows(count, now, days) {
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

export const inject = ['storageDomain', 'webServer'];

export function apply(ctx, config) {
  const retentionDays = Number.isSafeInteger(config?.retentionDays) && config.retentionDays > 0 ? config.retentionDays : 400;
  const detailDays = Number.isSafeInteger(config?.detailDays) && config.detailDays > 0 ? config.detailDays : 14;

  /** @type {Map<string, ReturnType<typeof zeroDay>>} day key -> record */
  const days = new Map();
  /** Day keys whose in-memory record outruns the durable table. */
  const dirtyKeys = new Set();
  /** Per-session attempt slot: replacement bookkeeping (WeakMap, no leak). */
  const slots = new WeakMap();
  /** Per-session open-turn start times by turn number. */
  const turnStarts = new WeakMap();
  /** Per-session latest request-header provider/model. */
  const headers = new WeakMap();
  let table = null;
  let domain = null;
  let flushChain = Promise.resolve();

  /** Coalesce pending day writes onto one ordered chain. */
  const scheduleFlush = () => {
    flushChain = flushChain.then(async () => {
      if (dirtyKeys.size === 0 || table === null) return;
      const keys = [...dirtyKeys];
      dirtyKeys.clear();
      for (const key of keys) {
        const record = days.get(key);
        if (table === null) return;
        if (record === undefined) await table.delete(key).catch(() => {});
        else await table.put(key, { ...record, models: { ...record.models } });
      }
      await pruneOld();
    }).catch((error) => {
      ctx.logger.warn('token-usage-stats: persist failed: %s', error?.message ?? String(error));
    });
  };

  /** Drop day records older than the retention window. */
  const pruneOld = async () => {
    const cutoff = dayKeyOf(Date.now() - retentionDays * 86400000);
    for (const key of [...days.keys()]) {
      if (key < cutoff) {
        days.delete(key);
        dirtyKeys.add(key); // absent record -> delete on the table
      }
    }
  };

  /** Apply one in-memory day mutation and schedule its persist. */
  const setDay = (dayKey, record) => {
    days.set(dayKey, record);
    dirtyKeys.add(dayKey);
    scheduleFlush();
  };

  // Open the durable domain; failures degrade to memory-only statistics.
  const opened = Promise.resolve(ctx.storageDomain.open(tokenStatsDomainSpec)).then((handle) => {
    domain = handle;
    table = handle.table(TABLE_DAYS);
    for (const [key, record] of table.entries()) {
      if (!DAY_KEY_RE.test(key)) continue;
      try {
        days.set(key, parseDayRecord(record));
      } catch {
        // A record the domain already accepted but this build rejects: keep
        // the stored value out of aggregates rather than crash the fold.
      }
    }
    ctx.effect(() => () => {
      const handle = domain;
      domain = null;
      table = null;
      return handle ? handle.close() : undefined;
    }, 'dsh-token-usage-stats: domain close');
    return pruneOld().then(scheduleFlush);
  }).catch((error) => {
    ctx.logger.warn('token-usage-stats: storage domain unavailable, running memory-only: %s', error?.message ?? String(error));
  });

  // ---- the fold -----------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      const config = event.data?.header?.config;
      if (config !== undefined && (typeof config.provider === 'string' || typeof config.model === 'string')) {
        headers.set(session, { provider: config.provider, model: config.model });
      }
      return;
    }
    if (event.type === 'turn/start') {
      let starts = turnStarts.get(session);
      if (starts === undefined) {
        starts = new Map();
        turnStarts.set(session, starts);
      }
      starts.set(event.data.turn, event.time);
      return;
    }
    if (event.type === 'turn/end') {
      const starts = turnStarts.get(session);
      const start = starts?.get(event.data.turn);
      if (starts !== undefined) starts.delete(event.data.turn);
      if (start === undefined) return;
      const duration = Math.max(0, event.time - start);
      if (duration === 0) return;
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
    const turn = event.data.turn;
    const step = event.data.step;
    const previous = slots.get(session);
    const sameSlot = previous != null && previous.turn === turn && previous.step === step ? previous : null;
    if (sameSlot !== null && sameBuckets(sameSlot.buckets, buckets)) return;
    // A replacement subtracts from the day its first sample landed on, so a
    // retry crossing midnight never double-counts.
    const dayKey = sameSlot !== null ? sameSlot.dayKey : dayKeyOf(event.time);
    const modelId = modelLabelOf(headers.get(session));
    const current = days.get(dayKey) ?? zeroDay();
    const updated = sameSlot !== null
      ? addSample(removeSample(current, sameSlot.buckets, sameSlot.modelId), buckets, modelId)
      : addSample(current, buckets, modelId);
    setDay(dayKey, updated);
    slots.set(session, { turn, step, buckets, dayKey, modelId });
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
    return {
      v: 2,
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
      persisted: table !== null,
    };
  };

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
        modelLines.length > 0 ? `模型用量：\n${modelLines.join('\n')}` : '',
        recentLines ? `近 ${data.recent.length} 天：\n${recentLines}` : '',
        data.persisted ? '' : '（存储域不可用：仅内存统计，重启后清零）',
      ].filter(Boolean).join('\n');
      return { kind: 'success', text };
    },
  }), 'dsh-token-usage-stats: command');
}
