// lib/duplicate-flag.js
//
// "An existing page already ranks for a query CONTAINED IN this candidate."
// `lib/ranked-coverage.js` decides that. This file is what the two DOWNSTREAM
// agents do about it, and until now the answer was nothing at all.
//
// WHY THIS EXISTS
// ───────────────
// PR #919 added the flag. `agents/gsc-opportunity` demotes a flagged row inside
// its own report and hands it on; `agents/pipeline-prioritizer` and
// `agents/content-strategist` both read `unmapped[]` out of
// `data/reports/gsc-opportunity/latest.json` and treated a flagged row exactly
// like a clean one. So the flag was a report annotation with no effect, and the
// duplicate could still be picked up and drafted — which is how
// `best-soap-for-tattoos-…-3` was published over the flagship winner and then
// retired in PR #912.
//
// TWO AGENTS, TWO DIFFERENT ANSWERS, AND THE DIFFERENCE IS THE CONSEQUENCE
// ───────────────────────────────────────────────────────────────────────
//   pipeline-prioritizer  RANKS work. Ordering destroys nothing, so a flagged
//                         idea is DEMOTED below every clean one inside the
//                         existing cap and never dropped — the
//                         `lib/ctr-opportunity.js` doctrine `lib/ranked-coverage.js`
//                         already cites ("it DEMOTES and never drops").
//
//   content-strategist    turns a topic into a calendar item and therefore into
//                         a full paid pipeline. It is the one place where acting
//                         on the flag prevents the spend, so it does not
//                         auto-propose a flagged topic — it WITHHOLDS it and
//                         routes it to the decision surface instead.
//
// WITHHELD IS NOT DISCARDED. A withheld topic is named in the run report, in a
// deferred notification, and as a `needs_decision[]` row in the SAME "Needs your
// decision" block `lib/queue-autoapply.js` (PR #911) and `lib/indexing-escalation.js`
// (PR #914) feed — one renderer, not a parallel one. Nothing on this path
// deletes a brief, a post or a calendar item. CLAUDE.md records a re-plan
// silently clearing 12 of 19 scheduled items with the only trace being `[SKIP]`
// lines in a cron log nobody reads; that is the failure being avoided, not
// repeated.
//
// WHAT IT WILL NOT DO — THE SCOPE BOUNDARY
// ────────────────────────────────────────
// A topic already COMMITTED to the calendar (any item that is not a `review`
// idea) is never withheld. Withholding it would delete it on the next re-plan,
// because `agents/content-strategist` REPLACES the calendar with what survives
// its filters — i.e. withholding a scheduled topic is a CLEARING decision
// wearing a proposal's clothes. `lib/calendar-coverage.js` owns clearing, it has
// over-fired and destroyed planned content before, and it is deliberately not
// touched by this change. A `review` idea is exempt from the exemption: that is
// precisely the row gsc-opportunity just put in the ideas inbox carrying this
// flag, and treating it as "already committed" would disarm the whole check.
//
// STALENESS — STATED, NOT INVENTED
// ────────────────────────────────
// `lib/seo-impact-freshness.js` is the fleet's one staleness policy and it
// governs `data/reports/seo-impact/latest.json`. It does NOT apply here: this is
// a different report on a different cadence, and `SEO_IMPACT_MAX_AGE_DAYS` is
// derived from seo-impact's own position in the scheduler. So nothing here
// spells an age threshold of its own. `agents/pipeline-prioritizer` keeps the
// 5-day `fresh('gsc-opportunity', …)` guard it has always had, which already
// decides whether the unmapped signal exists at all; `agents/content-strategist`
// adds no age logic, because the worst a stale flag can do here is withhold ONE
// topic and put it in front of a human, which is recoverable, whereas the
// staleness policy exists to stop gates that BLOCK or DELETE running on old
// evidence.
//
// FAIL OPEN. A missing, unreadable or flagless report yields an index with
// `available: false` and a `disarmed` reason, and every lookup returns null —
// nothing demoted, nothing withheld, i.e. exactly today's behaviour. Never the
// other direction: "everything is a duplicate" would silently halt content
// proposals. Same rule as `hold.disarmed` and `efficiencyBanner()` — a check
// that quietly stopped checking must not render byte-identically to a clean run.
//
// No I/O. The report is injected, because importing `agents/*/index.js` runs the
// agent and this has to be testable.

/** Lowercase, collapse whitespace, trim. Deliberately no stemming — see below. */
export function normalizeKeyword(str) {
  return String(str ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The slug a keyword becomes, matching the ideas inbox's own slugification. */
export function slugKey(str) {
  return String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Pull the evidence off a flagged row, whatever shape it arrives in.
 *
 * Today `agents/gsc-opportunity` writes `possible_duplicate: true` beside
 * `ranked_match: {query, page, slug, position, impressions}`. A second tier is in
 * flight that produces MORE flagged rows through the same field, so the flag is
 * read as a truthy marker and the evidence is accepted from either place — the
 * field contract is "the row says it is a possible duplicate and carries the
 * collision", not one exact literal. Evidence is optional: a flagged row with no
 * readable evidence is still flagged, and says so rather than being un-flagged.
 */
export function duplicateEvidence(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = (row.possible_duplicate && typeof row.possible_duplicate === 'object')
    ? row.possible_duplicate
    : (row.ranked_match || row.match || null);
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    query: raw.query ? String(raw.query) : null,
    page: raw.page ? String(raw.page) : null,
    slug: raw.slug ? String(raw.slug) : null,
    position: num(raw.position),
    impressions: num(raw.impressions),
  };
}

/** True when a report row carries the flag at all. */
export function isFlagged(row) {
  return Boolean(row && typeof row === 'object' && row.possible_duplicate);
}

/**
 * One line of evidence a human can re-examine without re-running anything.
 *
 * Always names the PAGE, its position and its impressions — the same reason
 * `renderClearedLines` names `data/posts/<slug>` rather than a bare keyword, and
 * the same reason `renderRankedCoverageLines` exists upstream.
 */
export function evidenceLine(evidence) {
  if (!evidence) return 'an existing page already ranks for a query inside this topic (evidence not recorded)';
  const where = evidence.slug ? `data/posts/${evidence.slug}` : (evidence.page || 'an existing page');
  const pos = evidence.position != null ? `position ${evidence.position.toFixed(1)}` : 'position unknown';
  const imp = evidence.impressions != null ? `${evidence.impressions} impressions` : 'impressions unknown';
  const q = evidence.query ? `"${evidence.query}"` : 'a ranked query';
  return `${where} already ranks for ${q} — ${pos}, ${imp}`;
}

/**
 * Build the lookup both agents read, from a parsed gsc-opportunity report.
 *
 * Two sources are unioned on purpose. `unmapped[]` is the array every consumer
 * already reads and is where the flag travels, but it is CAPPED at 25 rows by
 * the producer; `ranked_coverage.possible_duplicates[]` is the run's own
 * complete account of what the gate flagged. Reading only the capped list would
 * let a flagged topic past the gate purely because 25 other candidates outranked
 * it that morning.
 *
 * @param {object|null} report  parsed data/reports/gsc-opportunity/latest.json
 * @returns {{available:boolean, disarmed:string|null, byKey:Map<string,object>, count:number}}
 */
export function buildDuplicateIndex(report) {
  const byKey = new Map();
  const add = (keyword, evidence) => {
    const kw = normalizeKeyword(keyword);
    if (!kw) return;
    const record = { keyword: kw, evidence: evidence || null };
    // Keep the first evidence seen for a keyword; `unmapped[]` is read first and
    // is the row a consumer would have acted on.
    if (!byKey.has(kw)) byKey.set(kw, record);
    const s = slugKey(keyword);
    if (s && !byKey.has(s)) byKey.set(s, byKey.get(kw));
  };

  let sawReport = false;
  if (report && typeof report === 'object') {
    sawReport = true;
    for (const row of (Array.isArray(report.unmapped) ? report.unmapped : [])) {
      if (!isFlagged(row)) continue;
      add(row.keyword, duplicateEvidence(row));
    }
    const rc = report.ranked_coverage;
    for (const f of (Array.isArray(rc?.possible_duplicates) ? rc.possible_duplicates : [])) {
      if (!f) continue;
      add(f.keyword, duplicateEvidence({ possible_duplicate: true, ranked_match: f.match || f.ranked_match }));
    }
  }

  const keywords = [...new Set([...byKey.values()].map((r) => r.keyword))];

  let disarmed = null;
  if (!sawReport) {
    disarmed = 'no gsc-opportunity report — the possible-duplicate flag is OFF this run (nothing demoted, nothing withheld)';
  } else if (report?.ranked_coverage?.disarmed) {
    // The producer already said why it could not judge. Repeat it verbatim
    // rather than inventing a second reason for the same condition.
    disarmed = `ranked-query coverage was OFF upstream: ${report.ranked_coverage.disarmed}`;
  } else if (!report?.ranked_coverage) {
    // A report written before PR #919 — the deploy state in which this check is
    // structurally blind. `available: false` with no reason would render exactly
    // like a clean run, which is the one thing a disarmed gate must never do.
    disarmed = 'the gsc-opportunity report carries no ranked_coverage block (written before the gate existed) — the possible-duplicate flag is OFF this run';
  }
  // Otherwise: the gate ran and flagged nothing. A clean run, NOT a disarmed one.

  return { available: keywords.length > 0, disarmed, byKey, count: keywords.length, keywords };
}

/**
 * Is this keyword flagged? Exact match only — as a raw string or as a slug.
 *
 * Deliberately NOT fuzzy. Widening the match would make this check fire on
 * topics nobody measured, and CLAUDE.md is explicit that widening a coverage
 * check is "precisely how planned content gets killed silently". An unrecognised
 * rewording of a flagged candidate is therefore a MISS — the same
 * unknown-means-allow doctrine `PRODUCT_NOUNS` and `PHRASE_END_FOLLOWERS` carry.
 */
export function lookupDuplicate(keyword, index) {
  if (!index || index.available !== true || !(index.byKey instanceof Map)) return null;
  const kw = normalizeKeyword(keyword);
  if (!kw) return null;
  return index.byKey.get(kw) || index.byKey.get(slugKey(keyword)) || null;
}

/**
 * The set of topics already COMMITTED to the calendar, which are exempt.
 *
 * `review` items are excluded: they are ideas awaiting a human in the dashboard
 * inbox, they are exactly what `agents/gsc-opportunity` pushes a flagged
 * candidate into, and counting them as commitments would disarm this check on
 * its own primary input. `lib/calendar-coverage.js`'s `classifyClearedItems`
 * skips `review` items for the same structural reason.
 */
export function committedTopics(items = []) {
  const out = new Set();
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || it.status === 'review') continue;
    if (it.keyword) out.add(normalizeKeyword(it.keyword));
    if (it.slug) out.add(slugKey(it.slug));
  }
  return out;
}

/**
 * Should `agents/content-strategist` propose this topic?
 *
 * @param {{keyword?:string, slug?:string}} proposal
 * @param {ReturnType<buildDuplicateIndex>} index
 * @param {{committed?:Set<string>}} opts
 * @returns {{withhold:boolean, flagged:boolean, evidence:object|null, exempt:string|null}}
 */
export function decideProposal(proposal, index, { committed = new Set() } = {}) {
  const keyword = proposal?.keyword ?? '';
  const hit = lookupDuplicate(keyword, index);
  if (!hit) return { withhold: false, flagged: false, evidence: null, exempt: null };

  const kw = normalizeKeyword(keyword);
  const slug = slugKey(proposal?.slug || keyword);
  if (committed.has(kw) || (slug && committed.has(slug))) {
    // Already on the calendar as committed work. Withholding it here would
    // CLEAR it on this very run, and clearing is not this change's job.
    return { withhold: false, flagged: true, evidence: hit.evidence, exempt: 'already_scheduled' };
  }
  return { withhold: true, flagged: true, evidence: hit.evidence, exempt: null };
}

/**
 * The decision this leaves for a human, in the vocabulary PR #911 established
 * and PR #914 reused. Same shape, same renderer, one block.
 */
export const DECISION_LABELS = Object.freeze({
  'possible-duplicate':
    'An existing page already ranks for this topic — write it anyway, or drop the topic',
});

/**
 * Withheld topics as `needs_decision[]` rows for the 5 AM digest.
 *
 * `created_at` is deliberately NULL. There is no durable "withheld since" stamp
 * — the strategist re-derives this list from the current report on every run —
 * and stamping today's date would render "stuck 0 days" every morning forever,
 * which is the exact invisibility `lib/indexing-escalation.js` documents and
 * refuses. The digest omits the age when it is absent; that is honest, and a
 * fabricated zero is not.
 *
 * Field names match lib/queue-autoapply.js's rows so agents/daily-summary keeps
 * ONE renderer rather than growing a parallel one.
 */
export function duplicateDecisions(withheld = []) {
  return (Array.isArray(withheld) ? withheld : []).map((w) => {
    const ev = w?.evidence || null;
    return {
      slug: slugKey(w?.slug || w?.keyword || ''),
      title: w?.keyword || w?.slug || 'untitled topic',
      trigger: 'possible duplicate of a ranking page',
      created_at: null,
      decision: 'possible-duplicate',
      reason: ev?.slug || ev?.page
        ? `an existing page already ranks for "${ev.query || 'a contained query'}"`
        : 'an existing page already ranks for a query inside this topic',
      label: DECISION_LABELS['possible-duplicate'],
      last_gate_reason: `${evidenceLine(ev)}. The topic was NOT proposed this run and nothing was deleted — `
        + 'any brief already paid for is untouched. Schedule it by hand to write it anyway, '
        + 'or add the keyword to data/rejected-keywords.json to drop the topic.',
      url: ev?.page || null,
    };
  });
}

/** Console lines for the run's own output. */
export function renderWithheldLines(withheld = [], { max = 20 } = {}) {
  const lines = [];
  for (const w of (withheld || []).slice(0, max)) {
    lines.push(`  "${w.keyword}"`);
    lines.push(`      ${evidenceLine(w.evidence)}`);
  }
  if ((withheld || []).length > max) lines.push(`  (+${withheld.length - max} more)`);
  return lines;
}

/**
 * One DEFERRED notification per run that withheld anything.
 *
 * Never `immediate: true` and never `status: 'error'` — withholding a duplicate
 * is the policy working, not the agent breaking. `'info'` renders the identical
 * body in the ordinary entry list, which is what CLAUDE.md asks for.
 *
 * This is deliberately BESIDE the `needs_decision[]` row rather than instead of
 * it: the digest reads reports written the previous day, so the decision block
 * surfaces tomorrow morning while this entry lands in the same day's JSONL. A
 * withheld topic that is invisible for 24 hours is how a silent drop starts.
 *
 * @returns {{subject:string, body:string, status:string, category:string}|null}
 */
export function withheldDigest(withheld = [], { proposed = 0, exempt = [] } = {}) {
  if (!withheld || !withheld.length) return null;
  const body = [
    `${withheld.length} topic(s) were NOT proposed this run because an existing page already ranks for a query inside them.`,
    '',
    'Nothing was deleted. No brief, post or calendar item was touched — these topics were simply not',
    'added to the calendar, and each one is in the digest\'s "Needs your decision" block with its evidence.',
    '',
    ...renderWithheldLines(withheld),
    '',
    `${proposed} topic(s) were proposed normally.`,
    ...(exempt.length
      ? ['', `${exempt.length} flagged topic(s) were left alone because they are ALREADY on the calendar as committed work — `
        + 'this agent changes what gets proposed, never what gets cleared: ' + exempt.map((e) => `"${e.keyword}"`).join(', ')]
      : []),
  ].join('\n');
  return {
    subject: `Content strategist: ${withheld.length} possible-duplicate topic(s) withheld`,
    body,
    status: 'info',
    category: 'content',
  };
}
