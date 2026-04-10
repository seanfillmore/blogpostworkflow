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
  return new Set(listQueueItems()
    .filter((i) => i.status !== 'published' && i.status !== 'dismissed')
    .map((i) => i.slug));
}
