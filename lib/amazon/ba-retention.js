// lib/amazon/ba-retention.js
//
// Disk policy for the weekly Brand Analytics search-terms dump (~3.4 GB each) on a
// 24 GB server. Only the newest COMPLETE dump is ever read (lib/keyword-index/
// dump-readers.js), so one is kept, plus the new one while it is being written.
//
// History, because the first fix was not enough:
//   2026-07-05  unpruned dumps filled the disk; cron stopped for 4 days. Fix (PR #300):
//               keep 2, prune AFTER a write.
//   2026-11-08  with 2 kept, the next write needed room for a THIRD 3.4 GB file before
//               it could prune. It filled the disk at 15:52 UTC, the dump was left
//               truncated mid-record (and, being newest, would have been read), and the
//               rest of the day's pipeline, the Reels post and the digest all failed.
// So now: prune to one complete dump BEFORE downloading, refuse to download without
// room, write to `.partial` and rename only when complete, then keep just the new one.

import { openSync, readSync, closeSync, statSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP = 1;
export const RESERVE_BYTES = 2 * 1024 ** 3; // never plan to leave less than 2 GB free
export const DEFAULT_DUMP_BYTES = 4 * 1024 ** 3; // estimate when no previous dump exists
export const PARTIAL_SUFFIX = '.partial';

/** A complete dump ends with "]}" (the dataByDepartmentAndSearchTerm array and the object). */
export function isCompleteTail(tail) {
  return /\]\s*\}\s*$/.test(String(tail || ''));
}

export function readTail(path, bytes = 64) {
  const size = statSync(path).size;
  if (!size) return '';
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

/** Every BA dump for an env (and any leftover .partial), newest first, with completeness. */
export function listDumps(dir, env) {
  const suffix = `-brand-analytics-${env}.json`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix) || f.endsWith(suffix + PARTIAL_SUFFIX))
    .map((f) => {
      const path = join(dir, f);
      const st = statSync(path);
      const partial = f.endsWith(PARTIAL_SUFFIX);
      return { f, path, mtime: st.mtimeMs, size: st.size, partial, complete: !partial && isCompleteTail(readTail(path)) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Which files to delete: everything except the newest `keep` complete dumps. */
export function planPrune(dumps, { keep = KEEP } = {}) {
  const kept = dumps.filter((d) => d.complete).slice(0, keep).map((d) => d.f);
  return { keep: kept, remove: dumps.filter((d) => !kept.includes(d.f)).map((d) => d.f) };
}

/** Bytes a new download needs free: the last complete dump plus 15%, plus the reserve. */
export function requiredFreeBytes(dumps) {
  const last = dumps.find((d) => d.complete);
  return Math.round((last ? last.size : DEFAULT_DUMP_BYTES) * 1.15) + RESERVE_BYTES;
}

export function freeBytes(path = '/') {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}
