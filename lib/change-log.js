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
import {
  atomicWriteJson,
  eventPath,
  windowPath,
  queueItemPath,
  indexPath,
  readJsonOrNull,
  CHANGES_ROOT as DEFAULT_ROOT,
} from './change-log/store.js';
import { aggregateGSCForUrl, aggregateGA4ForUrl } from './change-log/snapshots.js';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOTS_GSC = join(__dirname, '..', 'data', 'snapshots', 'gsc');
const SNAPSHOTS_GA4 = join(__dirname, '..', 'data', 'snapshots', 'ga4');

const BUNDLE_GROUPING_DAYS = 3;
const MEASUREMENT_DAYS = 28;

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

function newWindowId(slug, openedAt) {
  return `win-${slug}-${openedAt.slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
}

function newEventId(slug, changeType, changedAt) {
  return `ch-${changedAt.slice(0, 10)}-${slug}-${changeType}-${Math.random().toString(36).slice(2, 6)}`;
}

function newQueueItemId(slug) {
  return `q-${new Date().toISOString().slice(0, 10)}-${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function inferUrlFromSlug(slug) {
  // Default heuristic — callers can pass an explicit `url` to logChangeEvent.
  return `/products/${slug}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getActiveWindow(slug, nowIso = new Date().toISOString()) {
  return findActiveWindow(slug, nowIso);
}

export function isPageInMeasurement(slug, nowIso = new Date().toISOString()) {
  const w = findActiveWindow(slug, nowIso);
  return w != null && computeWindowStatus(w, nowIso) === 'measuring';
}

export async function proposeChange({ slug, changeType, category, nowIso = new Date().toISOString() }) {
  if (category === 'maintenance') {
    return { action: 'apply', windowId: null, reason: 'maintenance_bypass' };
  }
  const active = findActiveWindow(slug, nowIso);
  if (!active) {
    return { action: 'apply', windowId: null, reason: 'no_active_window' };
  }
  const status = computeWindowStatus(active, nowIso);
  if (status === 'forming') {
    return { action: 'apply', windowId: active.id, reason: 'window_in_forming_period' };
  }
  // measuring or verdict_pending — queue it
  return { action: 'queue', windowId: active.id, reason: 'window_in_measurement' };
}

export async function captureBaseline(slug, targetQueries, nowIso = new Date().toISOString()) {
  const fromDate = addDaysIso(nowIso, -28).slice(0, 10);
  const toDate = nowIso.slice(0, 10);
  const url = inferUrlFromSlug(slug);
  const gsc = aggregateGSCForUrl({
    snapshotsDir: SNAPSHOTS_GSC,
    url,
    queries: targetQueries || [],
    fromDate,
    toDate,
  });
  const ga4 = aggregateGA4ForUrl({
    snapshotsDir: SNAPSHOTS_GA4,
    pagePath: url,
    fromDate,
    toDate,
  });
  return { captured_at: nowIso, gsc, ga4 };
}

export async function logChangeEvent({
  url,
  slug,
  changeType,
  category,
  before,
  after,
  source,
  targetQuery,
  intent,
  windowId: existingWindowId,
}) {
  const nowIso = new Date().toISOString();
  const eventId = newEventId(slug, changeType, nowIso);

  // Maintenance: log only, no window
  if (category === 'maintenance') {
    const event = {
      id: eventId,
      url,
      slug,
      change_type: changeType,
      category,
      before,
      after,
      changed_at: nowIso,
      source,
      target_query: targetQuery ?? null,
      target_cluster: [],
      intent: intent ?? null,
      window_id: null,
    };
    atomicWriteJson(eventPath(eventId, nowIso, CHANGES_ROOT), event);
    return eventId;
  }

  // Find or open window
  let win = existingWindowId
    ? readJsonOrNull(windowPath(slug, existingWindowId, CHANGES_ROOT))
    : findActiveWindow(slug, nowIso);

  if (!win || computeWindowStatus(win, nowIso) === 'verdict_landed') {
    const openedAt = nowIso;
    const bundleLockedAt = addDaysIso(openedAt, BUNDLE_GROUPING_DAYS);
    const verdictAt = addDaysIso(bundleLockedAt, MEASUREMENT_DAYS);
    const id = newWindowId(slug, openedAt);
    win = {
      id,
      url: url ?? inferUrlFromSlug(slug),
      slug,
      opened_at: openedAt,
      bundle_locked_at: bundleLockedAt,
      verdict_at: verdictAt,
      changes: [],
      target_queries: [],
      baseline: await captureBaseline(slug, targetQuery ? [targetQuery] : [], openedAt),
      verdict: null,
    };
  }

  const event = {
    id: eventId,
    url,
    slug,
    change_type: changeType,
    category,
    before,
    after,
    changed_at: nowIso,
    source,
    target_query: targetQuery ?? null,
    target_cluster: [],
    intent: intent ?? null,
    window_id: win.id,
  };
  atomicWriteJson(eventPath(eventId, nowIso, CHANGES_ROOT), event);

  win.changes.push(eventId);
  if (targetQuery && !win.target_queries.includes(targetQuery)) {
    win.target_queries.push(targetQuery);
  }
  atomicWriteJson(windowPath(slug, win.id, CHANGES_ROOT), win);

  return eventId;
}

export async function queueChange({ slug, changeType, source, proposalContext, targetQuery, after }) {
  const id = newQueueItemId(slug);
  const item = {
    id,
    slug,
    change_type: changeType,
    source,
    target_query: targetQuery ?? null,
    after,
    proposal_context: proposalContext ?? null,
    proposed_at: new Date().toISOString(),
  };
  atomicWriteJson(queueItemPath(slug, id, CHANGES_ROOT), item);
  return id;
}
