// lib/calendar-backlog-sweep.js
//
// "Which items already queued on the calendar are duplicates of a page that
// already ranks?" — the one-time counterpart to `lib/ranked-coverage.js`.
//
// WHY THIS EXISTS
// ───────────────
// The three coverage tiers that shipped on 2026-09-19 (PRs #919, #920, #921)
// stop a NEW duplicate topic entering the pipeline. Nothing re-screened what was
// already queued, and CLAUDE.md records the gap in those words: "the
// pre-existing backlog was never re-screened". Measured read-only on production
// the same day, the backlog was 25 pure ideas and 17 of them were EXACT ranked
// queries for pages already sitting on page 1 (positions 4.0–8.6) — sixteen
// collapsing onto four pages, twelve of those near-identical SLS-free-toothpaste
// phrasings pointing at `toothpaste-without-sls-what-to-know-best-options`, and
// one of them the literal keyword `"yes"`.
//
// WHAT MAY BE DROPPED, AND WHAT MAY NOT
// ─────────────────────────────────────
// ONLY tier 1, `exact` — the candidate IS a ranked query for an existing page.
// That is the only tier `lib/ranked-coverage.js` lets act silently, on a measured
// false-positive rate of zero.
//
//   POSSIBLE_DUPLICATE (tiers 2 and 3) is REPORTED AND KEPT. The whole design
//   those three PRs shipped is that a flag is a judgement a human makes:
//   `agents/pipeline-prioritizer` demotes a flagged idea below every clean one
//   and `agents/content-strategist` routes it to the digest's "Needs your
//   decision" section. A sweep that auto-dropped them would contradict the rule
//   three PRs had just established, on the weakest of the three signals.
//
//   PRODUCT SCOPE IS A DIFFERENT QUESTION WITH ITS OWN MECHANISM. Some survivors
//   are arguably off-scope (`realskin` is brand-navigational; RSC sells no
//   retinol and no glass-skin product). That verdict belongs to
//   `agents/content-strategist`'s `product-scope` rejection path, which writes to
//   `data/rejected-keywords.json` — a file of HUMAN decisions. This sweep
//   observes and reports; it never acts on scope.
//
// WHAT MAY NOT BE TOUCHED AT ALL
// ──────────────────────────────
// A calendar re-plan REPLACES the calendar, and between 2026-08-19 and
// 2026-08-21 that cleared 12 of 19 scheduled items with the only trace eight
// `[SKIP]` lines in a cron log nobody reads. So the eligibility rule here is
// deliberately the narrowest one that exists: `agents/pipeline-prioritizer`'s own
// definition of a BACKLOG IDEA — derived status `pending` (no brief on disk, no
// `content.html`, no Shopify id) AND no `publish_date`. A pure idea, nothing
// paid for, nothing scheduled.
//
// The status is RE-DERIVED at run time rather than read off the item's own
// `status` field, because the raw statuses on the live calendar are `(none)` and
// `review` and neither means what it looks like. An item that has gained a brief
// or a draft since the backlog was measured becomes INELIGIBLE on its own, with
// no list to update.
//
// No I/O: the item list, the status function and the coverage classifier are all
// injected, so every decision below is reachable from a test.

import {
  AUTO_COVERED,
  POSSIBLE_DUPLICATE,
  TIER_EXACT,
  describeMatch,
  slugifyKeyword,
} from './ranked-coverage.js';

/** Verdicts this module produces. */
export const DROP = 'drop';
export const FLAG = 'flag';
export const KEEP = 'keep';
export const INELIGIBLE = 'ineligible';

/**
 * What a read-only screen of the live production backlog found on 2026-09-19.
 *
 * It is an EXPECTATION, never an input: every verdict below is re-derived from
 * the ranked index at run time, so a corpus that has moved moves the answer.
 * The numbers are here so a run that silently disagrees with the measurement
 * says so out loud instead of looking like a clean sweep.
 */
export const EXPECTED = Object.freeze({
  measured_on: '2026-09-19',
  backlog: 25,
  drop: 17,
  flag: 4,
  keep: 4,
});

/**
 * The slugs that count as "this item itself".
 *
 * TWO of them, because the two corpora spell an item differently: the calendar
 * carries its own `slug`, while `lib/ranked-coverage.js` derives a candidate's
 * slug from its KEYWORD (`slugifyKeyword`) — and the two diverge the moment
 * punctuation is involved. A match against either is the item recognising
 * itself, which is not a duplicate; it is the same work counted twice, the
 * defect `lib/calendar-coverage.js` had to fix on 2026-08-19.
 */
export function selfSlugsFor(item) {
  const out = new Set();
  if (item?.slug) out.add(String(item.slug));
  const fromKeyword = slugifyKeyword(item?.keyword);
  if (fromKeyword) out.add(fromKeyword);
  return out;
}

/** Matches that point at a page which is NOT this item. */
function externalMatches(matches, selfSlugs) {
  // A match whose page could not be resolved to a slug is treated as EXTERNAL:
  // it is still a live page ranking for this exact query, and the only thing
  // unknown is where its local directory lives.
  return (matches || []).filter((m) => !m?.slug || !selfSlugs.has(m.slug));
}

/**
 * Is this item a pure idea — the only thing this sweep is allowed to touch?
 *
 * @param {object} item   calendar item
 * @param {string} status derived status (pipeline-prioritizer's `statusOf`)
 */
export function eligibility(item, status) {
  if (item?.publish_date) {
    return { eligible: false, reason: `scheduled for ${String(item.publish_date).slice(0, 10)} — a dated item is never touched` };
  }
  if (status !== 'pending') {
    return { eligible: false, reason: `derived status is "${status}", not "pending" — work already exists for this item` };
  }
  return { eligible: true, reason: null };
}

/**
 * Decide one item, given its derived status and its ranked-coverage verdict.
 *
 * @param {{item:object, status:string, coverage:object}} args
 * @returns {{verdict:string, slug:string, keyword:string, status:string,
 *            tier:string|null, match:object|null, reason:string, item:object}}
 */
export function decideItem({ item, status, coverage }) {
  const base = {
    slug: item?.slug ?? null,
    keyword: item?.keyword ?? null,
    status,
    tier: coverage?.tier ?? null,
    match: null,
    item,
  };

  const elig = eligibility(item, status);
  if (!elig.eligible) return { ...base, verdict: INELIGIBLE, reason: elig.reason };

  const selfSlugs = selfSlugsFor(item);

  if (coverage?.status === AUTO_COVERED) {
    // Belt and braces. `classifyRankedCoverage` only ever returns AUTO_COVERED
    // from tier 1 today; if a future tier is ever allowed to cover silently,
    // this sweep must not start deleting on it without somebody deciding that.
    if (coverage.tier !== TIER_EXACT) {
      return {
        ...base,
        verdict: KEEP,
        reason: `covered by tier "${coverage.tier}", which this sweep does not act on — only the exact ranked-query tier may drop`,
      };
    }
    const external = externalMatches(coverage.matches, selfSlugs);
    if (!external.length) {
      return { ...base, verdict: KEEP, reason: 'the only ranked match for this keyword is this item\'s own page — a self-match is not a duplicate' };
    }
    const match = external[0];
    const d = describeMatch(match);
    return { ...base, verdict: DROP, match, reason: d?.line || 'exact ranked query for an existing page' };
  }

  if (coverage?.status === POSSIBLE_DUPLICATE) {
    const d = describeMatch(coverage.match);
    return {
      ...base,
      verdict: FLAG,
      match: coverage.match ?? null,
      reason: `possible duplicate (${coverage.tier}) — ${d?.line || 'no evidence recorded'} — a human decides this one, it is NOT dropped`,
    };
  }

  return { ...base, verdict: KEEP, reason: 'no existing page ranks for this keyword and nothing authored looks like it' };
}

/**
 * Screen a whole calendar.
 *
 * @param {{items:Array<object>, statusOf:(item:object)=>string,
 *          classify:(item:object)=>object}} args
 *        `classify` returns a `lib/ranked-coverage.js` verdict for the item's
 *        keyword. Injected rather than called here so this module does no I/O
 *        and so the sweep and the agents cannot drift apart on the rule.
 * @returns {{rows:Array, drop:Array, flag:Array, keep:Array, ineligible:Array,
 *            backlog:number, considered:number}}
 */
export function planSweep({ items = [], statusOf, classify }) {
  const rows = [];
  for (const item of items) {
    let status = 'unknown';
    try { status = statusOf(item) || 'unknown'; } catch { status = 'unknown'; }

    // An item that is not a pure idea is never classified at all — no coverage
    // question is even asked of it, so there is no path by which a scheduled or
    // briefed item can acquire a DROP verdict.
    const elig = eligibility(item, status);
    const coverage = elig.eligible ? classify(item) : null;
    rows.push(decideItem({ item, status, coverage }));
  }

  const of = (v) => rows.filter((r) => r.verdict === v);
  const drop = of(DROP);
  const flag = of(FLAG);
  const keep = of(KEEP);
  const ineligible = of(INELIGIBLE);
  return {
    rows,
    drop,
    flag,
    keep,
    ineligible,
    backlog: drop.length + flag.length + keep.length,
    considered: rows.length,
  };
}

/**
 * Oldest first, so a `--limit` run takes the items that have been sitting
 * longest — the same anti-starvation ordering `agents/queue-autoapply` applies
 * to its own cap.
 */
export function oldestFirst(rows = []) {
  const at = (r) => Date.parse(r?.item?.added_at || '') || 0;
  return [...rows].sort((a, b) => at(a) - at(b));
}

/**
 * Every cleared item, named with the page it collides with and the rule that
 * cleared it — never a bare keyword.
 *
 * `classifyClearedItems` is the precedent: a `[SKIP]` line carrying only a
 * keyword could not distinguish a live competitor page from the item's own
 * draft, and five of the twelve items a re-plan cleared in August had no log
 * line at all.
 */
export function renderPlanLines(plan, { max = Infinity } = {}) {
  const lines = [];
  const section = (title, rows) => {
    lines.push(`${title} — ${rows.length}:`);
    if (!rows.length) lines.push('  (none)');
    for (const r of rows.slice(0, max)) {
      lines.push(`  ${r.slug}  "${r.keyword}"`);
      lines.push(`      ${r.reason}`);
    }
    if (rows.length > max) lines.push(`  (+${rows.length - max} more)`);
    lines.push('');
  };
  section('DROP (exact ranked query for an existing page)', plan.drop);
  section('FLAG (possible duplicate — reported, never dropped)', plan.flag);
  section('KEEP', plan.keep);
  return lines;
}

/**
 * Does this run agree with the read-only measurement that justified writing the
 * script? A silent disagreement is the thing to catch — a sweep that drops
 * nothing looks exactly like a clean corpus.
 */
export function expectationNote(plan, expected = EXPECTED) {
  const diffs = [];
  if (plan.backlog !== expected.backlog) diffs.push(`backlog ${plan.backlog} (expected ${expected.backlog})`);
  if (plan.drop.length !== expected.drop) diffs.push(`drop ${plan.drop.length} (expected ${expected.drop})`);
  if (plan.flag.length !== expected.flag) diffs.push(`flag ${plan.flag.length} (expected ${expected.flag})`);
  if (plan.keep.length !== expected.keep) diffs.push(`keep ${plan.keep.length} (expected ${expected.keep})`);
  if (!diffs.length) {
    return { matches: true, line: `Matches the ${expected.measured_on} read-only measurement exactly (${expected.backlog} backlog: ${expected.drop} drop / ${expected.flag} flag / ${expected.keep} keep).` };
  }
  return {
    matches: false,
    line: `⚠ THIS RUN DISAGREES WITH THE ${expected.measured_on} MEASUREMENT: ${diffs.join(', ')}. `
      + 'The verdicts listed above were re-derived from today\'s ranked index and are what the run '
      + 'will act on — read them before applying.',
  };
}

/**
 * The digest row. Deferred, never `immediate: true`, and never `status: 'error'`
 * for an ordinary sweep — removing duplicates from the queue is the policy
 * working. Only a failure to archive an item is a failure of the agent.
 */
export function renderSweepDigest({ plan, archived = [], failed = [], limited = 0, applied = false, runId = '', backupPath = null, restoreCommand = '' }) {
  const subject = applied
    ? `Backlog duplicate sweep — ${archived.length} idea(s) archived, ${plan.flag.length} flagged for you, ${plan.keep.length} kept`
    : `Backlog duplicate sweep (dry run) — ${plan.drop.length} droppable, ${plan.flag.length} flagged, ${plan.keep.length} kept`;

  const lines = [];
  lines.push(`Screened ${plan.considered} calendar item(s); ${plan.backlog} are pure backlog ideas `
    + `(derived status "pending", no publish_date). ${plan.ineligible.length} were not eligible and were not looked at.`);
  lines.push('');

  if (applied) {
    lines.push(`**Archived ${archived.length} idea(s)** to \`data/calendar/_dropped/\`. Not deleted — every one can be restored.`);
    if (limited) lines.push(`\`--limit\` held back ${limited} further droppable idea(s) for a later run.`);
    lines.push('');
  }

  const rows = applied ? archived : plan.drop;
  for (const r of rows) {
    lines.push(`- **${r.slug}** — "${r.keyword}"`);
    lines.push(`  ${r.reason}`);
    if (restoreCommand) lines.push(`  restore: \`${restoreCommand} ${r.slug}\``);
  }
  if (rows.length) lines.push('');

  if (plan.flag.length) {
    lines.push(`**${plan.flag.length} possible duplicate(s) — NOT dropped, these need your decision:**`);
    for (const r of plan.flag) {
      lines.push(`- ${r.slug} — "${r.keyword}"`);
      lines.push(`  ${r.reason}`);
    }
    lines.push('');
  }

  if (failed.length) {
    lines.push(`⚠ ${failed.length} idea(s) could NOT be archived and were left on the calendar:`);
    for (const f of failed) lines.push(`- ${f.slug}: ${f.error}`);
    lines.push('');
  }

  if (backupPath) lines.push(`Calendar backed up to \`${backupPath}\` before the write.`);
  if (runId) lines.push(`Run: ${runId}`);

  // A failed archive is the one thing here a human is being told to go and fix.
  return { subject, body: lines.join('\n'), status: failed.length ? 'error' : 'success' };
}
