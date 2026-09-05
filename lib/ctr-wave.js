/**
 * THE WAVE LIFECYCLE — is a CTR wave in flight, and was it actually run?
 *
 * Pure: no clock of its own, no filesystem, no network. Every state below is a
 * case a test constructs.
 *
 * WHY THIS EXISTS — the program planned a rigorous experiment every Monday and
 * never ran one. Measured on production 2026-09-05 against the wave planned
 * 2026-08-31:
 *
 *   1. THE TREATMENT ARM WAS NEVER TREATED. `agents/meta-optimizer` reads the
 *      wave only through `excludeHoldout`; nothing reads `wave.treatment`. Of
 *      its 5 weekly slots, 2 went to the `individual` pages (correct — those
 *      take the ordinary per-page path), 2 went to pages the wave had
 *      explicitly DEFERRED, and exactly ONE landed in the treatment arm.
 *      That was not luck: only 1 of the 10 treatment pages was even SELECTABLE,
 *      because candidates come from `gsc-opportunity`'s 20 low-CTR QUERIES and
 *      the wave picks PAGES. 9 of the 10 do appear in the quick-win pool — they
 *      simply never survive into that top-20.
 *   2. THE WAVE WAS RE-PLANNED EVERY MONDAY. `writeWave` overwrote wave.json
 *      unconditionally, so arms reshuffled six days into a 28-day measurement.
 *   3. NOTHING EVER CONCLUDED ONE. `differenceInDifferences` and
 *      `cohortVerdict` in `lib/ctr-cohort.js` are written and unit-tested and
 *      were called from nothing but their own tests.
 *
 * Any one of those alone makes the program produce no evidence. Together they
 * made it produce a weekly plan nobody executed and nobody read.
 *
 * THE FLOOR IS DERIVED, NOT PICKED — and it is the important part
 * ──────────────────────────────────────────────────────────────
 * A difference-in-differences over a treatment arm that was only half rewritten
 * measures a half-strength effect against a full-strength control, and reports
 * "no effect". That is a FALSE NEGATIVE dressed as a result, and acting on it
 * would retire a program that was never actually tried — the same class of
 * mistake as the 2026-07-27 auto-revert that acted on a confounded reading.
 *
 * The wave's own power block already says how small an effect it can see
 * (`mde`) and how big an effect it is looking for (`targetAbsoluteLift`). If a
 * fraction f of the arm is treated, the observable effect is about f × target.
 * So the wave can only read a result while
 *
 *     f  ≥  mde / targetAbsoluteLift
 *
 * On the live 2026-08-31 wave that is 0.00124 / 0.00178 = **0.70**. Below that
 * the expected signal is smaller than the smallest thing the experiment can
 * distinguish from noise, and the honest verdict is `underdosed`, not `flat`.
 * It adapts per wave instead of being a constant somebody would later tune to
 * get the answer they wanted.
 */

/**
 * How long a wave stays in flight before it is measured and replaced.
 *
 * 28 days, matching `agents/meta-ab-checker`'s page-level measurement window
 * and the 28-day GSC blocks the corpus-drift analysis is built on. NOT
 * `wave.window_days`, which is the LOOKBACK used to rank pages when planning
 * (90 on the live wave) — two different windows that are easy to confuse.
 */
export const MEASUREMENT_WINDOW_DAYS = 28;

/** Coverage can never be required above 100% or below half the arm. */
const COVERAGE_FLOOR = 0.5;
const COVERAGE_CEIL = 1;

const dayMs = 86_400_000;

/**
 * The fraction of the treatment arm that must actually have been rewritten
 * before a verdict is readable. Derived from the wave's own power block.
 *
 * Falls back to the floor when the power block is missing or degenerate — a
 * wave we cannot reason about should demand LESS, not block forever, because
 * `waveState` always expires a wave on time regardless (see `status: 'due'`).
 *
 * @param {{mde?:number, targetAbsoluteLift?:number}} power
 * @returns {number} 0.5 … 1
 */
export function requiredCoverage(power = {}) {
  const { mde, targetAbsoluteLift } = power || {};
  if (!Number.isFinite(mde) || !Number.isFinite(targetAbsoluteLift) || targetAbsoluteLift <= 0) {
    return COVERAGE_FLOOR;
  }
  return Math.min(COVERAGE_CEIL, Math.max(COVERAGE_FLOOR, mde / targetAbsoluteLift));
}

/** Article handle from a URL, the fleet's join key between GSC rows and Shopify. */
export const handleOf = (url) => String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();

/**
 * A timestamp reduced to its UTC calendar day, or null if unparseable.
 *
 * COMPARISONS HERE ARE AT DAY GRANULARITY, and that is forced by the data
 * rather than chosen. `meta-ab-tracker.json` stamps `testedAt` as a DATE ONLY
 * ("2026-08-31"), while a wave's `generated_at` is a full instant
 * ("2026-08-31T14:55:02.682Z"). Comparing them as instants makes every same-day
 * rewrite parse to midnight and sort BEFORE the wave that prompted it — which
 * reported the live 2026-08-31 wave as 0/10 treated when it was 1/10. Unit
 * tests written with full ISO fixtures passed; only running it against the real
 * tracker exposed it.
 *
 * The residual risk is a rewrite made earlier on the same calendar day as the
 * planning run counting toward the wave. That cannot happen on the real
 * schedule — `ctr-program` runs 14:55 and `meta-optimizer` 15:00, both Mondays
 * — and one day of slack inside a 28-day window is immaterial either way.
 */
function utcDay(value) {
  const t = Date.parse(value ?? '');
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / dayMs);
}

/**
 * How much of the treatment arm has been rewritten since the wave was planned.
 *
 * Counted from the A/B tracker, which is the only durable record that a live
 * mutation happened — `meta-optimizer` writes an entry after EVERY applied
 * change (it used to write once at the end of the loop, so a crash left Shopify
 * mutated with no baseline; that was fixed for this reason).
 *
 * Entries older than the wave are ignored: a page rewritten last month was not
 * treated as part of THIS wave and its effect is already in the baseline.
 *
 * @param {{treatment?:Array<{url:string}>, generated_at?:string}} wave
 * @param {Array<{pageUrl?:string, testedAt?:string}>} trackerEntries
 * @returns {{treated:number, total:number, ratio:number, treatedPages:string[], untreatedPages:string[]}}
 */
export function treatmentCoverage(wave = {}, trackerEntries = []) {
  const arm = Array.isArray(wave?.treatment) ? wave.treatment : [];
  const total = arm.length;
  const since = utcDay(wave?.generated_at);

  const mutated = new Set();
  for (const e of Array.isArray(trackerEntries) ? trackerEntries : []) {
    const at = utcDay(e?.testedAt);
    // A tracker entry with no parseable date cannot be placed relative to the
    // wave. Counting it would inflate coverage and let an unreadable wave
    // conclude, so it is ignored — the failure direction is "we say it is less
    // covered than it is", which only ever delays a verdict.
    if (at === null || (since !== null && at < since)) continue;
    const h = handleOf(e?.pageUrl);
    if (h) mutated.add(h);
  }

  const treatedPages = [];
  const untreatedPages = [];
  for (const p of arm) {
    const h = handleOf(p?.url);
    (mutated.has(h) ? treatedPages : untreatedPages).push(h);
  }
  return {
    treated: treatedPages.length,
    total,
    ratio: total === 0 ? 0 : treatedPages.length / total,
    treatedPages,
    untreatedPages,
  };
}

/**
 * What should happen to this wave right now.
 *
 * Three statuses, and the third is the one that prevents a deadlock:
 *
 *   `none`       no wave on disk → plan one.
 *   `in-flight`  younger than the measurement window → DO NOT re-plan. This is
 *                the fix for defect 2; without it arms reshuffle weekly and no
 *                cohort ever survives long enough to be measured.
 *   `due`        window elapsed → measure it, then plan the next one.
 *
 * **`due` ALWAYS replans, even when the wave cannot be concluded.** A wave that
 * pinned the program forever because it was never treated would be exactly the
 * failure this repo has already paid for twice — the six-day held tattoo merge
 * and the `PINNED_MIRROR_SLUGS` entry with no expiry, both of which became
 * outages nobody was looking for. An expiry is not optional.
 *
 * `concludable` is separate from `replan` on purpose: a wave can be due, get
 * replaced, and still be unreadable. Reporting "underdosed" is a finding; a
 * silent `flat` would be a lie.
 *
 * @param {object|null} wave
 * @param {Array} trackerEntries
 * @param {{now?:number, windowDays?:number}} opts
 */
export function waveState(wave, trackerEntries = [], { now = Date.now(), windowDays = MEASUREMENT_WINDOW_DAYS } = {}) {
  if (!wave || typeof wave !== 'object' || !Array.isArray(wave.treatment)) {
    return {
      status: 'none', replan: true, concludable: false, ageDays: null,
      coverage: null, required: null,
      reason: 'No wave on disk — planning the first one.',
    };
  }

  const startedAt = Date.parse(wave.generated_at ?? '');
  // An unparseable generated_at means we cannot tell how old the wave is. Treat
  // it as DUE rather than in-flight: the failure direction has to be "replan a
  // wave we could not date", never "freeze the program on a wave with no clock".
  const ageDays = Number.isFinite(startedAt) ? (now - startedAt) / dayMs : Infinity;

  const coverage = treatmentCoverage(wave, trackerEntries);
  const required = requiredCoverage(wave.power);
  const concludable = coverage.total > 0 && coverage.ratio >= required;

  if (ageDays < windowDays) {
    return {
      status: 'in-flight', replan: false, concludable: false,
      ageDays, coverage, required,
      reason: `Wave is ${ageDays.toFixed(1)}d old of ${windowDays}d. Arms are FROZEN — re-planning now would `
        + `reshuffle the cohort mid-measurement. ${coverage.treated}/${coverage.total} of the treatment arm rewritten `
        + `so far (needs ${(required * 100).toFixed(0)}% by day ${windowDays}).`,
    };
  }

  return {
    status: 'due', replan: true, concludable,
    ageDays, coverage, required,
    reason: concludable
      ? `Wave completed its ${windowDays}d window with ${coverage.treated}/${coverage.total} of the treatment arm `
        + `rewritten (${(coverage.ratio * 100).toFixed(0)}% ≥ the ${(required * 100).toFixed(0)}% this wave needs to read a result).`
      : `Wave reached ${windowDays}d but only ${coverage.treated}/${coverage.total} of the treatment arm was rewritten `
        + `(${(coverage.ratio * 100).toFixed(0)}% < the ${(required * 100).toFixed(0)}% needed). Its result is UNDERDOSED and `
        + 'must not be read as a verdict: a half-treated arm against a full control reports "no effect" whatever the rewrites did.',
  };
}
