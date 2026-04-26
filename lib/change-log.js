/**
 * Change-log + outcome-attribution public API.
 *
 * Public functions (filled in across Tasks 4-5):
 *   proposeChange({ slug, changeType, category }) → { action, windowId, reason }
 *   logChangeEvent({...}) → eventId
 *   queueChange({...}) → queueItemId
 *   getActiveWindow(slug) → window | null
 *   isPageInMeasurement(slug) → boolean
 *   captureBaseline(slug, targetQueries) → baseline
 *
 * This file collects the public surface. Internals delegate to
 * lib/change-log/{snapshots,store,verdict}.js.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonOrNull, CHANGES_ROOT as DEFAULT_ROOT } from './change-log/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tests can override the root by setting CHANGE_LOG_ROOT_OVERRIDE before import.
export const CHANGES_ROOT = process.env.CHANGE_LOG_ROOT_OVERRIDE || DEFAULT_ROOT;

export function computeWindowStatus(window, nowIso = new Date().toISOString()) {
  if (window.verdict) return 'verdict_landed';
  if (nowIso >= window.verdict_at) return 'verdict_pending';
  if (nowIso >= window.bundle_locked_at) return 'measuring';
  return 'forming';
}

/**
 * Find the most recent active (non-verdict-landed) window for a slug.
 * Returns the window object or null.
 */
export function findActiveWindow(slug, nowIso = new Date().toISOString()) {
  const slugDir = join(CHANGES_ROOT, 'windows', slug);
  if (!existsSync(slugDir)) return null;
  const files = readdirSync(slugDir).filter((f) => f.endsWith('.json'));
  // Sort descending so the most recently opened window is first.
  files.sort((a, b) => b.localeCompare(a));
  for (const f of files) {
    const w = readJsonOrNull(join(slugDir, f));
    if (!w) continue;
    const status = computeWindowStatus(w, nowIso);
    if (status !== 'verdict_landed') return w;
  }
  return null;
}
