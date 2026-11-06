/**
 * Unit tests for the session-log reader (`history.js`).
 *
 * Covers the concatenated-frame Zstandard container, the highest-generation
 * selection when a migrated session keeps its old file, the header-only fast
 * path, torn-tail tolerance, and corruption reporting.
 *
 * Usage: node --test test/history.test.mjs   (from the plugin directory)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { decodeLog, listSessionLogs, parseRecords, readHeader, readSessionRecords, scanZstdFrames } from '../history.js';
import { assistantMessage, compressFrame, sessionLogBytes, writeSessionLog } from './session-log-fixture.mjs';

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

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'tus-history-'));
  scratchDirs.push(dir);
  return dir;
}

const BASE = new Date(2026, 9, 20, 12, 0, 0).getTime();
const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 5 };

test('decodes every frame of a concatenated-frame log', () => {
  const dir = scratch();
  const records = [assistantMessage(1, 0, usage, BASE), assistantMessage(1, 1, usage, BASE + 1000)];
  const path = writeSessionLog(dir, { id: 'multi', records, perFrame: 1 });
  const text = decodeLog(path);
  assert.equal(text.trim().split('\n').length, 3, 'header + one line per frame');
  const parsed = readSessionRecords(path);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].type, 'session');
  assert.equal(parsed[1].type, 'assistant/message');
  assert.deepEqual(parsed[1].data.usage, usage);

  const bytes = Buffer.from(sessionLogBytes({ type: 'session', id: 'x' }, records, { perFrame: 1 }));
  const { frames } = scanZstdFrames(bytes);
  assert.equal(frames.length, 3);
  assert.ok(frames.every((frame) => frame.end > frame.start));
});

test('reads only the header record for the fast skip path', () => {
  const dir = scratch();
  const path = writeSessionLog(dir, { id: 'header-only', cwd: 'E:\\project\\demo', records: [assistantMessage(1, 0, usage, BASE)] });
  const header = readHeader(path);
  assert.equal(header.type, 'session');
  assert.equal(header.id, 'header-only');
  assert.equal(header.cwd, 'E:\\project\\demo');
});

test('the highest format generation of a session wins', () => {
  const dir = scratch();
  const v0 = writeSessionLog(dir, { id: 'migrated', version: 0, records: [assistantMessage(1, 0, usage, BASE)] });
  const v4 = writeSessionLog(dir, { id: 'migrated', version: 4, records: [assistantMessage(1, 0, usage, BASE)] });
  const logs = listSessionLogs(dir);
  assert.equal(logs.length, 1, 'one entry per session directory');
  assert.equal(logs[0].path, v4);
  assert.equal(logs[0].version, 4);
  assert.notEqual(logs[0].path, v0);
});

test('uncompressed logs are read line by line', () => {
  const dir = scratch();
  const path = writeSessionLog(dir, { id: 'plain', compressed: false, records: [assistantMessage(1, 0, usage, BASE)] });
  assert.equal(readSessionRecords(path).length, 2);
});

test('a torn final frame is ignored, not fatal', () => {
  const dir = scratch();
  const path = writeSessionLog(dir, { id: 'torn', records: [assistantMessage(1, 0, usage, BASE)] });
  const whole = readFileSync(path);
  const torn = Buffer.concat([whole, compressFrame('{"type":"assistant/message","time":1').subarray(0, 12)]);
  writeFileSync(path, torn);
  const parsed = readSessionRecords(path);
  assert.equal(parsed.length, 2, 'the complete frames still decode');
});

test('a corrupt frame is reported instead of silently dropped', () => {
  const dir = scratch();
  const path = writeSessionLog(dir, { id: 'corrupt', records: [assistantMessage(1, 0, usage, BASE)] });
  const bytes = readFileSync(path);
  // Break the second frame's magic number.
  const { frames } = scanZstdFrames(bytes);
  const second = frames[1];
  const damaged = Buffer.from(bytes);
  damaged.writeUInt32LE(0, second.start);
  writeFileSync(path, damaged);
  assert.throws(() => decodeLog(path), /invalid frame magic/);
});

test('a missing root lists nothing', () => {
  assert.deepEqual(listSessionLogs(join(scratch(), 'nope')), []);
});

test('parseRecords skips blank and malformed lines', () => {
  const records = parseRecords('{"type":"a"}\n\nnot json\n{"type":"b"}\n');
  assert.deepEqual(records.map((record) => record.type), ['a', 'b']);
});

