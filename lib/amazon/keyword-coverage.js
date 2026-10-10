/**
 * Amazon listing keyword coverage — pure logic, no I/O.
 *
 * Question it answers: which real Amazon searches put an RSC listing in front of a
 * shopper, carry real volume, and contain a word that listing does not index anywhere
 * (title, bullets or backend search terms)?
 *
 * Source of truth for demand is Amazon's own Search Query Performance report (pulled
 * weekly by scripts/amazon/explore-search-query-performance-rsc.mjs). Every SQP row is a
 * query that already showed the ASIN at least once, so a gap here is demand Amazon is
 * already matching us to, not a guess. Built 2026-10-10 after an audit found the listing
 * copy had never been checked against this data (the last listing review used one week
 * from April and the ad search-term report).
 *
 * REPORT ONLY. Nothing here, or in the agent that calls it, writes to Amazon. A gap is
 * a candidate for a human: some query words are competitor brands not yet on the
 * exclusion list, and some are claims. Excluded queries are reported with their reason
 * so the exclusion list stays honest.
 */
import { checkSeoCopyFields } from '../seo-copy-health-gate.js';

const STOPWORDS = new Set([
  'for', 'and', 'the', 'with', 'of', 'to', 'in', 'on', 'by', 'or', 'an',
  'de', 'el', 'la', 'los', 'las', 'para', 'con', 'en', 'del', 'que', 'por',
]);

/** Lower-case word tokens, apostrophes folded ("men's" → "mens"), stopwords and 1-char tokens dropped. */
export function tokens(text) {
  return String(text ?? '').toLowerCase().normalize('NFKC')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9áéíóúñü]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Folded possessives ("men's" → "mens") are NOT plurals, so they must match exactly:
 * a listing saying "Men" was shown 6 times on "mens deodorant" (105,708 searches over six
 * weeks, SQP 2026-08-16 → 09-26). Treating "mens" as covered by "men" would hide that.
 */
const POSSESSIVES = new Set(['mens', 'womens', 'childrens', 'kids', 'girls', 'boys', 'ladies']);

/** Amazon matches singular and plural forms, so either spelling counts as indexed. */
export function isIndexed(word, set) {
  if (set.has(word)) return true;
  if (POSSESSIVES.has(word)) return false;
  if (word.endsWith('es') && set.has(word.slice(0, -2))) return true;
  if (word.endsWith('s') && set.has(word.slice(0, -1))) return true;
  return set.has(`${word}s`) || set.has(`${word}es`);
}

/** Product line from a listing title. Order matters: "Moisturizing Cream" is cream, not lotion. */
export function productLine(title) {
  const t = String(title ?? '').toLowerCase();
  if (/toothpaste/.test(t)) return 'toothpaste';
  if (/deodorant/.test(t)) return 'deodorant';
  if (/lip balm/.test(t)) return 'lip balm';
  if (/\bcream\b|crème|creme/.test(t)) return 'cream';
  if (/lotion/.test(t)) return 'lotion';
  if (/hand soap|liquid soap|foam/.test(t)) return 'hand soap';
  if (/soap/.test(t)) return 'bar soap';
  return 'other';
}

/**
 * Collapse weekly SQP rows into per-ASIN, per-query totals. A query's search volume is
 * a property of the QUERY and WEEK, repeated on every ASIN's row, so it is summed once
 * per (query, week) rather than once per row.
 */
export function aggregateSqp(rows) {
  const byAsin = new Map();
  const volume = new Map();
  const seenWeek = new Set();
  const weeks = new Set();
  for (const r of rows ?? []) {
    const q = r?.searchQueryData?.searchQuery;
    if (!r?.asin || !q) continue;
    const week = r.startDate ?? '';
    weeks.add(week);
    const vk = `${q}\u0000${week}`;
    if (!seenWeek.has(vk)) {
      seenWeek.add(vk);
      volume.set(q, (volume.get(q) ?? 0) + (Number(r.searchQueryData.searchQueryVolume) || 0));
    }
    if (!byAsin.has(r.asin)) byAsin.set(r.asin, new Map());
    const m = byAsin.get(r.asin);
    const a = m.get(q) ?? { impressions: 0, clicks: 0, carts: 0, purchases: 0 };
    a.impressions += Number(r.impressionData?.asinImpressionCount) || 0;
    a.clicks += Number(r.clickData?.asinClickCount) || 0;
    a.carts += Number(r.cartAddData?.asinCartAddCount) || 0;
    a.purchases += Number(r.purchaseData?.asinPurchaseCount) || 0;
    m.set(q, a);
  }
  return { byAsin, volume, weeks: [...weeks].filter(Boolean).sort() };
}

/** Why a query must never be targeted, or null. Brand first, then word rules, then the claim gate. */
export function exclusionReason(query, exclusions) {
  const q = ` ${tokens(query).join(' ')} `;
  for (const brand of exclusions?.brands ?? []) {
    const b = tokens(brand).join(' ');
    if (b && q.includes(` ${b} `)) return { kind: 'brand', term: brand, why: 'Competitor brand: Amazon policy forbids targeting it.' };
  }
  const rules = (exclusions?.never ?? []).map((n) => ({ re: new RegExp(n.pattern, 'i'), why: n.why }));
  for (const w of tokens(query)) {
    const hit = rules.find((r) => r.re.test(w));
    if (hit) return { kind: 'never', term: w, why: hit.why };
  }
  const gate = checkSeoCopyFields({ query });
  if (!gate.ok) return { kind: 'claim', term: gate.blocking[0].match, why: `Claim gate: ${gate.blocking[0].category}.` };
  return null;
}

/**
 * @param {object} p
 * @param {Array} p.rows        raw SQP rows (any number of weeks)
 * @param {Array} p.listings    [{asin, sku, title, bullets[], keywords}] — one per ASIN
 * @param {object} p.exclusions config/amazon-keyword-exclusions.json
 */
export function buildCoverage({ rows, listings, exclusions }) {
  const { byAsin, volume, weeks } = aggregateSqp(rows);
  const listingByAsin = new Map((listings ?? []).map((l) => [l.asin, l]));
  const lines = {};
  const unlisted = [];

  for (const [asin, queries] of byAsin) {
    const l = listingByAsin.get(asin);
    if (!l) { unlisted.push(asin); continue; }
    const line = productLine(l.title);
    const visible = new Set(tokens([l.title, ...(l.bullets ?? [])].join(' ')));
    const backend = new Set(tokens(l.keywords));
    const all = new Set([...visible, ...backend]);
    const L = (lines[line] ??= { queries: new Map(), asins: new Set() });
    L.asins.add(asin);

    for (const [query, a] of queries) {
      const missing = tokens(query).filter((w) => !isIndexed(w, all));
      const row = L.queries.get(query) ?? {
        query, volume: volume.get(query) ?? 0, impressions: 0, clicks: 0, carts: 0, purchases: 0,
        missingByAsin: {}, exclusion: exclusionReason(query, exclusions),
      };
      row.impressions += a.impressions; row.clicks += a.clicks; row.carts += a.carts; row.purchases += a.purchases;
      if (missing.length) row.missingByAsin[asin] = missing;
      L.queries.set(query, row);
    }
  }

  const out = {};
  for (const [line, L] of Object.entries(lines)) {
    const rowsAll = [...L.queries.values()].sort((a, b) => b.volume - a.volume);
    const gaps = rowsAll.filter((r) => !r.exclusion && Object.keys(r.missingByAsin).length)
      .map((r) => ({ ...r, missingWords: [...new Set(Object.values(r.missingByAsin).flat())] }));
    out[line] = {
      asins: [...L.asins].sort(),
      queryCount: rowsAll.length,
      covered: rowsAll.filter((r) => !Object.keys(r.missingByAsin).length).length,
      gaps,
      excluded: rowsAll.filter((r) => r.exclusion && Object.keys(r.missingByAsin).length),
      totals: rowsAll.reduce((t, r) => ({
        impressions: t.impressions + r.impressions, clicks: t.clicks + r.clicks,
        carts: t.carts + r.carts, purchases: t.purchases + r.purchases,
      }), { impressions: 0, clicks: 0, carts: 0, purchases: 0 }),
    };
  }
  return { weeks, lines: out, unlisted: unlisted.sort() };
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/** Full markdown report. */
export function renderMarkdown(report, { top = 15, generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    '# Amazon keyword coverage',
    '',
    `Generated ${generatedAt}. Weeks of Search Query Performance: ${report.weeks.join(', ') || 'none'}.`,
    '',
    'A **gap** is a real Amazon search that already showed one of our listings and contains a word that listing does not index in its title, bullets or backend search terms. Volume is Amazon\'s total searches for the query across those weeks. Report only: nothing here was changed on Amazon. Excluded queries (competitor brands, things we cannot claim, formats we do not sell) are listed separately with the reason; the list lives in `config/amazon-keyword-exclusions.json`.',
    '',
  ];
  for (const [line, L] of Object.entries(report.lines).sort((a, b) => b[1].totals.impressions - a[1].totals.impressions)) {
    lines.push(`## ${line}`, '');
    lines.push(`${L.asins.length} listing(s), ${L.queryCount} queries, ${L.covered} fully covered, ${L.gaps.length} gap(s), ${L.excluded.length} excluded. Our totals: ${fmt(L.totals.impressions)} impressions, ${fmt(L.totals.clicks)} clicks, ${fmt(L.totals.carts)} carts, ${fmt(L.totals.purchases)} purchases.`, '');
    if (L.gaps.length) {
      lines.push('| volume | our imp / clicks / carts / buys | query | missing words | listings missing them |', '|--:|--|--|--|--|');
      for (const g of L.gaps.slice(0, top)) {
        lines.push(`| ${fmt(g.volume)} | ${g.impressions} / ${g.clicks} / ${g.carts} / ${g.purchases} | ${g.query} | ${g.missingWords.join(' ')} | ${Object.keys(g.missingByAsin).join(', ')} |`);
      }
      lines.push('');
    }
    if (L.excluded.length) {
      lines.push('<details><summary>Excluded queries</summary>', '');
      for (const x of L.excluded.slice(0, top)) lines.push(`- ${fmt(x.volume)} · ${x.query} · ${x.exclusion.kind}: ${x.exclusion.term} (${x.exclusion.why})`);
      lines.push('', '</details>', '');
    }
  }
  if (report.unlisted.length) lines.push(`ASINs in the search data with no readable listing: ${report.unlisted.join(', ')}`, '');
  return lines.join('\n');
}

/** Short digest body: the top gaps per line. */
export function renderDigest(report, { top = 5 } = {}) {
  const out = [];
  for (const [line, L] of Object.entries(report.lines)) {
    if (!L.gaps.length) continue;
    out.push(`${line}: ${L.gaps.length} gap(s)`);
    for (const g of L.gaps.slice(0, top)) out.push(`  ${fmt(g.volume)} searches · "${g.query}" · missing: ${g.missingWords.join(' ')} (our ${g.impressions} imp / ${g.carts} carts)`);
  }
  return out.length ? out.join('\n') : 'Every search query in the window is covered by the listing copy.';
}

export function gapCount(report) {
  return Object.values(report.lines).reduce((n, L) => n + L.gaps.length, 0);
}
