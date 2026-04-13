// agents/performance-engine/lib/queue.js
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
export const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');

export function ensureQueueDir() {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
}

export function listQueueItems() {
  ensureQueueDir();
  return readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'indexing-submissions.json')
    .map((f) => {
      try { return JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

export function findBySlug(slug) {
  return listQueueItems().find((i) => i.slug === slug) || null;
}

export function writeItem(item) {
  ensureQueueDir();
  item.updated_at = new Date().toISOString();
  writeFileSync(join(QUEUE_DIR, `${item.slug}.json`), JSON.stringify(item, null, 2));
}

export function activeSlugs() {
  const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();
  return new Set(listQueueItems()
    .filter((i) => {
      // Still in the queue (pending/approved/feedback)
      if (i.status !== 'published' && i.status !== 'dismissed') return true;
      // Recently published — still in cooldown period
      if (i.published_at && (now - new Date(i.published_at).getTime()) < COOLDOWN_MS) return true;
      return false;
    })
    .map((i) => i.slug));
}
