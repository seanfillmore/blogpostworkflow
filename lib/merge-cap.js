// lib/merge-cap.js
//
// "How many times may ONE page be rewritten in a single unattended run?"
//
// WHY THIS EXISTS
// ───────────────
// `agents/cannibalization-resolver` triages up to 20 conflict groups per run and
// applies every HIGH-confidence one. Measured on production 2026-09-09, that
// produced 21 CONSOLIDATE merges of which **17 targeted the SAME winner** —
// `toothpaste-without-sls-what-to-know-best-options`, the biggest page on the
// blog at 148,030 impressions and position 5.7.
//
// A CONSOLIDATE is a full Claude rewrite of the WINNER's body, then the editor,
// then a publish. Seventeen of them run sequentially, so merge N operates on the
// output of merge N−1: the page is rewritten seventeen times in one morning,
// each pass compounding whatever the last one did, and `mergeMaxTokens` derives
// its ceiling from a body that grows every time. Nobody would design that on
// purpose, and there was no cap of any kind — `groups.slice(0, 20)` bounds what
// is TRIAGED, not what is APPLIED.
//
// DEFERRAL IS FREE HERE, WHICH IS WHAT MAKES A CAP THE RIGHT TOOL.
// Detection is stateless: every run re-derives its conflicts from live GSC, so a
// merge not applied this week is simply re-proposed next week. Nothing is lost
// and nothing has to be remembered — unlike `lib/brief-triage.js`, where the
// equivalent "skip" was a delete. So the cap defers; it never dismisses.
//
// IT COUNTS BODY REWRITES, NOT ACTIONS.
// A REDIRECT does not touch the winner's body — it 301s the loser — and a
// MONITOR does nothing at all. Only CONSOLIDATE carries the compounding-rewrite
// hazard, so only CONSOLIDATE is counted. Capping redirects would slow the
// cheap, reversible half of a consolidation for no safety gain.

/**
 * How many CONSOLIDATE merges one winner may absorb in a single run.
 *
 * THREE, and the reasoning is the compounding: at 1 a genuine duplicate cluster
 * takes 17 weeks to resolve; at 3 the live pool clears in ~6 runs while any
 * single morning rewrites a page at most three times, which is the depth a
 * human can still read in a diff. It is a blast-radius bound, not a budget —
 * the cost of a merge is small next to the cost of an unreadable page.
 */
export const MAX_MERGES_PER_WINNER = 3;

/** Actions that rewrite the WINNER's body. Only these are counted. */
const REWRITES_WINNER = new Set(['CONSOLIDATE']);

/** Winner path → a stable key. Decisions carry site-relative paths already. */
function winnerKey(decision) {
  return String(decision?.winner || '').trim().toLowerCase();
}

/** One (loser → winner) merge, as a key. The PAIR is the unit of work. */
function pairKey(winner, loserPath) {
  return `${String(loserPath || '').trim().toLowerCase()} -> ${String(winner || '').trim().toLowerCase()}`;
}

function mergeCount(decision) {
  return (decision?.losers || []).filter((l) => REWRITES_WINNER.has(l?.action)).length;
}

/**
 * Split decisions into what may be applied now and what defers to a later run.
 *
 * Order is preserved and never re-sorted: the triage list is already ranked by
 * total impressions, so taking it in order spends the cap on the biggest
 * conflicts first. Re-ranking here would silently override that.
 *
 * A decision that rewrites no body (all REDIRECT / MONITOR) is ALWAYS applied —
 * it costs the winner nothing, and holding it back would strand the cheap half
 * of a consolidation behind the expensive half.
 *
 * @param {Array} decisions
 * @param {{maxPerWinner?: number}} [opts]
 * @returns {{apply: Array, deferred: Array<{decision: object, winner: string, merges: number}>,
 *            perWinner: Map<string, number>}}
 */
export function capMergesPerWinner(decisions, { maxPerWinner = MAX_MERGES_PER_WINNER } = {}) {
  const apply = [];
  const deferred = [];
  const duplicates = [];
  const perWinner = new Map();
  const seenPairs = new Set();

  for (const decision of decisions || []) {
    // DEDUPE THE PAIR FIRST — a (loser → winner) merge is the unit of work, and
    // several QUERIES routinely produce the same one. Measured in the live run
    // on 2026-09-09, all three merges the cap allowed were the SAME pair:
    // best-toothpaste-without-sls-2025 → toothpaste-without-sls-what-to-know-
    // best-options, arrived at from three different queries. That is three paid
    // Claude merges of one page, and the run then reported "2 held for review"
    // — two superseded attempts at work the third attempt completed, sending a
    // human to review drafts that no longer mattered.
    //
    // Deduping before the cap is what makes the cap mean something: otherwise
    // three slots buy one merge.
    const fresh = [];
    for (const loser of decision?.losers || []) {
      if (!REWRITES_WINNER.has(loser?.action)) { fresh.push(loser); continue; }
      const key = pairKey(decision.winner, loser.path);
      if (seenPairs.has(key)) {
        duplicates.push({ winner: decision.winner, loser: loser.path, query: decision.query });
        continue;
      }
      seenPairs.add(key);
      fresh.push(loser);
    }

    // Every merge in this decision was already done by an earlier one, and it
    // carries no other action — there is nothing left for it to do.
    if (!fresh.length) continue;

    const deduped = fresh === decision.losers ? decision : { ...decision, losers: fresh };
    const merges = mergeCount(deduped);

    // No body rewrite → never capped.
    if (merges === 0) {
      apply.push(deduped);
      continue;
    }

    const key = winnerKey(deduped);
    const used = perWinner.get(key) || 0;

    if (used + merges > maxPerWinner) {
      deferred.push({ decision: deduped, winner: deduped.winner, merges });
      continue;
    }

    perWinner.set(key, used + merges);
    apply.push(deduped);
  }

  return { apply, deferred, duplicates, perWinner };
}

/** Console/digest lines describing what the cap held back. */
export function mergeCapLines({
  deferred = [], duplicates = [], perWinner = new Map(), maxPerWinner = MAX_MERGES_PER_WINNER,
} = {}) {
  const dupLines = duplicates.length
    ? [`· Deduped ${duplicates.length} repeat merge(s): several queries proposed the same `
      + '(loser -> winner) pair, which is one piece of work, not several.']
    : [];
  if (!deferred.length) {
    return [...dupLines, `· Merge cap: no winner reached ${maxPerWinner} body rewrites this run; nothing deferred.`];
  }
  const byWinner = new Map();
  for (const d of deferred) {
    byWinner.set(d.winner, (byWinner.get(d.winner) || 0) + d.merges);
  }
  const lines = [
    ...dupLines,
    `· Merge cap: ${deferred.length} decision(s) DEFERRED to a later run — a winner may absorb at most `
    + `${maxPerWinner} body rewrites per run, because each CONSOLIDATE rewrites it again on top of the last.`,
    '  Nothing is dismissed: detection is re-derived from live GSC every run, so these re-propose next time.',
  ];
  for (const [winner, merges] of byWinner) {
    lines.push(`      ${winner}  (${perWinner.get(String(winner).toLowerCase()) || 0} applied, ${merges} deferred)`);
  }
  return lines;
}
