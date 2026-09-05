/**
 * Repeated-sampling aggregation for `agents/ai-citation-tracker`.
 *
 * WHY THIS EXISTS. AI answers are non-deterministic: the same prompt returns
 * different sources run to run. The tracker sampled each prompt×engine cell
 * exactly ONCE, so the headline "~2% mention rate" this project quotes — and
 * that `agents/pr-target-finder` ranks its PR targets from — was n=1. That is
 * not a low number, it is a number of unknown precision, which is worse: it
 * cannot be trended, and a move between two runs cannot be told from noise.
 *
 * THE ONE PROPERTY THAT MATTERS: at `runs = 1` every figure this module emits
 * is BYTE-IDENTICAL to what the old inline code emitted. That is not a
 * coincidence, it is the design constraint, and it is why rates are computed
 * over RUNS rather than over prompts.
 *
 * Getting that wrong is the trap. The obvious aggregation — "mentioned = did
 * we appear in ANY of the 3 runs" — makes the published rate jump the day
 * sampling is switched on, for reasons that have nothing to do with visibility
 * improving. Every historical snapshot would then be comparable to nothing.
 * This project has been bitten by exactly that shape twice: the CTR A/B
 * baseline compared a keyword-level 90-day figure against a page-level 28-day
 * one, and cluster revenue changed basis mid-flight. So:
 *
 *   rate = (runs in which it happened) / (runs attempted)
 *
 * At runs = 1 the numerator is 0 or 1 and the denominator is the prompt count,
 * which is the old formula exactly. At runs = 3 it is the honest rate. No
 * historical snapshot needs re-basing, and none is re-based.
 *
 * Competitor tallies are counted PER CELL rather than per run, for the same
 * reason — counting per run would triple every count against history while
 * nothing changed in the world.
 */

/** Union preserving first-seen order, so a report's URL ordering stays stable. */
function union(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Collapse N runs of one prompt×engine cell into the single per-source record
 * the snapshot format already uses, plus the run counts a rate needs.
 *
 * Each run is the already-derived shape the agent builds (detection needs the
 * brand/competitor config, which stays in the agent so this module is pure):
 *   { cited: bool|null, mentioned: bool, citations: [], citation_urls: [],
 *     competitor_mentions: [], competitor_citations: [], error?: string }
 *
 * The legacy fields keep their legacy meanings so `lib/pr-targets.js` needs no
 * change: `cited`/`mentioned` are "true in at least one run", and the list
 * fields are unioned. Union is the right call for the consumer — pr-targets
 * mines these URLs for third-party pages driving competitor citations, and a
 * page that surfaced in only one run is still a real page to pitch.
 */
export function aggregateRuns(runs) {
  const attempted = runs.length;
  if (attempted === 0) throw new Error('aggregateRuns: at least one run is required');

  const ok = runs.filter((r) => !r.error);

  // Every run failed. Reproduce the old error record exactly — including the
  // absence of `citation_urls`, which the old code also omitted on this path —
  // so a consumer cannot tell a repeated failure from the single failure it
  // used to see, beyond the additive run counts.
  if (ok.length === 0) {
    return {
      cited: null,
      mentioned: false,
      citations: [],
      competitor_mentions: [],
      competitor_citations: [],
      error: runs.find((r) => r.error)?.error ?? 'unknown error',
      runs: attempted,
      runs_ok: 0,
      runs_with_citations: 0,
      cited_runs: 0,
      mentioned_runs: 0,
    };
  }

  // A run that returned no citations at all cannot answer "were we cited?" —
  // the old code recorded null for it and excluded it from the citation-rate
  // denominator. That exclusion is preserved per run.
  const withCitations = ok.filter((r) => r.cited !== null);
  const citedRuns = withCitations.filter((r) => r.cited === true).length;
  const mentionedRuns = ok.filter((r) => r.mentioned === true).length;

  return {
    cited: withCitations.length === 0 ? null : citedRuns > 0,
    mentioned: mentionedRuns > 0,
    citations: union(ok.map((r) => r.citations)),
    citation_urls: union(ok.map((r) => r.citation_urls)),
    competitor_mentions: union(ok.map((r) => r.competitor_mentions)),
    competitor_citations: union(ok.map((r) => r.competitor_citations)),
    runs: attempted,
    runs_ok: ok.length,
    runs_with_citations: withCitations.length,
    cited_runs: citedRuns,
    mentioned_runs: mentionedRuns,
  };
}

/**
 * Build the snapshot summary from aggregated results.
 *
 * `results` is `[{ prompt, responses: { [source]: <aggregateRuns output> } }]`.
 *
 * Rates carry their denominator alongside them (`*_n`) so a reader — human or
 * agent — is never handed a percentage without the sample size behind it. That
 * is the whole point of the change; a rate whose n is invisible is how the n=1
 * problem survived this long.
 */
export function summarizeSources(results, sourceNames) {
  const citationRate = {};
  const citationRateN = {};
  const mentionRate = {};
  const mentionRateN = {};
  const competitorMentionCounts = {};
  const competitorCitationCounts = {};

  for (const source of sourceNames) {
    let citedRuns = 0;
    let citedDenominator = 0;
    let mentionedRuns = 0;
    let runDenominator = 0;

    for (const r of results) {
      const resp = r.responses?.[source];
      if (!resp) continue;

      citedRuns += resp.cited_runs ?? 0;
      citedDenominator += resp.runs_with_citations ?? 0;
      mentionedRuns += resp.mentioned_runs ?? 0;
      // Attempted, not successful: the old code counted an errored response as
      // a non-mention in a denominator of `results.length`. Keeping that means
      // a run of API failures still reads as a bad day rather than silently
      // shrinking the denominator until the rate looks fine.
      runDenominator += resp.runs ?? 0;

      // Per CELL, not per run — see the module header. A competitor named in
      // all three runs of one prompt is one data point about that prompt.
      for (const comp of resp.competitor_mentions ?? []) {
        competitorMentionCounts[comp] = (competitorMentionCounts[comp] || 0) + 1;
      }
      for (const comp of resp.competitor_citations ?? []) {
        competitorCitationCounts[comp] = (competitorCitationCounts[comp] || 0) + 1;
      }
    }

    if (citedDenominator > 0) {
      citationRate[source] = parseFloat((citedRuns / citedDenominator).toFixed(4));
      citationRateN[source] = citedDenominator;
    }
    mentionRate[source] = runDenominator > 0
      ? parseFloat((mentionedRuns / runDenominator).toFixed(4))
      : 0;
    mentionRateN[source] = runDenominator;
  }

  const byCountDesc = (obj) =>
    Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));

  return {
    citation_rate: citationRate,
    citation_rate_n: citationRateN,
    mention_rate: mentionRate,
    mention_rate_n: mentionRateN,
    top_competitor_mentions: byCountDesc(competitorMentionCounts),
    top_competitor_citations: byCountDesc(competitorCitationCounts),
  };
}

/**
 * Which prompts get repeated. Sampling every prompt N times multiplies a paid,
 * unattended API bill by N, and the value is very unevenly distributed: the
 * point of repeating is to make a *trend* readable, and a trend needs the same
 * prompts every week, not all of them.
 *
 * So the core is a stable prefix of the configured prompt list. A prefix rather
 * than a scored selection because the selection has to be identical week over
 * week to be comparable at all, and any rule that reads current results would
 * quietly re-pick the set whenever visibility moved — which is the one thing a
 * trend cannot survive.
 *
 * `coreSize <= 0` means every prompt is repeated; `runs <= 1` disables
 * repetition entirely and restores the exact pre-2026-09 behaviour.
 */
export function runsForPrompt(index, { runs = 1, coreSize = 0 } = {}) {
  if (!Number.isFinite(runs) || runs <= 1) return 1;
  if (coreSize > 0 && index >= coreSize) return 1;
  return Math.floor(runs);
}

/**
 * The `sampling` block stamped on every snapshot, so a reader months later can
 * tell which basis produced a figure. Snapshots written before this existed
 * have no block at all, and absence is meaningful: it means one run per cell.
 */
export function samplingMeta({ prompts, sources, runs = 1, coreSize = 0 }) {
  const perPrompt = Array.from({ length: prompts }, (_, i) => runsForPrompt(i, { runs, coreSize }));
  const totalRuns = perPrompt.reduce((a, b) => a + b, 0);
  return {
    runs_per_core_cell: runsForPrompt(0, { runs, coreSize }),
    core_prompts: coreSize > 0 ? Math.min(coreSize, prompts) : prompts,
    tail_prompts: coreSize > 0 ? Math.max(0, prompts - coreSize) : 0,
    prompts,
    sources,
    // What this run actually costs, stated up front rather than inferred from
    // a bill later.
    total_calls: totalRuns * sources,
    note:
      'Rates are computed over RUNS, not prompts, so a snapshot at 1 run per cell '
      + 'is directly comparable to every snapshot written before repeated sampling existed. '
      + 'Absence of this block means 1 run per cell.',
  };
}
