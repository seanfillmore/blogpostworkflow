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
      // Terminal-but-actioned states: dismissed (rejected) and failed (executor
      // errored) are NOT active — the analyzer may re-surface them.
      if (i.status === 'dismissed' || i.status === 'failed') return false;
      // Recently published — still in cooldown period
      if (i.status === 'published') {
        return !i.published_at || (now - new Date(i.published_at).getTime()) < COOLDOWN_MS;
      }
      // A completed seo-opportunity stays in cooldown off completed_at, so the
      // same work isn't re-recommended for 30 days.
      if (i.status === 'completed') {
        return !i.completed_at || (now - new Date(i.completed_at).getTime()) < COOLDOWN_MS;
      }
      // Still in the queue (pending/approved/in_progress/feedback)
      return true;
    })
    .map((i) => i.slug));
}
