/**
 * Storage primitives for the change-log system.
 *
 * - Atomic JSON writes (write-temp-then-rename) so concurrent agents
 *   never see a partial file.
 * - Path helpers for events / windows / queue items.
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CHANGES_ROOT = join(ROOT, 'data', 'changes');

export function eventPath(eventId, changedAt, root = CHANGES_ROOT) {
  const yyyymm = changedAt.slice(0, 7); // 2026-04-25T... → 2026-04
  return join(root, 'events', yyyymm, `${eventId}.json`);
}

export function windowPath(slug, windowId, root = CHANGES_ROOT) {
  return join(root, 'windows', slug, `${windowId}.json`);
}

export function queueItemPath(slug, queueItemId, root = CHANGES_ROOT) {
  return join(root, 'queue', slug, `${queueItemId}.json`);
}

export function indexPath(root = CHANGES_ROOT) {
  return join(root, 'index.json');
}

export function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, filePath);
}

export function readJsonOrNull(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function deleteFileIfExists(filePath) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

export { CHANGES_ROOT, ROOT };
