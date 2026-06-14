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
