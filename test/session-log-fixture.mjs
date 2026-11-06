/**
 * Session-log fixtures for the history/backfill tests.
 *
 * The Host writes each session as `session.jsonl[.zstd]` (v0) or
 * `session.vN.jsonl[.zstd]`, where the compressed form is a concatenation of
 * independently decodable Zstandard frames: one header frame followed by one
 * frame per committed append batch. These helpers reproduce that container so
 * the reader is exercised against the real layout (including a multi-frame
 * body and a torn tail).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

/** Compress one frame the way the Host does (checksummed). */
export function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
}

/**
 * Build one session-log file body.
 * @param {object} header - the `session` header record.
 * @param {object[]} records - the event records appended after the header.
 * @param {{ perFrame?: number, compressed?: boolean }} [options] - `perFrame`
 *   records per append frame (1 reproduces one-frame-per-commit).
 * @returns {Buffer} the file bytes.
 */
export function sessionLogBytes(header, records, { perFrame = 1, compressed = true } = {}) {
  const lines = records.map((record) => `${JSON.stringify(record)}\n`);
  if (!compressed) return Buffer.from(`${JSON.stringify(header)}\n${lines.join('')}`, 'utf8');
  const parts = [compressFrame(`${JSON.stringify(header)}\n`)];
  for (let index = 0; index < lines.length; index += perFrame) {
    parts.push(compressFrame(lines.slice(index, index + perFrame).join('')));
  }
  return Buffer.concat(parts);
}

/**
 * Write one session log into a sessions root, creating the project directory.
 * @param {string} root - the sessions root.
 * @param {{ id: string, cwd?: string, createdAt?: number, records?: object[],
 *   version?: number, compressed?: boolean, perFrame?: number }} options
 * @returns {string} the written path.
 */
export function writeSessionLog(root, options) {
  const {
    id,
    cwd = 'E:\\project\\demo',
    createdAt = new Date(2026, 9, 20, 12, 0, 0).getTime(),
    records = [],
    version = 4,
    compressed = true,
    perFrame = 1,
  } = options;
  const projectDir = join(root, '--E-project-demo--');
  // Real logs live in `session-<uuid>/`; the reader keys off the header id, so
  // the directory name only has to be unique.
  const sessionDir = join(projectDir, id);
  mkdirSync(sessionDir, { recursive: true });
  const suffix = version === 0 ? '' : `.v${version}`;
  const path = join(sessionDir, `session${suffix}.jsonl${compressed ? '.zstd' : ''}`);
  writeFileSync(path, sessionLogBytes({ type: 'session', version, id, createdAt, cwd, delegationDepth: 0 }, records, { perFrame, compressed }));
  return path;
}

/** One usage settlement record. */
export function assistantMessage(turn, step, usage, time) {
  return { type: 'assistant/message', seq: 1, time, data: { turn, step, usage } };
}

/** One `request/header` record carrying the provider/model attribution. */
export function requestHeader(provider, model, time) {
  return { type: 'request/header', time, data: { header: { config: { provider, model } } } };
}

/** One turn boundary record. */
export function turnStart(turn, time) {
  return { type: 'turn/start', time, data: { turn } };
}

/** One turn boundary record. */
export function turnEnd(turn, time) {
  return { type: 'turn/end', time, data: { turn } };
}

/** One session title record. */
export function sessionTitle(title, time) {
  return { type: 'session/title', time, data: { title } };
}
