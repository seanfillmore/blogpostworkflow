/**
 * Pure summarisers for agents/ctr-program.
 *
 * Split out for the same reason `agents/meta-optimizer/lib/{sort,hold,gate}.js`
 * are: that index imports `lib/gsc.js`, which reads `.env` and throws at import
 * time without credentials, so nothing living there can be tested without a
 * network and a secret.
 *
 * No I/O, no env, no clock.
 */

import { decideOutcome } from '../../../lib/meta-ab-decision.js';

/**
 * How concentrated the impressions are. The answer decides whether throughput
 * is the constraint: measured 2026-08-21 over 90 days, the top 10 of 190 blog
 * pages hold 59.4% of blog impressions and the top 20 hold 73.9%, so the
 * population worth touching is ~20 pages — four weeks at the existing weekly
 * cap of 5, not a backlog that a bigger cap would clear.
 */
export function concentration(pages, { marks = [1, 5, 10, 20, 30, 50] } = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p && Number.isFinite(Number(p.impressions)));
  const sorted = [...list].sort((a, b) => Number(b.impressions) - Number(a.impressions));
  const total = sorted.reduce((s, p) => s + Number(p.impressions), 0);
  const rows = [];
  let run = 0; let i = 0;
  for (const m of marks) {
    while (i < m && i < sorted.length) { run += Number(sorted[i].impressions); i++; }
    rows.push({ topN: m, impressions: run, share: total > 0 ? run / total : 0 });
  }
  return { totalImpressions: total, totalPages: sorted.length, rows };
}

/**
 * Roll pages up by cluster.
 *
 * This is the number that forbids ranking candidates by raw impressions:
 * toothpaste is 41.4% of blog impressions and 54.7% of blog clicks for 2.9% of
 * revenue, so an impression-ranked programme hands it most of the budget. The
 * rollup exists so that fact is on the report rather than in somebody's memory.
 */
export function byCluster(pages) {
  const m = new Map();
  for (const p of Array.isArray(pages) ? pages : []) {
    if (!p) continue;
    const k = p.cluster ?? 'unclustered';
    const e = m.get(k) || { cluster: k, pages: 0, clicks: 0, impressions: 0 };
    e.pages++;
    e.clicks += Number(p.clicks) || 0;
    e.impressions += Number(p.impressions) || 0;
    m.set(k, e);
  }
  return [...m.values()]
    .map((e) => ({ ...e, ctr: e.impressions > 0 ? e.clicks / e.impressions : 0 }))
    .sort((a, b) => (b.impressions - a.impressions) || (a.cluster < b.cluster ? -1 : 1));
}

/**
 * Re-decide every concluded A/B test under the current rules.
 *
 * HONEST ACCOUNTING, NOT RE-MEASUREMENT. It does not re-run anything; it asks
 * what the guards would say about the numbers already recorded, so a report can
 * state how many of the standing verdicts are actually evidence instead of
 * leaving nine checkmarks up.
 *
 * POSITION IS DELIBERATELY NOT FED IN. The tracker's `baselinePosition` is the
 * KEYWORD's 90-day average and `currentPosition` is the PAGE's over 28 days;
 * handing that pair to the confound guard would manufacture verdicts out of a
 * basis mismatch — the same different-denominator error PR #630 removed from the
 * CTR side. The audit therefore re-decides on what it can honestly compare: the
 * symmetric dead-band and the power floor. Position confounds are caught going
 * forward, by meta-ab-checker, which refetches the baseline window on the right
 * basis; they are not retro-fitted here.
 */
export function reDecideTracker(tracker) {
  const list = Array.isArray(tracker) ? tracker : [];
  const concluded = list.filter((e) => e?.status === 'concluded');

  const rows = concluded.map((e) => {
    const impressionsPerArm = Number.isFinite(Number(e.baselinePageImpressions))
      ? Number(e.baselinePageImpressions)
      : Number(e.baselineImpressions);
    const now = decideOutcome({
      baselineCtr: e.baselinePageCtr ?? e.baselineCtr,
      currentCtr: e.currentCtr,
      impressionsPerArm: Number.isFinite(impressionsPerArm) ? impressionsPerArm : null,
    });
    return {
      keyword: e.keyword,
      pageUrl: e.pageUrl,
      testedAt: e.testedAt,
      recordedOutcome: e.outcome ?? null,
      recordedReverted: e.reverted === true,
      reDecided: now.outcome,
      changed: (e.outcome ?? null) !== now.outcome,
      impressionsPerArm: Number.isFinite(impressionsPerArm) ? impressionsPerArm : null,
      mde: now.power?.mde ?? null,
      delta: now.delta,
    };
  });

  // A verdict "survives" only if it was decisive AND is still the same decisive
  // verdict. `flat` is not evidence of anything, so it never counts — otherwise
  // a programme that has learned nothing scores highly for consistency.
  const surviving = rows.filter((r) => r.recordedOutcome === r.reDecided
    && (r.reDecided === 'improved' || r.reDecided === 'regressed'));

  return {
    total: list.length,
    concluded: concluded.length,
    open: list.length - concluded.length,
    rows,
    survivingVerdicts: surviving.length,
    downgraded: rows.filter((r) => r.changed).length,
  };
}
