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

/**
 * Reconcile orphaned `in_progress` items. When the dashboard approves a
 * seo-opportunity it spawns a detached executor and sets the item to
 * `in_progress`; an exit handler (in triggerOpportunity) then advances it. But
 * if the dashboard process dies before the child exits — every deploy restarts
 * it — that handler is lost and the item is stuck on IN_PROGRESS forever.
 *
 * Run this on dashboard startup: any item still `in_progress` past a generous
 * timeout was set by a now-dead process (no executor runs that long), so its
 * handler is gone. We can't know whether the orphaned executor finished, so mark
 * it `failed` (honest + re-approvable) rather than falsely claim success.
 *
 * @param {{maxAgeMs?: number, now?: number}} [opts]
 * @returns {string[]} slugs reconciled
 */
export function reconcileStaleInProgress({ maxAgeMs = 15 * 60 * 1000, now = Date.now() } = {}) {
  const reconciled = [];
  for (const item of listQueueItems()) {
    if (item.status !== 'in_progress') continue;
    const started = Date.parse(item.triggered_at || item.updated_at || '');
    if (Number.isFinite(started) && (now - started) < maxAgeMs) continue; // maybe still mid-run
    item.status = 'failed';
    item.failed_at = new Date(now).toISOString();
    item.error = 'execution status unknown — the dashboard restarted during the run; re-approve to retry';
    writeItem(item);
    reconciled.push(item.slug);
  }
  return reconciled;
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
