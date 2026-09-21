#!/usr/bin/env node
/**
 * PR Target Finder
 *
 * Turns the weekly AI-citation data into a ranked, actionable PR target list:
 * the specific third-party pages driving competitor LLM citations, tagged
 * `pitch` (with author + publication + a drafted angle) or `engage`
 * (Reddit/community). PR effort goes where it actually moves LLM rankings.
 *
 * Mines existing data only (data/reports/ai-citations/*.json) — no fresh LLM
 * queries. Enriches the top pitch targets by fetching the page for its byline
 * AND its publication/modification date.
 *
 * TARGET CURRENCY (2026-09-20). An audit of 13 ranked targets found 6 unusable:
 * two sat on articles nobody had touched since 2021 and 2023, two carried a
 * masthead ("Better Goods Team") in the author field, and the extractor was
 * returning bare URLs as authors on four other domains. A byline captured once
 * and never re-checked is how an outreach hour gets spent on a dead page. Two
 * of those three causes are answerable from the page we ALREADY fetch, so both
 * are checked here; each is a FLAG that demotes, never a filter that drops.
 *
 * AUTHOR CURRENCY (2026-09-20) is the follow-up that note deferred: four of the
 * six bad targets had MOVED OUTLET (Nicole Saunders left BestProducts, Tatjana
 * Freund left Elle, Emily Goldman's Hearst address is dead, Masha Vapnitchnaia
 * inactive since ~2023), and a byline captured once is how an outreach hour
 * gets spent on somebody else's ex-employer. `lib/author-currency.js` answers
 * it from the outlet's OWN author page — see that module's header for why a
 * recency signal was measured and rejected, and for what it still cannot see.
 *
 * ENRICHMENT IS CONCURRENT (2026-09-21), and that is what let the budget reach
 * the whole list. Measured on production that morning: **502 pitch targets,
 * 103 enriched** — four fifths of the ranked list shipped as a bare domain with
 * no byline, no date and no author check, so the usable pool was a sample of
 * the list rather than the list. The serial loop could not be raised past ~150
 * without competing with `STEP_TIMEOUT_MS`. See `lib/fetch-pool.js` for the
 * measured width, the per-host cap and why a refused fetch now has its own name
 * instead of reading as "this target has no byline".
 *
 * Usage:
 *   node agents/pr-target-finder/index.js              # full run (weekly)
 *   node agents/pr-target-finder/index.js --weeks 4 --enrich 400
 *   node agents/pr-target-finder/index.js --no-enrich   # skip page fetches (fast)
 *   node agents/pr-target-finder/index.js --concurrency 1   # serial, no deploy
 *
 * Output:
 *   data/reports/pr-targets/latest.json
 *   data/reports/pr-targets/pr-targets-report.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankTargets } from '../../lib/pr-targets.js';
import {
  collectGroundingRedirects, resolveGroundingRedirects,
  loadRedirectCache, saveRedirectCache, DEFAULT_CONCURRENCY,
} from '../../lib/citation-redirects.js';
import { extractByline, pageMentionsBrand, looksLikeStore } from '../../lib/html-byline.js';
import { extractArticleDates, articleAgeDays, isStaleArticle, STALE_ARTICLE_DAYS } from '../../lib/article-freshness.js';
import { extractAuthorUrl, classifyAuthorCurrency } from '../../lib/author-currency.js';
import {
  runPool, fetchWithOutcome, hostGroup, legacyStatus, tallyOutcomes,
  renderOutcomeTally, degradedReason,
  DEFAULT_CONCURRENCY as ENRICH_CONCURRENCY_DEFAULT, MAX_CONCURRENCY,
  DEFAULT_PER_HOST, MAX_PER_HOST,
} from '../../lib/fetch-pool.js';
import {
  planAuthorChecks, articleDateSource, unreachableCurrencyReason, enrichmentCounts,
} from '../../lib/pr-target-enrich.js';
import { fetchAllReviewStats } from '../../lib/judgeme.js';
import { notify } from '../../lib/notify.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

function loadEnv() {
  try {
    const out = {};
    for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  } catch { return {}; }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CITATIONS_DIR = join(ROOT, 'data', 'reports', 'ai-citations');
const OUT_DIR = join(ROOT, 'data', 'reports', 'pr-targets');

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };
const WEEKS = parseInt(argVal('--weeks', '4'), 10);
// ENRICH is the number of top-ranked pitch targets we FETCH — the only rows
// that get a byline, a publication and (since 2026-09-20) an article date.
//
// 20 → 150 (2026-09-20) → 400 (2026-09-21, when the fetches became concurrent).
// The measured constraint that raised it: the live report that morning carried
// **502 pitch targets and 103 enriched**, so four fifths of the ranked list had
// no byline data and the operator's 12 usable candidates came out of a sample.
//
// THE ARITHMETIC AT 400, from the measurements in lib/fetch-pool.js (928 ms
// mean per fetch, 8s timeout, pool width 6):
//
//   typical  400 x 0.93s / 6  ≈  62s   (plus the author pass, ~15s)
//   worst    400 x 8s    / 6  ≈  8.9m  (plus the author pass, ~1.8m)
//
// That is FASTER IN BOTH DIRECTIONS than the serial pass at 150 was (140s
// typical, 20 min worst), against this step's own 150-minute STEP_TIMEOUT_MS
// and a slowest neighbour (ai-citation-tracker) at ~45 min. 400 covers 80% of
// today's 502 rows; it stays a budget rather than "all of them" so that a
// snapshot carrying ten times the citations cannot become an unbounded sweep.
const ENRICH = args.includes('--no-enrich') ? 0 : parseInt(argVal('--enrich', '400'), 10);

// Pool width for the enrichment fetches, and how many of them may be in flight
// against one registrable domain. Both are flags so an operator can turn the
// outbound pressure down WITHOUT A DEPLOY — `--concurrency 1` restores exactly
// the old serial behaviour. The defaults and the ceilings are measured; see the
// header of lib/fetch-pool.js before raising either.
//
// NOTE this governs the ENRICHMENT pool only. The Gemini redirect pass below
// keeps `lib/citation-redirects.js`'s own width, which was measured against a
// single host with its own documented refusal threshold; `--no-resolve` is the
// lever for that pass.
const CONCURRENCY = Math.max(1, Math.min(MAX_CONCURRENCY,
  parseInt(argVal('--concurrency', String(ENRICH_CONCURRENCY_DEFAULT)), 10) || ENRICH_CONCURRENCY_DEFAULT));
const PER_HOST = Math.max(1, Math.min(MAX_PER_HOST,
  parseInt(argVal('--per-host', String(DEFAULT_PER_HOST)), 10) || DEFAULT_PER_HOST));

// AUTHOR_CHECKS caps the SECOND fetch — the author's own archive page, which is
// the only way to ask whether the named byline still works at that outlet.
//
// MEASURED against the live 150-target production report on 2026-09-20, three
// full passes: 60 of 150 rows carry a named-person byline, 65 expose an author
// URL in the article's markup, and those 65 collapse to **40 UNIQUE author
// pages** (a Hearst roundup names the same two editors over and over), so the
// cache below is doing real work. Cost of those 40 fetches: **7.7 seconds**,
// against 51.5s for the 150 article fetches the pass already made. Typical
// added runtime is therefore ~8s on a step whose STEP_TIMEOUT_MS is 150 min.
//
// 80 is 2x the measured demand, which bounds the pathological case rather than
// the normal one: 80 x the 8s timeout is ~10.7 min worst case, so even stacked
// on the article pass's own ~20 min worst case the step has ~5x headroom. A
// row past the budget is SKIPPED AND COUNTED (`author-check-budget-spent`),
// never silently treated as checked-and-fine.
const AUTHOR_CHECKS = args.includes('--no-author-check') ? 0 : parseInt(argVal('--author-checks', '80'), 10);

// Gemini cites through an opaque redirector, so without this pass one of the
// five engines contributes nothing at all and its 3,796 citations pile onto a
// single junk domain. Resolution is HEAD-only, costs no API money, and is
// concurrent — ~3,800 requests at concurrency 8 is a couple of minutes against
// this step's 150-minute budget. `--no-resolve` skips it; the run then degrades
// to exactly its pre-2026-09-20 behaviour. See lib/citation-redirects.js.
const RESOLVE = !args.includes('--no-resolve');
const REDIRECT_CACHE = join(OUT_DIR, 'redirect-cache.json');

// One clock for the whole run, so every row's age is measured against the same
// instant rather than drifting across a 150-page fetch loop.
const NOW = Date.now();

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));
const { brand, competitors } = config;
// Strict aliases for the "does this page already mention us" check — the spaced
// phrase "real skin care" matches generic copy ("real skincare routine"), so use
// only the domain/handle forms.
const STRICT_BRAND_ALIASES = [...new Set([brand.domain, ...brand.aliases.filter((a) => !/\s/.test(a))])];

function loadSnapshots() {
  if (!existsSync(CITATIONS_DIR)) return [];
  const files = readdirSync(CITATIONS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-WEEKS);
  return files.map((f) => { try { return JSON.parse(readFileSync(join(CITATIONS_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

function categoryFromPrompts(prompts) {
  const text = prompts.join(' ').toLowerCase();
  const cats = [
    ['deodorant', 'deodorant'], ['toothpaste', 'toothpaste'], ['lip balm', 'lip balm'],
    ['body lotion', 'body lotion'], ['lotion', 'lotion'], ['soap', 'soap'],
    ['body cream', 'body cream'], ['coconut oil', 'coconut oil product'],
  ];
  for (const [needle, label] of cats) if (text.includes(needle)) return label;
  return 'clean personal-care product';
}

// Every rate-limit retry in the run shares this counter, so the one retry
// `fetchWithOutcome` is willing to make is bounded across the pass and not per
// call. See MAX_RATE_LIMIT_RETRIES in lib/fetch-pool.js.
const rateLimitBudget = { spent: 0 };

function fetchOnce(url) {
  return fetchWithOutcome(url, { rateLimitBudget });
}

// Per-category review proof from Judge.me (real counts + ratings), keyed by the
// same category labels categoryFromPrompts emits. Best-effort: missing creds or
// API failures fall back to a generic proof line, never blocking a run.
const CATEGORY_KEYWORDS = {
  deodorant: ['deodorant'], toothpaste: ['toothpaste'], 'lip balm': ['lip balm', 'lip'],
  'body lotion': ['lotion'], lotion: ['lotion'], soap: ['soap', 'bar'],
  'body cream': ['body cream', 'body butter', 'butter'], 'coconut oil product': ['coconut'],
};
async function loadReviewProof() {
  const env = loadEnv();
  const token = process.env.JUDGEME_API_TOKEN || env.JUDGEME_API_TOKEN;
  const shop = process.env.SHOPIFY_STORE || env.SHOPIFY_STORE;
  const proof = {};
  if (!token || !shop) return proof;
  let stats;
  try { stats = await fetchAllReviewStats(shop, token); } catch { return proof; }
  if (!stats.total) return proof;
  // Tally accurate per-category counts from every product's reviews.
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    let count = 0; let ratingSum = 0;
    for (const [handle, e] of stats.byHandle) {
      const hay = `${e.title} ${handle}`.toLowerCase();
      if (kws.some((k) => hay.includes(k))) { count += e.count; ratingSum += e.ratingSum; }
    }
    if (count) proof[cat] = { reviewCount: count, rating: ratingSum / count };
  }
  proof.__shop = { reviewCount: stats.total, rating: stats.avgRating };
  return proof;
}

function buildAngle(row, reviewProof = {}) {
  const category = categoryFromPrompts(row.prompts);
  const competitor = row.competitors[0] || 'the incumbents';
  const prompt = row.prompts[0];
  // Prefer category-specific proof; fall back to the shop-wide aggregate.
  const stat = reviewProof[category] || reviewProof.__shop;
  const proof = stat
    ? `backed by ${stat.reviewCount}+ verified Judge.me reviews averaging ${stat.rating.toFixed(1)}★`
    : 'backed by our verified Judge.me reviews';
  return `Pitch to be added to their "${prompt}" coverage alongside ${competitor}. Hook: Real Skin Care's coconut-oil ${category} is a clean, aluminum-free alternative — ${proof}.`;
}

function applyCurrency(row, verdict) {
  row.author_currency = verdict.state;
  row.author_currency_reason = verdict.reason || null;
  row.author_currency_evidence = verdict.evidence || null;
  row.author_bio_excerpt = verdict.bio_excerpt || null;
  return row;
}

// PHASE 1 — the ARTICLE fetch, one per row, concurrent.
//
// The html is consumed and DROPPED inside this function. That is deliberate:
// bodies are capped at 400 KB and a 400-row pass holding them all would be up
// to 160 MB on a 961 MB box that has already lost `seo-dashboard` to the OOM
// killer 642 times. Only `concurrency` bodies are ever live at once, and the
// author page's URL — the one thing phase 2 needs from this markup — is
// extracted here rather than later.
async function enrichOneArticle(row, reviewProof) {
  const fetchTarget = row.top_url || `https://${row.domain}/`;
  row.pitch_url = row.top_url || null;
  row.enriched = true;
  const { outcome, html } = await fetchOnce(fetchTarget);
  // A REFUSED FETCH IS NOT AN EMPTY PAGE. Before this field existed a 403, a
  // 429, a timeout and a DNS failure all produced `html = null` and the row
  // shipped as "no byline found — pitch the editor". Measured over 240 live
  // target URLs, ~12% of these fetches never see a page.
  row.enrich_fetch = outcome;

  const { author, publication, author_raw, author_rejected } = extractByline(html, { domain: row.domain });
  row.author = author;
  row.publication = publication || row.domain;
  // A byline we REFUSED is a different finding from a byline we could not
  // find, and the report has to be able to tell them apart — "Better Goods
  // Team" was being pitched as a person. Kept, never dropped.
  row.author_raw = author_raw || null;
  row.author_rejected = author_rejected || null;

  // Is the ARTICLE still maintained? Derived from the page we just fetched —
  // no extra request. Note what this does NOT answer: whether the named
  // author still works there (4 of the 6 bad targets in the 2026-09-20 audit
  // had moved outlets); that is phase 2.
  //
  // FRESHNESS IS ONLY READ FROM A REAL ARTICLE URL WE ACTUALLY RECEIVED, and
  // both halves of that are guards. When a snapshot carries no `top_url` this
  // falls back to the HOMEPAGE, whose `dateModified` is the SITE's and is
  // always fresh — measured live 2026-09-20, `bettergoods.org/` reports 163
  // days while the audit's Better Goods ARTICLE was last touched 2023-08-12.
  // And a page we never received says nothing at all. Reading either as
  // article freshness would silently certify exactly the dead targets this
  // check exists to demote, which is worse than having no check, because it
  // reads as evidence. So an unknown stays unknown, with its reason named.
  row.article_date_source = articleDateSource({ topUrl: row.top_url, outcome });
  const readable = row.article_date_source === 'article';
  const dates = readable ? extractArticleDates(html, { now: NOW }) : { published: null, modified: null };
  row.article_published = dates.published;
  row.article_modified = dates.modified;
  row.article_age_days = articleAgeDays(dates, { now: NOW });
  row.stale_article = readable ? isStaleArticle(dates, { now: NOW }) : null;
  // Two DISTINCT signals, kept separate to avoid the false "already lists us":
  //  - llm_names_us_here (from tracker): the LLM already names RSC for some of
  //    these prompts (we partly win them) — useful context, not "on this page".
  //  - homepage_mentions_us (from fetch, strict alias): low-confidence hint the
  //    site references us. Homepage-only (we have domains, not article URLs).
  row.llm_names_us_here = row.brand_mentioned;
  row.homepage_mentions_us = html != null ? pageMentionsBrand(html, STRICT_BRAND_ALIASES) : null;
  delete row.brand_mentioned;
  row.angle = buildAngle(row, reviewProof);
  // A single-brand ecommerce store cited for "best X" prompts is a competitor
  // we don't track, not a pitch target. Flag it so it drops out of the list.
  // Fails OPEN on an unreachable page: `looksLikeStore(null)` is false, so a
  // row we could not read is kept rather than silently dropped.
  row.likely_store = looksLikeStore(html);

  row.author_url = AUTHOR_CHECKS > 0 && html != null
    ? extractAuthorUrl(html, { domain: row.domain, author: row.author, authorRaw: row.author_raw })
    : null;
  return outcome;
}

// PHASE 2 — the AUTHOR PAGE fetch, planned before any of it happens.
//
// The budget is spent in RANK ORDER by `planAuthorChecks`, so which bylines get
// verified cannot depend on which publisher answered phase 1 fastest. See
// lib/pr-target-enrich.js for why that had to become explicit once the article
// fetches started racing.
async function checkAuthorCurrencies(top) {
  if (AUTHOR_CHECKS <= 0) {
    for (const row of top) {
      applyCurrency(row, { state: 'unknown', reason: 'author-check-disabled' });
      row.author_url = null;
    }
    return [];
  }

  const { funded, unfunded, unchecked } = planAuthorChecks(top, { budget: AUTHOR_CHECKS });

  for (const row of unchecked) {
    if (row.enrich_fetch && row.enrich_fetch !== 'ok') {
      // We never saw the ARTICLE, so we never had the chance to find an author
      // page. Reporting that as `no-author-page-found` would claim we looked.
      applyCurrency(row, { state: 'unknown', reason: unreachableCurrencyReason(row.enrich_fetch) });
      continue;
    }
    applyCurrency(row, classifyAuthorCurrency({
      author: row.author, domain: row.domain, publication: row.publication,
      authorUrl: row.author_url, fetchStatus: null, html: null,
    }));
  }
  for (const group of unfunded) {
    // Skip and count. A budget-capped row is explicitly NOT "checked and fine"
    // — it is one we never looked at, and the report says so.
    for (const row of group.rows) {
      applyCurrency(row, {
        state: 'unknown', reason: 'author-check-budget-spent',
        evidence: null, author_url: group.url,
      });
    }
  }

  // One fetch per DISTINCT author page: several ranked rows can name the same
  // archive page, and one request answers all of them. Classification happens
  // inside the worker so the html is dropped before the next group starts.
  const outcomes = await runPool(funded, async (group) => {
    const { outcome, html } = await fetchOnce(group.url);
    for (const row of group.rows) {
      const verdict = classifyAuthorCurrency({
        author: row.author, domain: row.domain, publication: row.publication,
        authorUrl: group.url, fetchStatus: legacyStatus(outcome), html,
      });
      applyCurrency(row, verdict);
      row.author_page_fetch = outcome;
    }
    return outcome;
  }, { concurrency: CONCURRENCY, perHost: PER_HOST, keyOf: (g) => hostGroup(g.url) });

  return outcomes.map((o) => (typeof o === 'string' ? o : 'network-error'));
}

async function enrichPitchTargets(rows, reviewProof = {}, { onProgress } = {}) {
  const top = rows.slice(0, ENRICH);
  const articleOutcomes = await runPool(
    top,
    (row) => enrichOneArticle(row, reviewProof),
    {
      concurrency: CONCURRENCY,
      perHost: PER_HOST,
      // Throttle on the registrable domain, never the full URL: a row's own
      // article fetch and its author-page fetch land on the same publisher, and
      // `pmc.ncbi.nlm.nih.gov` and `www.nih.gov` are one operator.
      keyOf: (row) => hostGroup(row.top_url || row.domain),
      onProgress,
    },
  );
  const authorOutcomes = await checkAuthorCurrencies(top);

  // attach a templated angle to the un-enriched remainder too. The currency
  // fields are set to null EXPLICITLY rather than left absent: "we did not
  // check this row" and "we checked and found nothing" must not look the same
  // to whoever reads latest.json.
  for (const row of rows.slice(ENRICH)) {
    row.publication = row.domain;
    row.angle = buildAngle(row, reviewProof);
    row.enriched = false;
    row.author_raw = null;
    row.author_rejected = null;
    row.article_published = null;
    row.article_modified = null;
    row.article_age_days = null;
    row.stale_article = null;
    row.article_date_source = null;
    row.author_url = null;
    // `not-attempted` is a first-class outcome, not an absence: "past the
    // budget" and "the publisher refused us" are different findings and the
    // summary counts them apart.
    row.enrich_fetch = 'not-attempted';
    applyCurrency(row, { state: 'unknown', reason: 'not-enriched' });
  }
  return {
    articles: tallyOutcomes(articleOutcomes.map((o) => (typeof o === 'string' ? o : 'network-error'))),
    authors: tallyOutcomes(authorOutcomes),
    rate_limit_retries: rateLimitBudget.spent,
  };
}

// A target is DEMOTED, never dropped, when the page we fetched says the work
// cannot land: the article is abandoned, or the byline is a masthead rather
// than a person. Sorting rather than filtering is the CLAUDE.md rule — a gate
// skips and counts, it never silently deletes work.
//
// A PAGE WE NEVER RECEIVED IS DELIBERATELY NOT DEMOTED. Every demotion here is
// evidence that the work cannot land; "the publisher would not serve our user
// agent" is evidence of nothing about the target, and nytimes.com answering 403
// to a script says nothing about whether it is worth pitching. Demoting on an
// absent measurement is the mistake `hold.disarmed` and `isStaleArticle`'s
// fail-open both exist to refuse. The row carries a ⚠ NOT CHECKED flag and
// keeps its rank, so a human decides.
function isDemoted(row) {
  return row.stale_article === true
    || row.author_rejected != null
    || row.author_currency === 'departed';
}

function sortByUsability(rows) {
  // Stable sort: rank order (already score-descending) is preserved inside
  // each band, so this only ever moves unusable rows to the bottom.
  return rows.map((r, i) => [r, i])
    .sort((a, b) => (isDemoted(a[0]) - isDemoted(b[0])) || (a[1] - b[1]))
    .map(([r]) => r);
}

async function main() {
  console.log('\nPR Target Finder\n');
  const snapshots = loadSnapshots();
  if (!snapshots.length) {
    console.error(`  No ai-citation snapshots in ${CITATIONS_DIR}. Run ai-citation-tracker first.`);
    process.exit(1);
  }
  console.log(`  Snapshots: ${snapshots.length} (last ${WEEKS} weeks)`);

  // Resolve Gemini's redirector BEFORE ranking — the domain is what the
  // redirect hides, so this has to happen before anything is classified or
  // scored. Failures are simply absent from the map and fall back to the
  // redirector host, which classifySource excludes.
  const redirects = RESOLVE ? collectGroundingRedirects(snapshots) : [];
  let resolvedUrls = new Map();
  let redirectStats = null;
  if (redirects.length) {
    const cache = loadRedirectCache(REDIRECT_CACHE);
    console.log(`  Resolving ${redirects.length} Gemini grounding redirect(s) (${cache.size} cached)...`);
    redirectStats = await resolveGroundingRedirects(redirects, {
      concurrency: DEFAULT_CONCURRENCY,
      onProgress: (done, total) => console.log(`    ...${done}/${total}`),
    // The cache is passed in and mutated, so a partial run still persists what
    // it managed to resolve.
      cache,
    });
    resolvedUrls = redirectStats.resolved;
    const kept = saveRedirectCache(REDIRECT_CACHE, cache, redirects);
    console.log(`  Redirects: ${resolvedUrls.size} resolved to a publisher, ${redirectStats.failed} unresolved`
      + `, ${redirectStats.fromCache} from cache${redirectStats.skipped ? `, ${redirectStats.skipped} over budget` : ''}`
      + ` (cache now ${kept})`);
  } else if (!RESOLVE) {
    console.log('  Redirect resolution OFF (--no-resolve): Gemini citations will not name a publisher.');
  }

  const ranked = rankTargets(snapshots, { brand, competitors, resolvedUrls });
  const engage = ranked.engage;
  let excluded = ranked.excluded;
  // Relevance floor: a real PR target shows up across MULTIPLE engines or
  // prompts. Single-citation hits are long-tail noise — count them as filtered.
  const pitch = ranked.pitch.filter((t) => t.engines.length >= 2 || t.prompts.length >= 2);
  const noiseCut = ranked.pitch.length - pitch.length;
  excluded += noiseCut;
  console.log(`  Candidate sources → pitch: ${pitch.length} (cut ${noiseCut} single-citation), engage: ${engage.length}, excluded: ${ranked.excluded}`);

  const reviewProof = await loadReviewProof();
  if (Object.keys(reviewProof).length) console.log(`  Judge.me proof loaded for: ${Object.keys(reviewProof).join(', ')}`);

  let finalPitch = pitch;
  let fetchStats = null;
  let droppedStores = 0;
  if (ENRICH > 0 && pitch.length) {
    const planned = Math.min(ENRICH, pitch.length);
    console.log(`  Enriching top ${planned} pitch targets (author + publication) — concurrency ${CONCURRENCY}, ${PER_HOST}/host...`);
    const started = Date.now();
    fetchStats = await enrichPitchTargets(pitch, reviewProof, {
      onProgress: (done, total) => { if (done % 100 === 0) console.log(`    ...${done}/${total}`); },
    });
    console.log(`  Article fetches: ${renderOutcomeTally(fetchStats.articles)} (${
      ((Date.now() - started) / 1000).toFixed(1)}s${fetchStats.rate_limit_retries ? `, ${fetchStats.rate_limit_retries} rate-limit retr${fetchStats.rate_limit_retries === 1 ? 'y' : 'ies'}` : ''})`);
    console.log(`  Author-page fetches: ${renderOutcomeTally(fetchStats.authors)}`);
    const stores = pitch.filter((t) => t.likely_store);
    droppedStores = stores.length;
    if (stores.length) console.log(`  Dropped ${stores.length} ecommerce/brand site(s): ${stores.map((s) => s.domain).join(', ')}`);
    finalPitch = sortByUsability(pitch.filter((t) => !t.likely_store));
  } else {
    for (const row of pitch) { row.publication = row.domain; row.angle = buildAngle(row, reviewProof); }
  }
  const counts = enrichmentCounts(finalPitch);
  const stale = finalPitch.filter((t) => t.stale_article === true);
  const nonPerson = finalPitch.filter((t) => t.author_rejected != null);
  const withAuthor = counts.with_person_byline;
  // Checkable = enriched AND we had a real article URL AND the page arrived.
  // The rest were compared against a homepage (whose date is the site's) or
  // never received at all, so their freshness is UNKNOWN, not fresh — counted
  // out loud, and SPLIT, so nobody reads "0 stale" as "0 dead" and so a
  // publisher refusing us is never filed under "the snapshot had no URL".
  const checkable = finalPitch.filter((t) => t.article_date_source === 'article');
  const unknownFreshness = finalPitch.filter((t) => t.enriched && t.article_date_source !== 'article');
  const unreachable = finalPitch.filter((t) => t.enriched && t.enrich_fetch && t.enrich_fetch !== 'ok');
  // The PR #944 shape: a pass that fetched far less than it meant to reads
  // exactly like a clean one unless something says so.
  const enrichDegraded = fetchStats ? degradedReason(fetchStats.articles) : null;
  // Author currency. `unknown` is BY FAR the biggest bucket and that is the
  // design — most rows carry no person byline at all — so the three states are
  // counted separately and the unknown REASONS are printed. A run reporting
  // "0 moved" must never be readable as "every author was verified".
  const authorDeparted = finalPitch.filter((t) => t.author_currency === 'departed');
  const authorCurrent = finalPitch.filter((t) => t.author_currency === 'current');
  const authorUnknown = finalPitch.filter((t) => t.enriched && t.author_currency === 'unknown');
  const unknownWhy = authorUnknown.reduce((m, t) => {
    const r = t.author_currency_reason || 'unspecified';
    m[r] = (m[r] || 0) + 1; return m;
  }, {});
  if (ENRICH > 0) {
    console.log(`  Byline: ${withAuthor} named person(s), ${nonPerson.length} rejected (${
      [...new Set(nonPerson.map((t) => t.author_rejected))].join(', ') || '—'})`);
    console.log(`  Freshness: ${stale.length} of ${checkable.length} checkable article(s) past ${STALE_ARTICLE_DAYS}d${
      stale.length ? ` — ${stale.slice(0, 5).map((t) => `${t.domain} (${t.article_age_days}d)`).join(', ')}` : ''}`);
    if (unknownFreshness.length) {
      console.log(`  Freshness UNKNOWN for ${unknownFreshness.length} target(s): ${
        counts.freshness_unknown_homepage} with no article URL in the citation data (homepage only), ${
        counts.freshness_unknown_unreachable} whose page we never received.`);
    }
    if (unreachable.length) {
      console.log(`  Never saw the page for ${unreachable.length} enriched target(s) — ${renderOutcomeTally(
        tallyOutcomes(unreachable.map((t) => t.enrich_fetch)))}. These are NOT "no byline found".`);
    }
    if (enrichDegraded) console.log(`  ⚠ Enrichment is DEGRADED this run: ${enrichDegraded}`);
    if (counts.not_attempted) {
      console.log(`  ${counts.not_attempted} target(s) past the --enrich ${ENRICH} budget were never fetched at all.`);
    }
    console.log(`  Author currency: ${authorDeparted.length} MOVED OUTLET, ${authorCurrent.length} still there, ${authorUnknown.length} unknown${
      authorDeparted.length ? ` — ${authorDeparted.slice(0, 5).map((t) => `${t.author} @ ${t.domain}`).join(', ')}` : ''}`);
    if (authorUnknown.length) {
      console.log(`    could not check: ${Object.entries(unknownWhy).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}`);
    }
  }
  for (const row of engage) {
    row.thread_url = row.top_url || null;
    row.note = `LLMs lean on this for "${row.prompts[0]}" (surfaces ${row.competitors.slice(0, 2).join(', ')}). Engage organically — answer the question, mention RSC where genuinely relevant.`;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    weeks_covered: snapshots.length,
    summary: {
      pitch: finalPitch.length,
      engage: engage.length,
      excluded,
      // Skip-and-count, never a silent drop: every demoted target is still in
      // pitch_targets[], just sorted below the usable ones.
      enriched: counts.enriched,
      // NEVER FETCHED vs FETCHED-AND-REFUSED vs FETCHED-AND-EMPTY: three
      // different findings that the pre-2026-09-21 report collapsed into one
      // ("no byline found"). `enrich_fetch_outcomes` names every one, and
      // `enrich_degraded` is the fail-open record — a pass that quietly stopped
      // fetching must not render identically to a clean one, the same job
      // `hold.disarmed` does for the $0-cluster gate.
      enrich_budget: ENRICH,
      enrich_not_attempted: counts.not_attempted,
      enrich_fetched_ok: counts.fetched_ok,
      enrich_fetch_failed: counts.fetch_failed,
      // TALLIED OVER EVERY FETCH MADE, including rows later dropped as stores,
      // so this reconciles as `ok = enrich_fetched_ok + enrich_dropped_stores`
      // while `enrich_fetched_ok` counts only the rows that survived into
      // pitch_targets[]. Without the store count beside it a reader sees "276
      // ok fetches, 193 pages read" and has no way to close the gap.
      enrich_fetch_outcomes: fetchStats ? fetchStats.articles : null,
      enrich_dropped_stores: droppedStores,
      author_page_fetch_outcomes: fetchStats ? fetchStats.authors : null,
      enrich_rate_limit_retries: fetchStats ? fetchStats.rate_limit_retries : null,
      enrich_degraded: enrichDegraded,
      enrich_concurrency: ENRICH > 0 ? CONCURRENCY : null,
      enrich_per_host: ENRICH > 0 ? PER_HOST : null,
      with_person_byline: withAuthor,
      non_person_bylines: nonPerson.length,
      stale_articles: stale.length,
      freshness_checkable: checkable.length,
      freshness_unknown: unknownFreshness.length,
      freshness_unknown_homepage: counts.freshness_unknown_homepage,
      freshness_unknown_unreachable: counts.freshness_unknown_unreachable,
      stale_article_days: STALE_ARTICLE_DAYS,
      // Author currency. `author_currency_unknown_reasons` is the fail-open
      // record: it is what makes a disarmed check distinguishable from a clean
      // one, the same job `hold.disarmed` does for the $0-cluster gate.
      authors_moved_outlet: authorDeparted.length,
      authors_still_there: authorCurrent.length,
      author_currency_unknown: authorUnknown.length,
      author_currency_unknown_reasons: unknownWhy,
      author_page_fetch_budget: AUTHOR_CHECKS,
      // How many pitch rows carry a real article URL — the precondition for the
      // freshness check above meaning anything. Reported so "0 stale" can never
      // be read as "0 dead" when the real answer is "nothing was checkable".
      with_article_url: finalPitch.filter((t) => t.top_url).length,
      // A resolution pass that quietly stopped resolving looks identical to one
      // with nothing to resolve, so say which it was.
      redirects_seen: redirects.length,
      redirects_resolved: resolvedUrls.size,
      redirects_unresolved: redirectStats ? redirectStats.failed : null,
      redirect_resolution: RESOLVE ? 'on' : 'off',
    },
    pitch_targets: finalPitch,
    community_targets: engage,
  };
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'pr-targets-report.md'), renderMarkdown(report));
  console.log(`  Saved: ${join(OUT_DIR, 'latest.json')}`);

  const top = finalPitch[0];
  // COVERAGE GOES IN THE DIGEST BODY, not only in the JSON. This agent runs
  // unattended as scheduler step 8d and nobody reads its stdout, so an
  // under-enriched run has to say so where a human will see it.
  const coverage = ENRICH > 0
    ? `\n\nCoverage: ${counts.enriched} of ${finalPitch.length} target(s) enriched at concurrency ${CONCURRENCY} (${PER_HOST}/host)`
      + ` — ${counts.fetched_ok} page(s) read, ${counts.fetch_failed} never received (${renderOutcomeTally(
        Object.fromEntries(Object.entries(fetchStats?.articles || {}).filter(([k]) => k !== 'ok' && k !== 'not-attempted')))})`
      + `, ${counts.not_attempted} past the --enrich ${ENRICH} budget.`
      + `\nA fetch we never received is NOT a target with no byline.`
      + (enrichDegraded ? `\n⚠ Enrichment is DEGRADED this run: ${enrichDegraded}` : '')
    : '';
  const currency = ENRICH > 0
    ? `\n\nCurrency: ${withAuthor} named-person byline(s), ${nonPerson.length} rejected as team/URL, ${stale.length} of ${checkable.length} checkable article(s) untouched for over ${STALE_ARTICLE_DAYS} days (${unknownFreshness.length} unknown — ${counts.freshness_unknown_homepage} homepage-only, ${counts.freshness_unknown_unreachable} unreachable).`
      + `\nAuthor moved outlet: ${authorDeparted.length}${authorDeparted.length ? ` (${authorDeparted.slice(0, 5).map((t) => `${t.author} @ ${t.domain}`).join('; ')})` : ''}`
      + ` · ${authorCurrent.length} confirmed still there · ${authorUnknown.length} could not be checked`
      + `${authorUnknown.length ? ` (${Object.entries(unknownWhy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}.`
      + `\nEverything flagged is demoted, never dropped.`
    : '';
  await notify({
    // A demotion is the policy working, so this stays 'info' on the normal
    // deferred path — never 'error', never immediate.
    subject: `PR Targets: ${pitch.length} pitch + ${engage.length} community`,
    body: (top ? `Top target: ${top.publication || top.domain} for "${top.prompts[0]}" (cited by ${top.engines.join(', ')}; lists ${top.competitors.slice(0, 2).join(', ')}).` : 'No addressable targets this run.') + coverage + currency,
    status: 'info', category: 'seo',
  }).catch(() => {});
}

function renderMarkdown(r) {
  const lines = [`# PR Targets — where to focus`, ``, `_${r.weeks_covered} weeks of AI-citation data · ${r.summary.pitch} pitch · ${r.summary.engage} community · generated ${r.generated_at.slice(0, 10)}_`, ``];
  const s = r.summary || {};
  if (s.enrich_fetch_outcomes) {
    // COVERAGE FIRST, because every count below it is a count over the rows we
    // managed to read — "0 stale" means nothing without knowing how many pages
    // we ever saw.
    lines.push(`_Coverage: **${s.enriched ?? 0} of ${s.pitch ?? 0} targets enriched** (budget ${s.enrich_budget}, concurrency ${s.enrich_concurrency}, ${s.enrich_per_host}/host) · ${s.enrich_fetched_ok ?? 0} page(s) read · **${s.enrich_fetch_failed ?? 0} never received** (${renderOutcomeTally(
      Object.fromEntries(Object.entries(s.enrich_fetch_outcomes).filter(([k]) => k !== 'ok' && k !== 'not-attempted')))}) · ${s.enrich_not_attempted ?? 0} past the budget. A page we never received is **not** a target with no byline._`, '');
    if (s.enrich_degraded) {
      lines.push(`> ⚠ **Enrichment was DEGRADED this run:** ${s.enrich_degraded}. Read every count below as a count over what we could reach.`, '');
    }
  }
  if (s.stale_articles != null || s.non_person_bylines != null) {
    lines.push(`_Currency: ${s.with_person_byline ?? 0} named-person byline(s) · ${s.non_person_bylines ?? 0} byline(s) rejected as a team/URL · ${s.stale_articles ?? 0} of ${s.freshness_checkable ?? 0} checkable article(s) untouched for over ${s.stale_article_days ?? '?'} days · ${s.freshness_unknown ?? 0} unknown (${s.freshness_unknown_homepage ?? 0} with no article URL to check, ${s.freshness_unknown_unreachable ?? 0} whose page we never received). **Nothing is dropped** — demoted targets sort to the bottom._`, '');
  }
  if (s.authors_moved_outlet != null) {
    const why = Object.entries(s.author_currency_unknown_reasons || {})
      .sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ');
    lines.push(`_Author currency: **${s.authors_moved_outlet} byline(s) have MOVED OUTLET** · ${s.authors_still_there ?? 0} confirmed still there · ${s.author_currency_unknown ?? 0} could not be checked${why ? ` (${why})` : ''}. An unchecked author is **not** a verified one._`, '');
  }
  lines.push(`## Pitch targets (editorial — get added)`, '');
  for (const t of r.pitch_targets.slice(0, 25)) {
    // Flag the two reasons a target is unpitchable in the heading, so a human
    // scanning the report sees WHY it was demoted without opening the JSON.
    const flags = [];
    if (t.stale_article === true) flags.push(`⚠ STALE (${t.article_age_days}d)`);
    if (t.author_rejected) flags.push(`⚠ NO PERSON (${t.author_rejected})`);
    if (t.author_currency === 'departed') flags.push(`⚠ AUTHOR MOVED (${t.author_currency_reason})`);
    const unreached = t.enriched && t.enrich_fetch && t.enrich_fetch !== 'ok' ? t.enrich_fetch : null;
    if (unreached) flags.push(`⚠ NOT CHECKED (${unreached})`);
    lines.push(`### ${t.publication || t.domain}  ·  score ${t.score}${flags.length ? `  ·  ${flags.join('  ·  ')}` : ''}`);
    // "We fetched the page and it names nobody" and "the publisher would not
    // give us the page" are different instructions to a human. Before
    // 2026-09-21 both rendered as "no byline found — pitch the editor".
    lines.push(`- **Author:** ${t.author
      || (unreached
        ? `_(we never received this page — ${unreached}. Byline UNKNOWN, not absent; open it yourself before writing it off.)_`
        : t.author_rejected
          ? `_(byline "${t.author_raw}" is not a person — ${t.author_rejected}; find a named editor before pitching)_`
          : '_(no byline found — pitch the editor)_')}`);
    if (t.author_currency === 'departed') {
      lines.push(`- **⚠ This person has LEFT ${t.publication || t.domain}:** ${t.author_currency_evidence || t.author_currency_reason}. **Do not pitch them here** — find their replacement on the desk.${
        t.author_url ? ` (${t.author_url})` : ''}`);
      if (t.author_bio_excerpt) lines.push(`  > ${t.author_bio_excerpt}`);
    } else if (t.author && t.author_currency === 'current') {
      lines.push(`- **Author currency:** ${t.author_currency_evidence || 'the outlet still lists them'}.`);
    } else if (t.author && t.enriched) {
      lines.push(`- **Author currency:** _not verified (${t.author_currency_reason || 'unknown'}) — confirm they still work there before pitching._`);
    }
    if (t.article_modified || t.article_published) {
      lines.push(`- **Article last updated:** ${(t.article_modified || t.article_published).slice(0, 10)}${
        t.article_age_days != null ? ` (${t.article_age_days} days ago)` : ''}${
        t.stale_article ? ' — **likely abandoned; verify before spending an outreach hour**' : ''}`);
    } else if (t.enriched) {
      lines.push(`- **Article last updated:** ${
        t.article_date_source === 'unreachable'
          ? `_(we never received this page — ${unreached || 'fetch failed'}. Freshness UNKNOWN, and nothing here has been checked.)_`
          : t.article_date_source === 'homepage'
            ? '_(no article URL in the citation data — only the homepage was fetched, and a homepage date says nothing about the article. Freshness UNKNOWN.)_'
            : '_(page states no date — freshness unknown, not assumed stale)_'}`);
    }
    if (t.pitch_url) lines.push(`- **Article:** ${t.pitch_url}`);
    lines.push(`- **Why:** cited by ${t.engines.join(', ')} for ${t.prompts.map((p) => `_${p}_`).join(', ')}`);
    lines.push(`- **Competitors it surfaces:** ${t.competitors.join(', ') || '—'}${t.homepage_mentions_us ? ' · note: homepage references RSC — verify' : ''}${t.llm_names_us_here ? ' · (we already win some of these prompts)' : ''}`);
    lines.push(`- **Angle:** ${t.angle}`);
    lines.push('');
  }
  // DEMOTION WORKS AGAINST VISIBILITY, so the demoted rows get named here.
  // `sortByUsability` pushes a flagged target below every unflagged one, and
  // the section above only renders the top 25 — measured on the live report a
  // departed byline lands at rank 257 of 285, so its ⚠ flag is never seen.
  // The whole point of skip-and-count is that the count reaches a human.
  const moved = (r.pitch_targets || []).filter((t) => t.author_currency === 'departed');
  if (moved.length) {
    lines.push(`## ⚠ Bylines that have MOVED OUTLET — do not pitch these people here`, '');
    lines.push(`_Each of these is still in the list above (demoted to the bottom, never dropped). The PUBLICATION may still be worth pitching — find whoever holds that desk now._`, '');
    for (const t of moved) {
      lines.push(`- **${t.author}** — named on ${t.publication || t.domain}, but ${t.author_currency_evidence || t.author_currency_reason}.${
        t.author_url ? ` [author page](${t.author_url})` : ''}`);
      if (t.pitch_url) lines.push(`  - article: ${t.pitch_url}`);
    }
    lines.push('');
  }

  lines.push(`## Community targets (Reddit/forums — engage)`, '');
  for (const t of r.community_targets.slice(0, 15)) {
    lines.push(`- **${t.thread_url || t.domain}** — ${t.note}`);
  }
  return lines.join('\n') + '\n';
}

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    notify({ subject: 'PR Target Finder failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('PR Target Finder failed:', err);
    process.exit(1);
  });
}
