/**
 * Handles of pages an unattended SERP-copy writer must not touch because a CTR
 * experiment is reading them: the current wave's holdout (rewriting one
 * destroys the control for the whole wave), its treatment and individual arms
 * (meta-optimizer owns those rewrites), and any page with an A/B test that has
 * not concluded (a second rewrite replaces the running test's baseline).
 *
 * Fails open per file — no wave or no tracker protects nothing from that
 * source — the same contract as agents/meta-optimizer/lib/hold.js.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const handleOf = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();

export function ctrProtectedHandles(root, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  const out = new Set();
  try {
    const wave = JSON.parse(read(join(root, 'data', 'reports', 'ctr-program', 'wave.json')));
    for (const arm of ['holdout', 'treatment', 'individual']) {
      for (const p of Array.isArray(wave?.[arm]) ? wave[arm] : []) out.add(handleOf(p?.url));
    }
  } catch { /* no wave planned */ }
  try {
    const tracker = JSON.parse(read(join(root, 'data', 'reports', 'meta-ab', 'meta-ab-tracker.json')));
    for (const e of Array.isArray(tracker) ? tracker : []) if (e?.status !== 'concluded') out.add(handleOf(e?.pageUrl));
  } catch { /* no tracker */ }
  out.delete('');
  return out;
}
