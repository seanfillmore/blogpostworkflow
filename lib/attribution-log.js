// lib/attribution-log.js
// Append-only ledger linking a published post (slug) back to the signal type that
// caused the pipeline-prioritizer to create or fast-track it. This is the durable
// record the weight tuner joins against seo-impact action_wins — the prioritizer's
// latest.json is overwritten each run, so attribution must be logged here to survive
// the weeks until revenue accrues. See the Phase 2 design doc.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append attribution records (one JSON object per line). Creates the file/dir if
 * absent. No-op for an empty/missing array.
 * @param {Array<object>} records
 * @param {{path:string}} opts
 */
export function appendAttribution(records, { path } = {}) {
  if (!path || !Array.isArray(records) || records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(path, lines);
}

/**
 * Statuses that mean a calendar item has entered PRODUCTION — a brief has been paid
 * for, or work beyond it exists. `pending` is deliberately absent: a backlog idea is
 * not evidence that any signal caused anything.
 */
export const PRODUCTION_STATUSES = ['briefed', 'written', 'draft', 'scheduled', 'published'];

/**
 * The ledger's identity for a record. Keyed on slug + signal type + ACTION, so
 * `inject`, `promote` and `production` for one slug stay three separate, real events
 * while a re-run of the same event is a duplicate.
 */
export function attributionKey(r) {
  return `${r?.slug}::${r?.signal_type}::${r?.action}`;
}

/**
 * Records for items that have entered production, one per contributing signal.
 *
 * WHY THIS EXISTS: attribution used to be logged only at the `inject` and `promote`
 * moments. Both are correctly rare in steady state — the buffer is stocked so nothing
 * promotes, and recurring signals name keywords already covered so nothing injects —
 * which left ONE ledger record in 78 days on production and made `priority-tuner`
 * (totalFloor 8, minSamplesPerSignal 3) a permanent no-op. Phase 2 was installed but
 * could never learn. Logging at production entry accumulates evidence from the posts
 * that actually ship.
 *
 * Caveat worth knowing: `contributing` is recomputed each run from CURRENT signals, so
 * this records the signals attached while the item was in production, not necessarily
 * the one that first created it. Bounded at one record per signal type per slug.
 *
 * @param {{scored:Array, statusBySlug:Map, today:string, nowIso:string}} args
 */
export function buildProductionRecords({ scored, statusBySlug, today, nowIso }) {
  const out = [];
  for (const item of scored || []) {
    const status = statusBySlug?.get(item.slug);
    if (!PRODUCTION_STATUSES.includes(status)) continue;
    for (const c of item.contributing || []) {
      out.push({
        ts: nowIso, date: today, slug: item.slug, keyword: item.keyword,
        signal_type: c.type, strength: c.strength, score: c.score,
        action: 'production', cluster: item.cluster || null, status,
      });
    }
  }
  return out;
}

/**
 * Drop candidates already present in the ledger, and duplicates within the batch.
 * The prioritizer runs DAILY, so without this the same in-production items would be
 * appended every morning and the tuner would read one post as dozens of samples.
 */
export function dedupeAgainst(candidates, existing) {
  const seen = new Set((existing || []).map(attributionKey));
  const out = [];
  for (const c of candidates || []) {
    const k = attributionKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Read a JSONL ledger → array of records. Missing file → []. Malformed lines skipped. */
export function readAttribution(path) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
  }
  return out;
}
