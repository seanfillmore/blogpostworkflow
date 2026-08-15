// agents/ad-studio/baseline.js
//
// Ranking, and the rolling score baseline.
//
// critique.js scores every finished frame 1-5 and that score deliberately never blocks a
// render (see its header). A score nobody reads is a score that may as well not exist, so
// it does two jobs here:
//
//   1. RANKING, within a run — the frame worth looking at is the first line of run.json,
//      not something you find by opening six PNGs.
//   2. A BASELINE, across runs — appended to data/reports/ad-studio/scores.jsonl so that
//      "is this run good?" eventually has an answer that is not a shrug.
//
// The baseline is honest about being young. Six frames is not a baseline, and a summary
// that quietly reports a delta off n=6 invites reading noise as a trend. summariseRun
// flags that explicitly rather than leaving the caller to notice the sample size.
//
// Scores are only comparable WITHIN a format. A `manifesto` frame renders the product
// small and understated; a `us-vs-them` frame is a comparison table. They are not being
// judged on the same thing, so byFormat is the number that means something and the
// overall mean is a rough health signal at best.

/**
 * Accepted artifacts, best score first. Rejected frames are excluded: a frame that failed
 * the gate is not a candidate to ship, whatever an art director thought of its layout.
 * Unscored accepted frames (plates, or a critique that answered CANNOT_TELL) sort last
 * rather than being dropped — they shipped, they just carry no opinion.
 */
export function rankArtifacts(results) {
  const rows = [];
  for (const concept of results || []) {
    for (const v of concept.variations || []) {
      for (const a of v.artifacts || []) {
        if (!a.ok) continue;
        rows.push({
          conceptSlug: concept.conceptSlug,
          variation: v.n,
          artifact: a.artifact,
          score: typeof a.score === 'number' ? a.score : null,
        });
      }
    }
  }
  return rows.sort((x, y) => {
    if (x.score === y.score) return 0;
    if (x.score === null) return 1;
    if (y.score === null) return -1;
    return y.score - x.score;
  });
}

/**
 * One row per SCORED artifact, accepted or not. A rejected frame's score is still
 * evidence about what this pipeline produces, which is exactly what a baseline is for —
 * excluding them would bias the baseline upward by construction.
 */
export function scoreRows({ runId, product, results }) {
  const rows = [];
  for (const concept of results || []) {
    for (const v of concept.variations || []) {
      for (const a of v.artifacts || []) {
        if (typeof a.score !== 'number') continue;
        rows.push({
          runId,
          product: product?.handle || null,
          format: concept.conceptSlug,
          variation: v.n,
          artifact: a.artifact,
          score: a.score,
          ok: Boolean(a.ok),
        });
      }
    }
  }
  return rows;
}

const mean = xs => (xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2)) : null);

/**
 * Below this many observations, a delta against the baseline is noise wearing a number.
 */
export const BASELINE_THIN_BELOW = 50;

/**
 * Parses the scores JSONL. A malformed line is skipped rather than thrown on: this file
 * is append-only across many runs and a single truncated write must not make every
 * future run unable to read its own history.
 */
export function readBaselineFrom(text) {
  const scores = [];
  const byFormat = new Map();
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    if (!row || typeof row.score !== 'number') continue;
    scores.push(row.score);
    const key = row.format || '(unknown)';
    if (!byFormat.has(key)) byFormat.set(key, []);
    byFormat.get(key).push(row.score);
  }
  return {
    n: scores.length,
    mean: mean(scores),
    byFormat: Object.fromEntries([...byFormat].map(([k, v]) => [k, { n: v.length, mean: mean(v) }])),
  };
}

/**
 * This run against the rolling baseline. `mean: null` when nothing was scored — never 0,
 * which would read as "terrible" where it means "not measured".
 */
export function summariseRun(rows, baseline) {
  const scores = (rows || []).map(r => r.score).filter(s => typeof s === 'number');
  const runMean = mean(scores);
  const baselineN = baseline?.n || 0;
  const baselineMean = typeof baseline?.mean === 'number' ? baseline.mean : null;
  return {
    n: scores.length,
    mean: runMean,
    baselineN,
    baselineMean,
    delta: runMean !== null && baselineMean !== null ? Number((runMean - baselineMean).toFixed(2)) : null,
    baselineThin: baselineN < BASELINE_THIN_BELOW,
  };
}
