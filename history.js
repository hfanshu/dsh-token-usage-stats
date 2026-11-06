/**
 * Session-log history reader for dsh-token-usage-stats.
 *
 * The Host persists every session as an append-only JSONL log under
 * `$DSH_HOME/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`. With the
 * default `zstd` encoding the file is a concatenation of independently
 * decodable Zstandard frames — one header frame, then one frame per committed
 * append batch — so Node's one-shot decoder only yields the first frame. This
 * module walks the frame structure (magic, frame header, block headers) and
 * decodes every frame; a structurally incomplete final frame (an interrupted
 * write) is ignored, exactly like the Host's own reader.
 *
 * Only the highest format generation of a session directory is read: a
 * migrated session keeps its old file beside the new one and both describe the
 * same events, so reading both would double count. Both generations store the
 * same logical records (`{ type, time, data, seq }`), which is the event shape
 * the live fold already consumes.
 *
 * Everything here is synchronous and built on Node built-ins only; the caller
 * decides when to run it and how to pace it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

/** Zstandard frame magic (`0xFD2FB528`, little-endian on disk). */
const ZSTD_MAGIC = 0xfd2fb528;
/** `session.jsonl[.zstd]` (v0) or `session.vN.jsonl[.zstd]`. */
const LOG_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
/** How deep the session tree is walked (project directory -> session directory). */
const MAX_DEPTH = 6;

/**
 * Locate complete Zstandard frames without decoding their blocks.
 *
 * Ported from the Host's persistence reader: a truncated tail yields the
 * frames found so far plus `tornStart`, anything structurally invalid rejects.
 *
 * @param {Buffer} buffer - the bytes currently present in the log file.
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart?: number }}
 * @throws {Error} when a complete frame is structurally invalid.
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** `node:zlib` implements Zstandard from Node 22.15 / 23.8 on. */
export function supportsZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * Decompress one complete frame.
 * @param {Buffer} bytes - exactly one framed payload.
 * @returns {Buffer} the plaintext.
 * @throws {Error} when the runtime has no Zstandard decoder.
 */
function decompressFrame(bytes) {
  const decode = zlib.zstdDecompressSync;
  if (typeof decode !== 'function') throw new Error('this Node runtime has no Zstandard decoder (needs node:zlib zstd, Node >= 22.15)');
  return decode(bytes);
}

/**
 * Decode the whole log file to UTF-8 text.
 * @param {string} path - the session log path.
 * @returns {string} the concatenated plaintext of every complete frame.
 * @throws {Error} when the file cannot be read or a frame is corrupt.
 */
export function decodeLog(path) {
  const bytes = readFileSync(path);
  if (!path.endsWith('.zstd')) return bytes.toString('utf8');
  const { frames } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log');
  const parts = [];
  for (const frame of frames) parts.push(decompressFrame(bytes.subarray(frame.start, frame.end)));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Parse JSONL records, skipping blank and malformed lines.
 * @param {string} text - the decoded log body.
 * @returns {object[]} the parsed records in file order.
 */
export function parseRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record !== null && typeof record === 'object') records.push(record);
    } catch {
      // A malformed line in one batch must not discard the whole session.
    }
  }
  return records;
}

/**
 * Read only the header record. The header is its own first frame, so a session
 * that is already tracked can be skipped without decoding the event frames.
 * @param {string} path - the session log path.
 * @returns {object|null} the header record (`{ type: 'session', id, cwd, … }`).
 * @throws {Error} when the first frame is corrupt.
 */
export function readHeader(path) {
  const bytes = readFileSync(path);
  let firstLine = '';
  if (path.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(bytes);
    if (frames.length === 0) return null;
    firstLine = decompressFrame(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8');
  } else {
    const newline = bytes.indexOf(10);
    firstLine = (newline === -1 ? bytes : bytes.subarray(0, newline)).toString('utf8');
  }
  for (const record of parseRecords(firstLine)) {
    return record.type === 'session' ? record : null;
  }
  return null;
}

/**
 * Read every record of one session log.
 * @param {string} path - the session log path.
 * @returns {object[]} the parsed records.
 * @throws {Error} when the file cannot be read or a frame is corrupt.
 */
export function readSessionRecords(path) {
  return parseRecords(decodeLog(path));
}

/**
 * Enumerate session logs, keeping only the highest format generation per
 * session directory and sorting the result newest-first.
 * @param {string} root - the `sessions` directory (missing directories yield `[]`).
 * @returns {Array<{ path: string, version: number, compressed: boolean, mtime: number }>}
 */
export function listSessionLogs(root) {
  const found = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const candidates = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = LOG_FILE.exec(entry.name);
      if (match === null) continue;
      candidates.push({
        path: full,
        version: match[1] === undefined ? 0 : Number(match[1]),
        compressed: match[2] === '.zstd',
      });
    }
    if (candidates.length === 0) return;
    // Highest generation wins: a migration writes the successor next to the
    // unchanged source, and both carry the same logical events.
    candidates.sort((a, b) => b.version - a.version);
    const chosen = candidates[0];
    let mtime = 0;
    try {
      mtime = statSync(chosen.path).mtimeMs;
    } catch {
      // An unreadable timestamp only affects ordering, never correctness.
    }
    found.push({ ...chosen, mtime });
  };
  visit(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}
