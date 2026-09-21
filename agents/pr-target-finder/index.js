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
 * Usage:
 *   node agents/pr-target-finder/index.js              # full run (weekly)
 *   node agents/pr-target-finder/index.js --weeks 4 --enrich 150
 *   node agents/pr-target-finder/index.js --no-enrich   # skip page fetches (fast)
 *
 * Output:
 *   data/reports/pr-targets/latest.json
 *   data/reports/pr-targets/pr-targets-report.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankTargets } from '../../lib/pr-targets.js';
import { extractByline, pageMentionsBrand, looksLikeStore } from '../../lib/html-byline.js';
import { extractArticleDates, articleAgeDays, isStaleArticle, STALE_ARTICLE_DAYS } from '../../lib/article-freshness.js';
import { extractAuthorUrl, classifyAuthorCurrency } from '../../lib/author-currency.js';
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
// It defaulted to 20, which meant 20 of ~349 ranked targets were ever checked
// and everything below rank 20 shipped as a bare domain with a templated angle.
// 150 is the default now. The cost is one GET per row, serial, with an 8s
// timeout — so a worst case of ~20 min and a measured typical of ~1s/page
// (~2.5 min). This runs inside scheduler.js step 8d, whose STEP_TIMEOUT_MS is
// 150 min and whose slowest neighbour (ai-citation-tracker) already takes ~45,
// so the worst case still fits. Do NOT raise it much further without making
// the fetches concurrent: past ~150 the serial worst case starts competing
// with the step timeout rather than with the budget.
const ENRICH = args.includes('--no-enrich') ? 0 : parseInt(argVal('--enrich', '150'), 10);

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

// Returns { status, html }. `status` is 'ok' | 'not-found' | 'error', because
// the author-currency check needs to tell a page the outlet has REMOVED from a
// page we simply could not reach — see lib/author-currency.js, where neither
// one demotes but only one of them is worth printing as a finding.
async function fetchPageResult(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSC-PR-Research/1.0)' },
      redirect: 'follow', signal: controller.signal,
    });
    if (res.status === 404 || res.status === 410) return { status: 'not-found', html: null };
    if (!res.ok) return { status: 'error', html: null };
    return { status: 'ok', html: (await res.text()).slice(0, 400_000) };
  } catch { return { status: 'error', html: null }; }
  finally { clearTimeout(timer); }
}

async function fetchPage(url, timeoutMs = 8000) {
  return (await fetchPageResult(url, timeoutMs)).html;
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

// One fetch per DISTINCT author page per run. Measured on the live report, 65
// rows with an author URL collapse to 40 distinct pages — a Hearst roundup
// names the same two editors across half a dozen targets — so without this the
// check would cost 60% more requests for byte-identical answers.
async function checkAuthorCurrency(row, html, cache, budget) {
  const authorUrl = extractAuthorUrl(html, {
    domain: row.domain, author: row.author, authorRaw: row.author_raw,
  });
  row.author_url = authorUrl;

  // Nothing to check: no person to place, or the article names no archive page.
  // Both are UNKNOWN with a reason, never a demotion.
  if (!row.author || !authorUrl) {
    const verdict = classifyAuthorCurrency({
      author: row.author, domain: row.domain, publication: row.publication,
      authorUrl, fetchStatus: null, html: null,
    });
    return applyCurrency(row, verdict);
  }

  let page = cache.get(authorUrl);
  if (!page) {
    if (budget.spent >= AUTHOR_CHECKS) {
      // Skip and count. A budget-capped row is explicitly NOT "checked and
      // fine" — it is one we never looked at, and the report says so.
      return applyCurrency(row, {
        state: 'unknown', reason: 'author-check-budget-spent',
        evidence: null, author_url: authorUrl,
      });
    }
    budget.spent += 1;
    page = await fetchPageResult(authorUrl);
    cache.set(authorUrl, page);
  }
  const verdict = classifyAuthorCurrency({
    author: row.author, domain: row.domain, publication: row.publication,
    authorUrl, fetchStatus: page.status, html: page.html,
  });
  return applyCurrency(row, verdict);
}

function applyCurrency(row, verdict) {
  row.author_currency = verdict.state;
  row.author_currency_reason = verdict.reason || null;
  row.author_currency_evidence = verdict.evidence || null;
  row.author_bio_excerpt = verdict.bio_excerpt || null;
  return row;
}

async function enrichPitchTargets(rows, reviewProof = {}) {
  const top = rows.slice(0, ENRICH);
  const authorCache = new Map();
  const authorBudget = { spent: 0 };
  for (const row of top) {
    // Fetch the actual cited ARTICLE when we have its URL (newer snapshots) —
    // that's where the real byline lives. Fall back to the homepage.
    const fetchTarget = row.top_url || `https://${row.domain}/`;
    row.pitch_url = row.top_url || null;
    row.enriched = true;
    const html = await fetchPage(fetchTarget);
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
    // had moved outlets). That needs a per-author lookup and is deliberately a
    // separate change.
    //
    // FRESHNESS IS ONLY READ FROM A REAL ARTICLE URL, and that is the whole
    // guard. When a snapshot carries no `top_url` this loop falls back to the
    // HOMEPAGE — 87 of the 106 rows on the 2026-07-02 report — and a homepage's
    // `dateModified` is the SITE's, which is always fresh. Measured live
    // 2026-09-20: `bettergoods.org/` reports dateModified 2026-04-10 (163 days)
    // even though the audit's Better Goods ARTICLE was last touched 2023-08-12,
    // and `thefiltery.com/` reports yesterday. Reading those as article
    // freshness would silently certify exactly the dead targets this check
    // exists to demote — worse than having no check at all, because it reads
    // as evidence. So an unknown stays unknown.
    row.article_date_source = row.top_url ? 'article' : 'homepage';
    const dates = row.top_url ? extractArticleDates(html, { now: NOW }) : { published: null, modified: null };
    row.article_published = dates.published;
    row.article_modified = dates.modified;
    row.article_age_days = articleAgeDays(dates, { now: NOW });
    row.stale_article = row.top_url ? isStaleArticle(dates, { now: NOW }) : null;
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
    row.likely_store = looksLikeStore(html);

    // Does the named byline still work HERE? Answered from the outlet's own
    // author page (a second GET, deduped and capped). Fails open in every
    // branch it cannot answer — see lib/author-currency.js.
    if (AUTHOR_CHECKS > 0) {
      await checkAuthorCurrency(row, html, authorCache, authorBudget);
    } else {
      applyCurrency(row, { state: 'unknown', reason: 'author-check-disabled' });
      row.author_url = null;
    }
  }
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
    applyCurrency(row, { state: 'unknown', reason: 'not-enriched' });
  }
  return rows;
}

// A target is DEMOTED, never dropped, when the page we fetched says the work
// cannot land: the article is abandoned, or the byline is a masthead rather
// than a person. Sorting rather than filtering is the CLAUDE.md rule — a gate
// skips and counts, it never silently deletes work.
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

  const ranked = rankTargets(snapshots, { brand, competitors });
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
  if (ENRICH > 0 && pitch.length) {
    console.log(`  Enriching top ${Math.min(ENRICH, pitch.length)} pitch targets (author + publication)...`);
    await enrichPitchTargets(pitch, reviewProof);
    const stores = pitch.filter((t) => t.likely_store);
    if (stores.length) console.log(`  Dropped ${stores.length} ecommerce/brand site(s): ${stores.map((s) => s.domain).join(', ')}`);
    finalPitch = sortByUsability(pitch.filter((t) => !t.likely_store));
  } else {
    for (const row of pitch) { row.publication = row.domain; row.angle = buildAngle(row, reviewProof); }
  }
  const stale = finalPitch.filter((t) => t.stale_article === true);
  const nonPerson = finalPitch.filter((t) => t.author_rejected != null);
  const withAuthor = finalPitch.filter((t) => t.author).length;
  // Checkable = enriched AND we had a real article URL. The rest were only ever
  // compared against a homepage, so their freshness is UNKNOWN, not fresh —
  // counted out loud so nobody reads "0 stale" as "0 dead".
  const checkable = finalPitch.filter((t) => t.article_date_source === 'article');
  const unknownFreshness = finalPitch.filter((t) => t.enriched && t.article_date_source !== 'article');
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
      console.log(`  Freshness UNKNOWN for ${unknownFreshness.length} target(s): no article URL in the citation data, homepage only.`);
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
      enriched: finalPitch.filter((t) => t.enriched).length,
      with_person_byline: withAuthor,
      non_person_bylines: nonPerson.length,
      stale_articles: stale.length,
      freshness_checkable: checkable.length,
      freshness_unknown: unknownFreshness.length,
      stale_article_days: STALE_ARTICLE_DAYS,
      // Author currency. `author_currency_unknown_reasons` is the fail-open
      // record: it is what makes a disarmed check distinguishable from a clean
      // one, the same job `hold.disarmed` does for the $0-cluster gate.
      authors_moved_outlet: authorDeparted.length,
      authors_still_there: authorCurrent.length,
      author_currency_unknown: authorUnknown.length,
      author_currency_unknown_reasons: unknownWhy,
      author_page_fetch_budget: AUTHOR_CHECKS,
    },
    pitch_targets: finalPitch,
    community_targets: engage,
  };
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'pr-targets-report.md'), renderMarkdown(report));
  console.log(`  Saved: ${join(OUT_DIR, 'latest.json')}`);

  const top = finalPitch[0];
  const currency = ENRICH > 0
    ? `\n\nCurrency: ${withAuthor} named-person byline(s), ${nonPerson.length} rejected as team/URL, ${stale.length} of ${checkable.length} checkable article(s) untouched for over ${STALE_ARTICLE_DAYS} days (${unknownFreshness.length} unknown — homepage only).`
      + `\nAuthor moved outlet: ${authorDeparted.length}${authorDeparted.length ? ` (${authorDeparted.slice(0, 5).map((t) => `${t.author} @ ${t.domain}`).join('; ')})` : ''}`
      + ` · ${authorCurrent.length} confirmed still there · ${authorUnknown.length} could not be checked`
      + `${authorUnknown.length ? ` (${Object.entries(unknownWhy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}.`
      + `\nEverything flagged is demoted, never dropped.`
    : '';
  await notify({
    // A demotion is the policy working, so this stays 'info' on the normal
    // deferred path — never 'error', never immediate.
    subject: `PR Targets: ${pitch.length} pitch + ${engage.length} community`,
    body: (top ? `Top target: ${top.publication || top.domain} for "${top.prompts[0]}" (cited by ${top.engines.join(', ')}; lists ${top.competitors.slice(0, 2).join(', ')}).` : 'No addressable targets this run.') + currency,
    status: 'info', category: 'seo',
  }).catch(() => {});
}

function renderMarkdown(r) {
  const lines = [`# PR Targets — where to focus`, ``, `_${r.weeks_covered} weeks of AI-citation data · ${r.summary.pitch} pitch · ${r.summary.engage} community · generated ${r.generated_at.slice(0, 10)}_`, ``];
  const s = r.summary || {};
  if (s.stale_articles != null || s.non_person_bylines != null) {
    lines.push(`_Currency: ${s.with_person_byline ?? 0} named-person byline(s) · ${s.non_person_bylines ?? 0} byline(s) rejected as a team/URL · ${s.stale_articles ?? 0} of ${s.freshness_checkable ?? 0} checkable article(s) untouched for over ${s.stale_article_days ?? '?'} days · ${s.freshness_unknown ?? 0} with no article URL to check. **Nothing is dropped** — demoted targets sort to the bottom._`, '');
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
    lines.push(`### ${t.publication || t.domain}  ·  score ${t.score}${flags.length ? `  ·  ${flags.join('  ·  ')}` : ''}`);
    lines.push(`- **Author:** ${t.author
      || (t.author_rejected
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
      lines.push(`- **Article last updated:** ${t.article_date_source === 'homepage'
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
