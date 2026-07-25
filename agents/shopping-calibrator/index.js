#!/usr/bin/env node
/**
 * Shopping Calibrator
 *
 * Closes the loop between what Google Shopping SPENDS on and what Amazon data
 * says actually SELLS. Google's search-term report tells you where the money
 * went; Amazon SQP tells you which queries convert and at what price. Until
 * these were joined, the Shopping test was tuned on 27 clicks of Google data
 * while 7 weeks of real purchase data sat unused (see lib/amazon-sqp.js).
 *
 * Three findings it surfaces, in priority order:
 *   1. WASTE     — Google spend on queries the market buys far below our price.
 *                  A 3x price gap cannot be closed by bidding; these become
 *                  negative keywords.
 *   2. MISSING   — queries that produce Amazon sales at full price but which we
 *                  get no Shopping impressions for. This is the demand to buy.
 *   3. PROTECTED — queries that produced sales and must never be negated. Any
 *                  existing negative that blocks one is reported as a conflict.
 *
 * Auto-applies (1) to the shared negative list, per the Autonomy Principle:
 * a query where the market clears below 60% of our price, with a real market
 * behind it and zero sales for us, is not a judgement call. Never negates a
 * protected query. Everything else is reported for a human.
 *
 * Usage:
 *   node agents/shopping-calibrator/index.js              # report only
 *   node agents/shopping-calibrator/index.js --apply      # + write negatives
 *   node agents/shopping-calibrator/index.js --price 30   # override our price
 *
 * Cron (server): weekly, after the Sunday SQP pull settles.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gaqlQuery, mutate } from '../../lib/google-ads.js';
import { loadSqp, priceMismatchedQueries, convertingQueries, protectedQueries, isBrandQuery, norm } from '../../lib/amazon-sqp.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'shopping-calibrator');

const SHARED_SET_NAME = 'RSC | Shopping — Master Negatives';
const CAMPAIGN_PREFIX = 'RSC | Shopping Test';
const DEFAULT_PRICE = 30; // Shopify lotion price — what the Google feed shows

// ── pure helpers ──────────────────────────────────────────────────────────────

/**
 * Does a negative keyword block this query? Mirrors Google's matching semantics.
 * PHRASE: contiguous substring. EXACT: whole string. BROAD: all words present.
 */
export function negativeBlocks(query, text, matchType) {
  const q = norm(query), n = norm(text);
  if (!n) return false;
  if (matchType === 'EXACT') return q === n;
  if (matchType === 'PHRASE') return q.includes(n);
  const qWords = q.split(' ');
  return n.split(' ').every((w) => qWords.includes(w));
}

/** Existing negatives that block a query which actually produced sales. */
export function findConflicts(sqpRows, negatives) {
  const out = [];
  for (const r of sqpRows.filter((x) => x.ourPurchases > 0)) {
    const hits = negatives.filter(([t, m]) => negativeBlocks(r.query, t, m));
    if (hits.length) out.push({ query: r.query, sales: r.ourPurchases, blockedBy: hits });
  }
  return out;
}

/**
 * Amazon-converting queries we are not present for on Shopping. `seenQueries`
 * is the set of Google search terms that produced impressions.
 */
export function findMissingDemand(sqpRows, seenQueries, { minSales = 1 } = {}) {
  const seen = new Set([...seenQueries].map(norm));
  return sqpRows
    .filter((r) => r.ourPurchases >= minSales)
    .filter((r) => !isBrandQuery(r.query))
    .filter((r) => !seen.has(norm(r.query)))
    .sort((a, b) => b.ourPurchases - a.ourPurchases);
}

export function buildMarkdown({ waste, missing, conflicts, converting, weeks, ourPrice, applied }, date) {
  const money = (v) => (v === null || v === undefined ? '—' : `$${v.toFixed(2)}`);
  let md = `# Shopping Calibrator — ${date}\n\n`;
  md += `Calibrated against ${weeks} weeks of Amazon SQP purchase data. Our feed price: ${money(ourPrice)}.\n\n`;

  md += `## Price-mismatched queries (waste)\n\n`;
  if (!waste.length) md += `_None — no high-volume query clears meaningfully below our price._\n\n`;
  else {
    md += `The market buys these far below what we charge, so a paid click cannot convert.\n`;
    md += `${applied ? 'Added as negatives.' : 'Run with --apply to add as negatives.'}\n\n`;
    md += `| Query | Volume | Market sales | Market price | vs ours |\n|---|--:|--:|--:|--:|\n`;
    for (const r of waste.slice(0, 25)) {
      md += `| ${r.query} | ${r.volume} | ${r.marketPurchases} | ${money(r.marketPrice)} | ${(r.priceRatio * 100).toFixed(0)}% |\n`;
    }
    md += `\n`;
  }

  md += `## Converting demand we are missing\n\n`;
  if (!missing.length) md += `_None — we have impressions on every non-brand query that sells._\n\n`;
  else {
    md += `These produced Amazon sales at full price but got no Shopping impressions.\n\n`;
    md += `| Query | Our sales | Volume | Market price |\n|---|--:|--:|--:|\n`;
    for (const r of missing.slice(0, 25)) {
      md += `| ${r.query} | ${r.ourPurchases} | ${r.volume} | ${money(r.marketPrice)} |\n`;
    }
    md += `\n`;
  }

  md += `## Negative-keyword conflicts\n\n`;
  if (!conflicts.length) md += `_None — no existing negative blocks a query that produced a sale._\n\n`;
  else {
    md += `**These negatives are blocking queries that produced sales. Remove them.**\n\n`;
    for (const c of conflicts) {
      md += `- \`${c.query}\` (${c.sales} sales) blocked by ${c.blockedBy.map(([t, m]) => `${m} "${t}"`).join(', ')}\n`;
    }
    md += `\n`;
  }

  const brand = converting.filter((r) => isBrandQuery(r.query));
  const brandSales = brand.reduce((s, r) => s + r.ourPurchases, 0);
  const allSales = converting.reduce((s, r) => s + r.ourPurchases, 0);
  md += `## Demand shape\n\n`;
  md += `- ${allSales} sales across ${converting.length} converting queries\n`;
  if (allSales > 0) {
    md += `- **${brandSales} (${Math.round((brandSales / allSales) * 100)}%) came from brand queries** — no price competition there\n`;
  }
  md += `- Non-brand winners: ${converting.filter((r) => !isBrandQuery(r.query)).slice(0, 6).map((r) => `\`${r.query}\``).join(', ') || '—'}\n`;
  return md;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const priceArg = args.indexOf('--price');
  const ourPrice = priceArg !== -1 ? Number(args[priceArg + 1]) : DEFAULT_PRICE;

  const { rows, weeks } = loadSqp();
  if (!rows.length) {
    console.log('No Amazon SQP data available — nothing to calibrate against.');
    return;
  }
  console.log(`Loaded ${rows.length} queries from ${weeks} SQP weeks.`);

  // Live Google state
  const negRows = await gaqlQuery(`
    SELECT shared_criterion.resource_name, shared_criterion.keyword.text, shared_criterion.keyword.match_type
    FROM shared_criterion WHERE shared_set.name = '${SHARED_SET_NAME}'`);
  const negatives = negRows.map((r) => [r.sharedCriterion.keyword.text, r.sharedCriterion.keyword.matchType]);

  const termRows = await gaqlQuery(`
    SELECT search_term_view.search_term FROM search_term_view
    WHERE campaign.name LIKE '${CAMPAIGN_PREFIX}%' AND segments.date DURING LAST_30_DAYS`);
  const seenQueries = new Set(termRows.map((r) => r.searchTermView.searchTerm));

  const protectedSet = protectedQueries(rows);
  const waste = priceMismatchedQueries(rows, { ourPrice })
    // never negate something already covered by an existing negative
    .filter((r) => !negatives.some(([t, m]) => negativeBlocks(r.query, t, m)));
  const missing = findMissingDemand(rows, seenQueries);
  const conflicts = findConflicts(rows, negatives);
  const converting = convertingQueries(rows);

  console.log(`  ${waste.length} price-mismatched · ${missing.length} missing demand · ${conflicts.length} conflicts · ${protectedSet.size} protected`);

  let applied = false;
  if (APPLY && waste.length) {
    const sets = await gaqlQuery(`
      SELECT shared_set.resource_name, shared_set.name FROM shared_set
      WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`);
    const sharedSet = sets.find((s) => s.sharedSet.name === SHARED_SET_NAME)?.sharedSet.resourceName;
    if (!sharedSet) throw new Error(`Shared set "${SHARED_SET_NAME}" not found`);

    // Final safety rail: never negate a query that produced a sale.
    const safe = waste.filter((r) => !protectedSet.has(norm(r.query)));
    for (let i = 0; i < safe.length; i += 100) {
      await mutate(safe.slice(i, i + 100).map((r) => ({
        sharedCriterionOperation: { create: { sharedSet, keyword: { text: r.query, matchType: 'PHRASE' } } },
      })));
    }
    applied = true;
    console.log(`  applied ${safe.length} negatives`);
  }

  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const md = buildMarkdown({ waste, missing, conflicts, converting, weeks, ourPrice, applied }, date);
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `${date}.md`), md);
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({ date, weeks, ourPrice, waste, missing, conflicts, applied }, null, 2));
  console.log(md);

  const parts = [];
  if (conflicts.length) parts.push(`${conflicts.length} negative(s) blocking converting queries`);
  if (waste.length) parts.push(`${waste.length} price-mismatched quer${waste.length === 1 ? 'y' : 'ies'}${applied ? ' (negated)' : ''}`);
  if (missing.length) parts.push(`${missing.length} converting quer${missing.length === 1 ? 'y' : 'ies'} we are absent for`);
  notify({
    subject: `Shopping calibrator: ${parts.join(' · ') || 'no changes needed'}`,
    body: md,
    status: conflicts.length ? 'error' : 'success',
    category: 'ads',
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
