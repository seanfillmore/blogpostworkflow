#!/usr/bin/env node
/**
 * Build a REVIEWABLE change list for the Culina account. READ ONLY — reads the CSVs
 * pulled by pull-ads-reports.mjs and the 60-day search-term pull, writes a markdown/JSON
 * proposal, and touches nothing on Amazon.
 *
 *   node scripts/amazon/build-negation-list.mjs [--json]
 *
 * NOTHING HERE IS APPLIED. Per the operator ruling of 2026-09-05 an agent may not write
 * to a paid ads account without a human reviewing the exact list of writes first, and
 * that is doubly true here because the account is run by an outside agency — these are
 * their changes to make or refuse, not ours to push.
 *
 * TWO ACTIONS, AND THE SPLIT IS NOT COSMETIC. In an auto/broad/phrase campaign one bid
 * governs many search terms, so the only surgical instrument is a negative keyword. In a
 * manual-exact or product-target campaign the target IS the term, so negating throws away
 * a target that was deliberately chosen — there the reversible move is a bid cut. Same
 * rule the audit's §2 uses, applied to the same campaign-naming convention.
 *
 * ATTRIBUTION IS 30-DAY HERE AND THAT IS THE CONSERVATIVE DIRECTION. The 60-day
 * search-term pull carries `purchases30d`/`sales30d`, which credits a term with MORE
 * orders than the 7-day basis the P&L uses. So every term below looks BETTER than it
 * really is, and a term that fails this screen would fail harder on 7-day. Using the
 * flattering basis to justify a negation is the safe way round.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { isOneToOne } from './culina-ppc-audit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT = join(ROOT, 'data', 'reports', 'amazon-ads-audit', 'latest.json');
const PPC = join(ROOT, 'data', 'reports', 'culina-ppc', 'latest.json');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-ads-audit');

/**
 * Culina sells cast-iron CARE. A shopper searching for the pan itself is not a buyer of
 * soap, however well the ad is written.
 *
 * The two lists are deliberately asymmetric: OBJECT is what the shopper wants to own,
 * CARE is what they want to do to it. A term carrying BOTH ("lodge cast iron cleaning
 * kit", "cast iron skillet cleaner") is real demand and must survive — which is why CARE
 * is checked as a veto rather than OBJECT being checked alone.
 */
const OBJECT = /\b(skillets?|cookware|pots?|pans?|dutch ovens?|frying pans?|woks?|kettles?|casseroles?|griddles?|grills?|lodge|le creuset|stargazer|field company)\b/;
const CARE = /\b(clean\w*|care|soap|oil|conditioner|conditioning|season\w*|scrub\w*|rust|restor\w*|polish\w*|kit|brush|chainmail|maintenance|wax|remover|eraser|protect\w*|treatment)\b/;

/** An ASIN typed as a search term is a product-target match, not a shopper's words. */
const IS_ASIN = /^b0[a-z0-9]{8}$/i;

const MIN_CLICKS = 5;

const money = (n) => `$${n.toFixed(2)}`;
const pctOf = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : '—');

export function classifyTerm(term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return 'skip';
  if (IS_ASIN.test(t)) return 'asin-target';
  if (/culina/.test(t)) return 'brand';            // our own name — never negate
  if (CARE.test(t)) return 'care';                 // care intent wins, even with an object
  if (OBJECT.test(t)) return 'cookware';
  return 'other';
}

export function buildProposal(searchTerms, { minClicks = MIN_CLICKS, breakEvenAcos = 0.269 } = {}) {
  const byTerm = new Map();
  for (const r of searchTerms) {
    const term = String(r.searchTerm || '').trim().toLowerCase();
    if (!term) continue;
    const cur = byTerm.get(term) ?? {
      term, clicks: 0, cost: 0, orders: 0, sales: 0,
      negateCampaigns: new Set(), bidDownCampaigns: new Set(),
    };
    cur.clicks += r.clicks ?? 0;
    cur.cost += r.cost ?? 0;
    cur.orders += r.purchases30d ?? 0;
    cur.sales += r.sales30d ?? 0;
    // A term can appear in both kinds of campaign at once; the action differs per campaign,
    // so both sets are kept rather than the term being given one label.
    (isOneToOne(String(r.campaignName ?? '')) ? cur.bidDownCampaigns : cur.negateCampaigns)
      .add(r.campaignName);
    byTerm.set(term, cur);
  }

  const rows = [...byTerm.values()]
    .map((r) => ({
      ...r,
      kind: classifyTerm(r.term),
      acos: r.sales > 0 ? r.cost / r.sales : null,
      negateCampaigns: [...r.negateCampaigns],
      bidDownCampaigns: [...r.bidDownCampaigns],
    }))
    .filter((r) => r.kind === 'cookware' && r.clicks >= minClicks)
    .sort((a, b) => b.cost - a.cost);

  // INTENT IS THE HYPOTHESIS; ACoS IS THE EVIDENCE, and where they disagree the evidence
  // wins. A handful of cookware-object terms convert at or below break-even — `iron cast
  // skillet` at 19% against a 26.9% break-even is PROFITABLE traffic, and negating it to
  // satisfy a tidy rule would cost money. A term is only proposed for negation when it is
  // both cookware-intent AND failing: above break-even, or spending with no orders at all.
  const failing = (r, be) => r.orders === 0 || (r.acos !== null && r.acos > be);
  const keep = rows.filter((r) => !failing(r, breakEvenAcos));
  const failingRows = rows.filter((r) => failing(r, breakEvenAcos));

  const negate = failingRows.filter((r) => r.negateCampaigns.length);
  const bidDown = failingRows.filter((r) => !r.negateCampaigns.length && r.bidDownCampaigns.length);

  const tot = (xs) => xs.reduce((a, r) => ({
    cost: a.cost + r.cost, sales: a.sales + r.sales,
    orders: a.orders + r.orders, clicks: a.clicks + r.clicks,
  }), { cost: 0, sales: 0, orders: 0, clicks: 0 });

  return { rows, keep, negate, bidDown, totals: tot(rows), keepTotals: tot(keep),
    negateTotals: tot(negate), bidDownTotals: tot(bidDown) };
}

/**
 * What the cluster actually costs, stated as contribution rather than as spend.
 *
 * Break-even ACoS IS the contribution margin as a percent of revenue, so a cluster's
 * contribution before ads is `sales × breakEvenAcos`, and what it really cost is that
 * minus the ad spend. Quoting the spend alone would overstate the saving, because some
 * of those sales are real and carry real margin.
 */
export function clusterContribution({ cost, sales }, breakEvenAcos) {
  const contribution = sales * breakEvenAcos;
  return { contribution, net: contribution - cost };
}

function main() {
  const asJson = process.argv.includes('--json');
  const audit = JSON.parse(readFileSync(AUDIT, 'utf8'));
  const ppc = JSON.parse(readFileSync(PPC, 'utf8'));

  // Spend-weighted break-even across the priced ASINs — the blended margin the cluster
  // would have earned, rather than any single product's.
  const be = ppc.breakEven;
  const weightedBe = be.reduce((a, r) => a + r.breakEvenAcos * r.adSpend, 0)
    / be.reduce((a, r) => a + r.adSpend, 0);

  const p = buildProposal(audit.searchTerms, { breakEvenAcos: weightedBe });
  const windowDays = 60;
  const perMonth = 30 / windowDays;

  const { contribution, net } = clusterContribution(p.negateTotals, weightedBe);

  const report = {
    generated_at: new Date().toISOString(),
    read_only: true,
    applied: false,
    window: { start: audit.window.searchTermStartDate, end: audit.window.endDate, days: windowDays },
    attribution: '30-day (conservative for this decision — see file header)',
    blended_break_even_acos: weightedBe,
    totals: {
      ...p.totals,
      acos: p.totals.sales > 0 ? p.totals.cost / p.totals.sales : null,
      contribution_before_ads: contribution,
      net_contribution: net,
      net_per_month: net * perMonth,
    },
    keep: p.keep.map((r) => ({
      term: r.term, clicks: r.clicks, spend: r.cost, orders: r.orders, sales: r.sales,
      acos: r.acos, reason: 'cookware intent but at or below break-even — profitable, do not negate',
    })),
    negate: p.negate.map((r) => ({
      term: r.term, clicks: r.clicks, spend: r.cost, orders: r.orders, sales: r.sales,
      acos: r.acos, campaigns: r.negateCampaigns.length, match: 'negative exact',
    })),
    bidDown: p.bidDown.map((r) => ({
      term: r.term, clicks: r.clicks, spend: r.cost, orders: r.orders, sales: r.sales,
      acos: r.acos, campaigns: r.bidDownCampaigns.length, action: 'lower bid, do not negate',
    })),
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'negation-proposal.json'), JSON.stringify(report, null, 2));

  console.log('='.repeat(104));
  console.log('PROPOSED CHANGE LIST — COOKWARE-INTENT SEARCH TERMS — NOTHING APPLIED');
  console.log(`window ${report.window.start} → ${report.window.end} (${windowDays}d, 30-day attribution)`);
  console.log(`blended break-even ACoS across priced ASINs: ${(weightedBe * 100).toFixed(1)}%`);
  console.log('='.repeat(104));

  console.log(`\nCLUSTER TOTAL  ${p.rows.length} terms · ${money(p.totals.cost)} spend · ${money(p.totals.sales)} sales` +
    ` · ${p.totals.orders} orders · ACoS ${pctOf(p.totals.cost, p.totals.sales)}`);
  console.log(`  contribution before ads ${money(contribution)} − ad spend ${money(p.totals.cost)} = ${money(net)} over ${windowDays}d`);
  console.log(`  ≈ ${money(net * perMonth)}/month\n`);

  console.log(`--- A. NEGATE as negative exact (auto/broad/phrase) — ${p.negate.length} terms, ${money(p.negateTotals.cost)} ---`);
  console.log('    spend  clicks  ord    ACoS  campaigns  term');
  for (const r of p.negate.slice(0, 40)) {
    console.log(`  ${money(r.cost).padStart(8)}  ${String(r.clicks).padStart(5)}  ${String(r.orders).padStart(3)}  ` +
      `${(r.acos === null ? '  —  ' : pctOf(r.cost, r.sales)).padStart(6)}  ${String(r.negateCampaigns.length).padStart(8)}   ${r.term}`);
  }

  console.log(`\n--- B. BID DOWN, do NOT negate (manual exact / product target) — ${p.bidDown.length} terms, ${money(p.bidDownTotals.cost)} ---`);
  console.log('  In a one-to-one campaign the target IS the term; negating discards a target that was chosen.');
  for (const r of p.bidDown.slice(0, 20)) {
    console.log(`  ${money(r.cost).padStart(8)}  ${String(r.clicks).padStart(5)}  ${String(r.orders).padStart(3)}  ` +
      `${(r.acos === null ? '  —  ' : pctOf(r.cost, r.sales)).padStart(6)}  ${String(r.bidDownCampaigns.length).padStart(8)}   ${r.term}`);
  }

  console.log(`\n✓ ${join(OUT_DIR, 'negation-proposal.json')}`);
  console.log('  NOT APPLIED. Review, then hand to the agency.');
}

if (isDirectRun(import.meta.url)) main();
