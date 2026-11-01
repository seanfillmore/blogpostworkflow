#!/usr/bin/env node
/**
 * GSC Opportunity Agent
 *
 * Daily report of search queries that represent the highest-leverage SEO
 * opportunities visible in Google Search Console:
 *
 *   1. Low-CTR queries  — impressions ≥ 100, CTR ≤ 2%. Title/meta rewrite candidates.
 *   2. Page-2 queries   — positions 11–30. Quick-win candidates (feeds Task 2).
 *   3. Unmapped queries — high impressions, no internal page targets the keyword.
 *                          New-topic candidates (feeds the strategist).
 *
 * COVERAGE IS TWO QUESTIONS, NOT ONE (2026-09-19). `loadCoveredKeywords` reads
 * the single `target_keyword` a human wrote on each post/brief, and `isMapped`
 * substring-matches against it. That misses the queries a page ACTUALLY ranks
 * for, and on 2026-09-06 it cost a full paid pipeline:
 * `best-soap-for-tattoos-what-to-use-for-safe-healing-3` was drafted, written,
 * illustrated and published as a third-generation duplicate of the site's
 * biggest CTR opportunity, because the winner's target keyword
 * ("best soap to use on new tattoo") neither contains nor is contained by the
 * duplicate's ("best soap for tattoos what to use for safe healing").
 * Retired in PR #912.
 *
 * `lib/ranked-coverage.js` adds the second question — does an existing page
 * already RANK for this? — and the third — does this look like something
 * somebody has already DECIDED to write? Three tiers, and only one of them acts:
 *
 *   AUTO-COVERED        the candidate IS a ranked query for another page above
 *                       both floors. Treated as mapped, silently. Measured
 *                       false-positive rate on the live calendar: zero.
 *   POSSIBLE DUPLICATE  (a) a ranked query is a substring of the candidate, or
 *                       (b) the candidate is a near-duplicate of a
 *                       `target_keyword` authored on an existing brief or post.
 *                       The row is KEPT, stamped with its evidence and WHICH
 *                       TIER fired, demoted below the clean rows, and reported
 *                       in its own section — the measured false positives in
 *                       both tiers make this a decision a human takes, not one
 *                       this agent takes.
 *
 * Tier (b) exists because the ranked tiers leave a measured hole:
 * "best soap to clean new tattoo" differs from the tattoo flagship's authored
 * keyword "best soap to use on new tattoo" by ONE WORD IN THE MIDDLE, so no
 * substring rule in either direction sees it. See that module's header for the
 * threshold table and for why no lexical rule separates the false positives from
 * the tattoo case.
 *
 * No tier may drop a candidate, and each degrades independently: no GSC
 * snapshots switches (a) off, no authored keywords switches (b) off, and either
 * way the run says so rather than looking like a clean sweep. A day with zero
 * CLEAN candidates is an honest answer on a 206-page corpus — the report, the
 * subject line and `latest.json` all distinguish it from a check that never ran.
 *
 * Outputs:
 *   data/reports/gsc-opportunity/YYYY-MM-DD.md — human-readable report
 *   data/reports/gsc-opportunity/latest.json   — machine-readable for digest +
 *                                                 strategist consumption
 *
 * Cron: daily 6:30 AM PT (after gsc-collector runs).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { getLowCTRKeywords, getPage2Keywords } from '../../lib/gsc.js';
import { upsertItem, loadCalendar } from '../../lib/calendar-store.js';
import { loadIndex, lookupByKeyword, validationTag } from '../../lib/keyword-index/consumer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const REPORTS_DIR = join(ROOT, 'data', 'reports', 'gsc-opportunity');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');

import { listAllSlugs, getPostMeta, resolvePostSlug, handleFromUrl } from '../../lib/posts.js';
import { isRejected as sharedIsRejected } from '../../lib/rejected-keywords.js';
import {
  aggregateRankedQueries,
  buildRankedIndex,
  buildAuthoredIndex,
  classifyRankedCoverage,
  describeMatch,
  renderRankedCoverageLines,
  slugifyKeyword,
  AUTO_COVERED,
  POSSIBLE_DUPLICATE,
  RANKED_WINDOW_DAYS,
  RANKED_POS_MAX,
  RANKED_MIN_IMPRESSIONS,
  SEMANTIC_THRESHOLD,
  TIER_AUTHORED_SEMANTIC,
} from '../../lib/ranked-coverage.js';

// Re-exported rather than re-declared: the self-match test compares a
// candidate's slug against an authored entry's keyword slugified the same way,
// so both sides have to be ONE spelling. See the note on `slugifyKeyword` in
// lib/ranked-coverage.js.
export { slugifyKeyword };

const LOW_CTR_MIN_IMPRESSIONS = 100;
const LOW_CTR_MAX_CTR = 0.02;
const UNMAPPED_MIN_IMPRESSIONS = 50;

const GSC_SNAPSHOT_DIR = join(ROOT, 'data', 'snapshots', 'gsc');

/**
 * Load the shared rejected-keywords list. Rows matching any rejection are
 * filtered out of every section of the report. Uses the same matching
 * semantics as the content-strategist / calendar-runner.
 */
function loadRejections() {
  const p = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

// One rule, in lib/rejected-keywords.js. This was a local copy; there were seven,
// and three of them disagreed about what `exact` means.
function isRejected(keyword, rejections) {
  return sharedIsRejected(keyword, rejections);
}

/**
 * Every `target_keyword` a human AUTHORED, with the slug it was authored on.
 *
 * One walk, two consumers: `isMapped` wants the bare keyword set it has always
 * had, and the semantic tier wants the slug beside each keyword so a brief can
 * recognise itself. Deriving both from one scan is what stops the two drifting.
 *
 * The `.endsWith('.json')` filter on the briefs directory is load-bearing and is
 * the same convention `tests/lib/briefs-dir-readers.test.js` pins across all six
 * readers: it is what makes `data/briefs/_dropped/` invisible, so an archived
 * brief can never flag a live candidate as a duplicate of work we deliberately
 * took out of circulation.
 */
export function loadAuthoredCoverage({ briefsDir = BRIEFS_DIR, slugs = null } = {}) {
  const entries = [];
  if (existsSync(briefsDir)) {
    for (const f of readdirSync(briefsDir).filter((x) => x.endsWith('.json'))) {
      try {
        const b = JSON.parse(readFileSync(join(briefsDir, f), 'utf8'));
        if (b.target_keyword) entries.push({ keyword: b.target_keyword, slug: b.slug || f.replace(/\.json$/, ''), source: 'brief' });
      } catch { /* ignore */ }
    }
  }
  for (const slug of (slugs ?? listAllSlugs())) {
    try {
      const p = getPostMeta(slug);
      if (p?.target_keyword) entries.push({ keyword: p.target_keyword, slug, source: 'post' });
    } catch { /* ignore */ }
  }
  return entries;
}

function loadCoveredKeywords(entries) {
  // Build a set of keywords already targeted by an existing brief or post.
  return new Set((entries ?? loadAuthoredCoverage()).map((e) => String(e.keyword).toLowerCase()));
}

function isMapped(keyword, covered) {
  const kw = keyword.toLowerCase().trim();
  if (covered.has(kw)) return true;
  // Soft mapping: any covered keyword that contains the query, or vice versa
  for (const target of covered) {
    if (target.includes(kw) || kw.includes(target)) return true;
  }
  return false;
}

/**
 * Read the trailing `RANKED_WINDOW_DAYS` daily GSC snapshots and build the
 * ranked-query index.
 *
 * FAILS OPEN, in every arm: no directory, no files, a file that will not parse,
 * or nothing clearing the floors all yield `available: false` with a `disarmed`
 * reason — which classifies every candidate as UNCOVERED, i.e. exactly the
 * behaviour this agent had before ranked coverage existed. The opposite
 * direction ("assume covered") would silently stop all content proposals.
 *
 * Note `data/snapshots/gsc/` is gitignored and written by cron on the server, so
 * a local checkout legitimately has nothing here; that is the disarmed path
 * working, not a fault.
 */
export function loadRankedIndex({ dir = GSC_SNAPSHOT_DIR, days = RANKED_WINDOW_DAYS } = {}) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(-days);
  } catch {
    return { ...buildRankedIndex([]), disarmed: `no ${dir} — ranked-query coverage is OFF this run (authored keywords only)`, files: 0 };
  }

  const snapshots = [];
  let unreadable = 0;
  for (const f of files) {
    try { snapshots.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { unreadable++; }
  }

  // Slug resolution: a Shopify article handle is NOT always the local post slug,
  // so `resolvePostSlug` is asked first. The handle is the fallback rather than
  // null, because it is what self-match comparison actually needs — the
  // candidate's own slug is derived from its keyword the same way — and because
  // a local checkout carries only a fraction of the post directories the server
  // does. Measured: 59 of 59 ranked pages resolve with the fallback in place.
  const cache = new Map();
  const pageSlug = (page) => {
    if (cache.has(page)) return cache.get(page);
    let slug = null;
    try { slug = resolvePostSlug(page) || handleFromUrl(page) || null; } catch { slug = null; }
    cache.set(page, slug);
    return slug;
  };

  const index = buildRankedIndex(aggregateRankedQueries(snapshots), { pageSlug });
  return { ...index, files: files.length, unreadable };
}

/**
 * Split candidate rows on ranked coverage.
 *
 * AUTO_COVERED rows leave the unmapped list (they are covered). POSSIBLE_DUPLICATE
 * rows STAY in it, carrying `possible_duplicate` and the evidence that earned the
 * flag; `sortUnmapped` then demotes them below the clean rows so the inbox slice
 * fills with genuinely-uncovered topics first. Demote, never drop — the same rule
 * `lib/ctr-opportunity.js` applies to a cluster it wants to discourage.
 *
 * Both flagged tiers land in the same list and the same field, distinguished by
 * `ranked_match.tier` — extending the evidence shape rather than growing a
 * parallel one, so nothing downstream has to join two arrays to learn that a row
 * is contested.
 */
export function applyRankedCoverage(rows = [], index, { selfSlugFor = slugifyKeyword, authored = null } = {}) {
  const unmapped = [];
  const autoCovered = [];
  const flagged = [];
  for (const row of rows) {
    const verdict = classifyRankedCoverage(row.keyword, index, { selfSlug: selfSlugFor(row.keyword), authored });
    if (verdict.status === AUTO_COVERED) {
      autoCovered.push({ ...row, ranked_match: verdict.match });
      continue;
    }
    if (verdict.status === POSSIBLE_DUPLICATE) {
      const out = { ...row, possible_duplicate: true, duplicate_tier: verdict.tier, ranked_match: verdict.match };
      flagged.push({ keyword: row.keyword, tier: verdict.tier, match: verdict.match });
      unmapped.push(out);
      continue;
    }
    unmapped.push(row);
  }
  return { unmapped, autoCovered, flagged };
}

function sourceSymbol(tag) {
  if (tag === 'amazon') return '★';
  if (tag === 'gsc_ga4') return '✓';
  return '—';
}

export function annotateRows(rows, index) {
  return rows.map((r) => ({
    ...r,
    validation_source: validationTag(lookupByKeyword(index, r.keyword)),
  }));
}

export function sortUnmapped(rows) {
  // Outermost band: a row an existing page may already rank for sorts BELOW
  // every clean row, whatever its validation source, so the 15-row ideas-inbox
  // slice fills with genuinely-uncovered topics first. It is a demotion and not
  // a filter — a flagged row still reaches the inbox when there is room, still
  // carries its evidence, and is still listed in the report.
  const duplicateBand = (r) => (r.possible_duplicate ? 1 : 0);
  const band = (r) => (r.validation_source === 'amazon' ? 0 : 1);
  return [...rows].sort((a, b) => {
    const dd = duplicateBand(a) - duplicateBand(b);
    if (dd !== 0) return dd;
    const db = band(a) - band(b);
    if (db !== 0) return db;
    return b.impressions - a.impressions;
  });
}

async function main() {
  console.log('\nGSC Opportunity Agent\n');

  mkdirSync(REPORTS_DIR, { recursive: true });

  const rejections = loadRejections();
  if (rejections.length) console.log(`  Loaded ${rejections.length} keyword rejection${rejections.length === 1 ? '' : 's'}`);

  console.log('  Fetching low-CTR queries...');
  const lowCTRRaw = await getLowCTRKeywords(LOW_CTR_MIN_IMPRESSIONS, LOW_CTR_MAX_CTR, 50, 90);
  const lowCTR = lowCTRRaw.filter((r) => !isRejected(r.keyword, rejections));
  console.log(`    ${lowCTR.length} low-CTR queries (impressions ≥ ${LOW_CTR_MIN_IMPRESSIONS}, CTR ≤ ${LOW_CTR_MAX_CTR * 100}%)${lowCTRRaw.length !== lowCTR.length ? ` — ${lowCTRRaw.length - lowCTR.length} filtered by rejection list` : ''}`);

  console.log('  Fetching page-2 queries...');
  const page2Raw = await getPage2Keywords(50, 90);
  const page2 = page2Raw.filter((r) => !isRejected(r.keyword, rejections));
  console.log(`    ${page2.length} page-2 queries (positions 11-20)${page2Raw.length !== page2.length ? ` — ${page2Raw.length - page2.length} filtered` : ''}`);

  console.log('  Computing unmapped opportunities...');
  const authoredEntries = loadAuthoredCoverage();
  const covered = loadCoveredKeywords(authoredEntries);
  // Unmapped = any low-CTR query above the impression floor that no
  // existing brief/post targets. These are net-new topic candidates.
  const authoredUnmapped = lowCTR
    .filter((r) => r.impressions >= UNMAPPED_MIN_IMPRESSIONS && !isMapped(r.keyword, covered))
    .sort((a, b) => b.impressions - a.impressions);

  // Second coverage question: does an existing page already RANK for this?
  const rankedIndex = loadRankedIndex();
  if (rankedIndex.disarmed) {
    console.log(`    ⚠ ${rankedIndex.disarmed}`);
  } else {
    console.log(`    ranked-query coverage: ${rankedIndex.byQuery.size} queries from ${rankedIndex.files} snapshot(s), position <= ${RANKED_POS_MAX}, >= ${RANKED_MIN_IMPRESSIONS} impressions/${RANKED_WINDOW_DAYS}d`);
  }
  // Third coverage question: does this look like something somebody has already
  // DECIDED to write? Independent of the ranked index — an unbriefed topic ranks
  // for nothing, so the two corpora fail for different reasons and degrade
  // separately.
  const authoredIndex = buildAuthoredIndex(authoredEntries);
  if (authoredIndex.disarmed) {
    console.log(`    ⚠ ${authoredIndex.disarmed}`);
  } else {
    console.log(`    semantic coverage: ${authoredIndex.entries.length} authored target keyword(s), similarity >= ${SEMANTIC_THRESHOLD}`);
  }

  const ranked = applyRankedCoverage(authoredUnmapped, rankedIndex, { authored: authoredIndex });
  if (ranked.autoCovered.length) {
    console.log(`    ${ranked.autoCovered.length} dropped as already-ranked (exact ranked query for an existing page)`);
  }
  if (ranked.flagged.length) {
    console.log(`    ${ranked.flagged.length} POSSIBLE DUPLICATE(S) — kept and demoted, not dropped:`);
    for (const line of renderRankedCoverageLines(ranked.flagged, { max: 10 })) console.log(`  ${line}`);
  }

  // DEMOTE BEFORE THE CAP. `sortUnmapped` is called here, before annotation, so
  // the flagged rows fall below the clean ones while there are still more than
  // 25 candidates; demoting afterwards would let flagged rows eat the 25 slots
  // and leave clean topics unreported. (Validation tags are not attached yet, so
  // this pass only applies the duplicate band and the impressions order — the
  // Amazon band is applied by the second call below, once they are.)
  const unmapped = sortUnmapped(ranked.unmapped).slice(0, 25);
  console.log(`    ${unmapped.length} unmapped high-impression queries${ranked.flagged.length ? ` (${unmapped.filter((r) => r.possible_duplicate).length} of them flagged as possible duplicates)` : ''}`);

  // "NOTHING CLEAN TO PROPOSE" AND "THE CHECK IS OFF" MUST NOT READ ALIKE. On a
  // 206-page corpus it is an honest, expected answer that every current
  // candidate collides with something — but an empty-looking feed is also
  // exactly what a broken agent produces, so the run states which one it is
  // every time, here and in the report and the digest. Same reasoning as
  // `hold.disarmed`: never infer "clean" from a count of zero.
  const cleanCount = ranked.unmapped.filter((r) => !r.possible_duplicate).length;
  const gatesOff = [rankedIndex.disarmed, authoredIndex.disarmed].filter(Boolean);
  const emptyVerdict = gatesOff.length === 2
    ? `BOTH coverage checks were OFF this run — an empty feed here is a fault, not a finding: ${gatesOff.join(' / ')}`
    : cleanCount === 0 && authoredUnmapped.length > 0
      ? `0 clean candidates: all ${authoredUnmapped.length} collided with existing work (${ranked.autoCovered.length} already ranked, ${ranked.flagged.length} flagged). The checks RAN — this is the corpus being well covered, not a broken feed.`
      : null;
  if (emptyVerdict) console.log(`    ${emptyVerdict}`);

  const idx = loadIndex(ROOT);
  const lowCTRTagged = annotateRows(lowCTR, idx);
  const page2Tagged = annotateRows(page2, idx);
  const unmappedTagged = annotateRows(unmapped, idx);
  const unmappedSorted = sortUnmapped(unmappedTagged);
  if (idx) {
    const amazonCount = unmappedSorted.filter((r) => r.validation_source === 'amazon').length;
    console.log(`    ${amazonCount} of those are Amazon-validated`);
  } else {
    console.log('    keyword-index.json missing — Source column will be blank');
  }

  const dateStr = new Date().toISOString().slice(0, 10);

  // ── Markdown report ─────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`# GSC Opportunity Report — ${dateStr}`);
  lines.push('');
  lines.push(`Last 90 days of Google Search Console data. The three sections below represent the cheapest wins available right now.`);
  lines.push('');

  lines.push(`## Low-CTR Queries (rewrite title/meta)`);
  lines.push(`Queries getting ≥${LOW_CTR_MIN_IMPRESSIONS} impressions but CTR ≤${LOW_CTR_MAX_CTR * 100}%.`);
  lines.push('');
  if (lowCTRTagged.length === 0) {
    lines.push('_No low-CTR queries above threshold._');
  } else {
    lines.push('| Query | Impressions | Clicks | CTR | Position | Source |');
    lines.push('|-------|-------------|--------|-----|----------|--------|');
    for (const r of lowCTRTagged.slice(0, 20)) {
      lines.push(`| ${r.keyword} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)} | ${sourceSymbol(r.validation_source)} |`);
    }
  }
  lines.push('');

  lines.push(`## Page-2 Queries (quick-win candidates)`);
  lines.push(`Positions 11–20. Feed these into the quick-win-targeter for rewrite + internal-link pushes.`);
  lines.push('');
  if (page2Tagged.length === 0) {
    lines.push('_No page-2 queries above threshold._');
  } else {
    lines.push('| Query | Impressions | Clicks | CTR | Position | Source |');
    lines.push('|-------|-------------|--------|-----|----------|--------|');
    for (const r of page2Tagged.slice(0, 20)) {
      lines.push(`| ${r.keyword} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)} | ${sourceSymbol(r.validation_source)} |`);
    }
  }
  lines.push('');

  lines.push(`## Unmapped Queries (new-topic candidates)`);
  lines.push(`Queries with ≥${UNMAPPED_MIN_IMPRESSIONS} impressions where no existing brief/post targets the keyword, and which no existing page already ranks for. ★ rows are Amazon-validated and sorted to the top. ⚠ rows are possible duplicates — see the section below. Strategist input.`);
  lines.push('');
  if (unmappedSorted.length === 0) {
    lines.push('_All high-impression queries are already targeted._');
  } else {
    lines.push('| Query | Impressions | Position | Source | Duplicate? |');
    lines.push('|-------|-------------|----------|--------|------------|');
    for (const r of unmappedSorted) {
      lines.push(`| ${r.keyword} | ${r.impressions} | ${r.position.toFixed(1)} | ${sourceSymbol(r.validation_source)} | ${r.possible_duplicate ? '⚠' : ''} |`);
    }
  }
  lines.push('');

  // ── Possible duplicates ─────────────────────────────────────────────────────
  // Emitted whenever the gate ran, including with nothing to say, so "ran and
  // found nothing" can be told from "did not run" — the same reasoning
  // impression-leaks.json already carries.
  lines.push(`## Possible Duplicates (a decision, not a verdict)`);
  lines.push('');
  lines.push(`- **Ranked-query tier** — an existing page already ranks for a query CONTAINED IN the candidate (position ≤${RANKED_POS_MAX}, ≥${RANKED_MIN_IMPRESSIONS} impressions over ${RANKED_WINDOW_DAYS} days). ${rankedIndex.disarmed ? `**OFF this run: ${rankedIndex.disarmed}**` : `On: ${rankedIndex.byQuery.size} ranked queries.`}`);
  lines.push(`- **Semantic tier** — the candidate is a near-duplicate of a \`target_keyword\` somebody already AUTHORED on a brief or post (core-token similarity ≥${SEMANTIC_THRESHOLD}). ${authoredIndex.disarmed ? `**OFF this run: ${authoredIndex.disarmed}**` : `On: ${authoredIndex.entries.length} authored keywords.`}`);
  lines.push('');
  lines.push(`Flagged rows are still listed above and still reach the ideas inbox — demoted, never dropped — because the measured false positives in both tiers make this a call a human takes. ${ranked.autoCovered.length} further candidate(s) were removed outright as EXACT ranked queries for an existing page.`);
  lines.push('');
  if (emptyVerdict) {
    lines.push(`**${emptyVerdict}**`);
    lines.push('');
  }
  if (!ranked.flagged.length) {
    lines.push(gatesOff.length === 2
      ? '_Neither tier ran, so nothing could be flagged._'
      : '_No candidate collided with existing work this run._');
  } else {
    lines.push('| Candidate | Signal | Matched | Where | Evidence |');
    lines.push('|-----------|--------|---------|-------|----------|');
    for (const f of ranked.flagged) {
      const d = describeMatch(f.match);
      lines.push(`| ${f.keyword} | ${d.signal} | ${d.matched} | ${d.where} | ${d.evidence} |`);
    }
  }
  lines.push('');

  writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), lines.join('\n'));
  console.log(`\n  Report saved: data/reports/gsc-opportunity/${dateStr}.md`);

  // ── Machine-readable latest ─────────────────────────────────────────────────
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    low_ctr: lowCTRTagged.slice(0, 20),
    page_2: page2Tagged.slice(0, 20),
    unmapped: unmappedSorted,
    // Consumers read `unmapped[]`; the flag travels ON the row (`possible_duplicate`,
    // `ranked_match`) so nothing has to join two arrays to see it. This block is the
    // run's own account of what the gate did, including when it did nothing.
    ranked_coverage: {
      window_days: RANKED_WINDOW_DAYS,
      position_max: RANKED_POS_MAX,
      min_impressions: RANKED_MIN_IMPRESSIONS,
      available: rankedIndex.available,
      disarmed: rankedIndex.disarmed,
      snapshots_read: rankedIndex.files ?? 0,
      ranked_queries: rankedIndex.byQuery?.size ?? 0,
      // The semantic tier reports itself separately, because it can be ON while
      // the ranked one is OFF and vice versa. A reader must never take one
      // `disarmed: null` as evidence that both checks ran.
      semantic: {
        threshold: SEMANTIC_THRESHOLD,
        available: authoredIndex.available,
        disarmed: authoredIndex.disarmed,
        authored_keywords: authoredIndex.entries.length,
      },
      // `clean_unmapped` is what stops an honest "everything collided" reading
      // as a broken feed; `empty_verdict` says which of the two it is in words.
      candidates_considered: authoredUnmapped.length,
      clean_unmapped: cleanCount,
      empty_verdict: emptyVerdict,
      auto_covered: ranked.autoCovered.map((r) => ({ keyword: r.keyword, impressions: r.impressions, match: r.ranked_match })),
      possible_duplicates: ranked.flagged,
    },
  }, null, 2));

  // ── Push unmapped queries to ideas inbox ────────────────────────────────────
  // unmappedSorted has ★ Amazon-validated rows first, so the top-15 slice
  // naturally biases the strategist's queue toward validated demand.
  const existingSlugs = new Set(loadCalendar().items.map((i) => i.slug));
  let inboxAdded = 0;
  for (const r of unmappedSorted.slice(0, 15)) {
    const slug = r.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (existingSlugs.has(slug)) continue;
    upsertItem({
      slug,
      keyword: r.keyword,
      title: '',
      source: 'gsc_opportunity',
      status: 'review',
      volume: null,
      kd: null,
      impressions: r.impressions,
      publish_date: null,
      added_at: new Date().toISOString(),
      validation_source: r.validation_source,
      // Carried onto the inbox item so the human clicking Approve sees the
      // collision, not just the report's reader.
      possible_duplicate: Boolean(r.possible_duplicate),
      duplicate_tier: r.duplicate_tier ?? null,
      ranked_match: r.ranked_match ?? null,
    });
    inboxAdded++;
  }
  if (inboxAdded > 0) console.log(`  ${inboxAdded} unmapped queries added to ideas inbox`);

  // One DEFERRED notification, `status: 'info'` — a flagged candidate is the
  // policy working, not a broken agent, so it never goes in the Failures block
  // and never emails at call time.
  const semanticFlagged = ranked.flagged.filter((f) => f.tier === TIER_AUTHORED_SEMANTIC).length;
  const duplicateBody = [
    ...(rankedIndex.disarmed ? ['', `⚠ Ranked-query coverage was OFF this run: ${rankedIndex.disarmed}`] : []),
    ...(authoredIndex.disarmed ? ['', `⚠ Semantic duplicate detection was OFF this run: ${authoredIndex.disarmed}`] : []),
    ...(gatesOff.length === 2
      ? ['Candidates were judged on the authored-keyword substring rule alone — the behaviour that produced the "…-safe-healing-3" duplicate on 2026-09-06.']
      : []),
    ...(emptyVerdict ? ['', emptyVerdict] : []),
    ...(ranked.flagged.length
      ? ['', `${ranked.flagged.length} candidate(s) may duplicate existing work (${ranked.flagged.length - semanticFlagged} already-ranked page, ${semanticFlagged} authored keyword) — kept and demoted, NOT dropped. Decide before drafting:`, ...renderRankedCoverageLines(ranked.flagged, { max: 10 })]
      : []),
  ];

  await notify({
    // The subject carries the CLEAN count as well as the total, so a day where
    // every candidate collided cannot be misread as a day the agent found
    // nothing to look at.
    subject: `GSC Opportunities: ${lowCTRTagged.length} low-CTR, ${page2Tagged.length} page-2, ${unmappedSorted.length} unmapped (${cleanCount} clean)${ranked.flagged.length ? `, ${ranked.flagged.length} possible duplicate(s)` : ''}`,
    body: [
      `Top low-CTR queries:\n${lowCTRTagged.slice(0, 5).map((r) => `  ${sourceSymbol(r.validation_source)} ${r.keyword} — ${r.impressions} impr, ${(r.ctr * 100).toFixed(1)}% CTR`).join('\n')}`,
      '',
      `Top unmapped queries:\n${unmappedSorted.slice(0, 5).map((r) => `  ${sourceSymbol(r.validation_source)}${r.possible_duplicate ? ' ⚠' : ''} ${r.keyword} — ${r.impressions} impr`).join('\n')}`,
      ...duplicateBody,
    ].join('\n'),
    status: 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nGSC opportunity report complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('GSC opportunity agent failed:', err);
    process.exit(1);
  });
}
