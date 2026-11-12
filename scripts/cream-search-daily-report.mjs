#!/usr/bin/env node
/**
 * Cream Search test — daily report (Sean, 2026-11-11: "Report on this campaign
 * every day").
 *
 * Campaign 24439008645 "RSC | Search Test | Cream Pre-sell" sends cream searches
 * to /pages/coconut-body-cream?v=<key>. The test is read at 150 clicks; this
 * emails one report a day so the read never waits on somebody remembering to
 * look. It REPORTS ONLY — no bid, budget or status write anywhere in this file.
 *
 * Each report: yesterday (PT), the whole test since START, progress toward the
 * 150-click read, per-keyword bid / Quality Score / Google's top-of-page estimate
 * (what bids are tuned against), top search terms, and Shopify orders whose
 * landing URL carries utm_campaign=gsearch-cream-presell. Orders come from
 * Shopify, never from Google's conversion column.
 *
 * Goes quiet on its own: once the campaign is not ENABLED and spent nothing
 * yesterday, it sends nothing (prints a line for the cron log).
 *
 * Usage:
 *   node scripts/cream-search-daily-report.mjs           # print only
 *   node scripts/cream-search-daily-report.mjs --send    # also email (cron does this)
 *
 * Cron: DAILY_CREAM_SEARCH_REPORT, 14:15 UTC (scripts/setup-cron.sh).
 */

import { isDirectRun } from '../lib/is-direct-run.js';

export const CAMPAIGN_ID = '24439008645';
export const START = '2026-11-08';
export const TARGET_CLICKS = 150;
export const LANDING_TAG = 'gsearch-cream-presell';
/** Break-even: one ~$56 average order per $56 of spend. */
export const BREAK_EVEN_SPEND_PER_ORDER = 56;

const usd = (micros) => `$${(Number(micros || 0) / 1e6).toFixed(2)}`;
const pct = (x) => (x == null ? '?' : `${Math.round(Number(x) * 100)}%`);
const num = (x) => Number(x || 0);

/** PT calendar date for `date` offset by `days`. */
export function ptDate(date = new Date(), days = 0) {
  const d = new Date(date.getTime() + days * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** Orders whose landing URL carries the campaign tag, created on or after `fromDate` (PT). */
export function taggedOrders(orders, { fromDate, toDate } = {}) {
  return orders.filter((o) => {
    if (!String(o.landing_site || '').includes(LANDING_TAG)) return false;
    const day = ptDate(new Date(o.created_at));
    if (fromDate && day < fromDate) return false;
    if (toDate && day > toDate) return false;
    return true;
  });
}

/** Should today's run send anything? */
export function shouldReport({ status, yesterdayCostMicros }) {
  return status === 'ENABLED' || num(yesterdayCostMicros) > 0;
}

/**
 * Pure: turn the fetched rows into { subject, body }.
 * `total` / `yesterday` are campaign metric objects; `keywords` rows carry
 * adGroup, adGroupCriterion and metrics (whole test); `terms` are search-term rows.
 */
export function buildReport({ today, yesterdayDate, status, budgetMicros, total, yesterday, keywords, terms, ordersAll, ordersYesterday }) {
  const t = total || {};
  const y = yesterday || {};
  const clicks = num(t.clicks);
  const spend = num(t.costMicros) / 1e6;
  const revenue = ordersAll.reduce((s, o) => s + Number(o.total_price || 0), 0);
  const left = Math.max(0, TARGET_CLICKS - clicks);
  const yClicks = num(y.clicks);
  const eta = left === 0 ? 'READ IS DUE' : yClicks > 0 ? `~${Math.ceil(left / yClicks)} more day(s) at yesterday's pace` : 'no clicks yesterday, no pace yet';

  const lines = [
    `Campaign ${status}, budget ${usd(budgetMicros)}/day. Test started ${START}.`,
    '',
    `YESTERDAY (${yesterdayDate} PT): ${num(y.impressions)} impressions, ${yClicks} clicks, spend ${usd(y.costMicros)}, avg CPC ${usd(y.averageCpc)}, ${ordersYesterday.length} order(s).`,
    `  Impression share ${pct(y.searchImpressionShare)}; lost to rank ${pct(y.searchRankLostImpressionShare)}, to budget ${pct(y.searchBudgetLostImpressionShare)}.`,
    '',
    `WHOLE TEST (${START} to ${today}): ${num(t.impressions)} impressions, ${clicks} clicks, CTR ${num(t.impressions) ? ((clicks / num(t.impressions)) * 100).toFixed(1) : '0.0'}%, spend $${spend.toFixed(2)}, avg CPC ${usd(t.averageCpc)}.`,
    `  Orders from the campaign link: ${ordersAll.length} ($${revenue.toFixed(2)})${spend ? `, ROAS ${(revenue / spend).toFixed(2)}x` : ''}. Break-even is about 1 order per $${BREAK_EVEN_SPEND_PER_ORDER} spent ($${(ordersAll.length * BREAK_EVEN_SPEND_PER_ORDER).toFixed(0)} of spend covered so far).`,
    `  Progress to the ${TARGET_CLICKS}-click read: ${clicks}/${TARGET_CLICKS} (${left} to go; ${eta}).`,
    '',
    'KEYWORDS (whole test; bid vs Google top-of-page estimate):',
  ];
  const kw = [...keywords].sort((a, b) => num(b.metrics?.clicks) - num(a.metrics?.clicks) || num(b.metrics?.impressions) - num(a.metrics?.impressions));
  for (const k of kw) {
    const c = k.adGroupCriterion || {};
    const m = k.metrics || {};
    const qs = c.qualityInfo?.qualityScore;
    const top = c.positionEstimates?.topOfPageCpcMicros;
    lines.push(`  ${c.keyword?.text}: bid ${usd(c.effectiveCpcBidMicros)} (top ${top ? usd(top) : '?'}), QS ${qs || '-'}, ${num(m.impressions)} impr, ${num(m.clicks)} clicks, ${usd(m.costMicros)}`);
  }
  if (ordersAll.length) {
    lines.push('', 'ORDERS:');
    for (const o of ordersAll) lines.push(`  ${o.name} ${ptDate(new Date(o.created_at))} $${o.total_price} landed ${String(o.landing_site || '').slice(0, 80)}`);
  }
  if (terms.length) {
    lines.push('', 'TOP SEARCH TERMS (whole test):');
    for (const s of terms) lines.push(`  ${s.searchTermView?.searchTerm}: ${num(s.metrics?.impressions)} impr, ${num(s.metrics?.clicks)} clicks, ${usd(s.metrics?.costMicros)}`);
  }

  const subject = `Cream Search ${yesterdayDate}: ${yClicks} click(s), ${usd(y.costMicros)}, ${ordersYesterday.length} order(s) · test ${clicks}/${TARGET_CLICKS} clicks, $${spend.toFixed(2)}, ${ordersAll.length} order(s)`;
  return { subject, body: lines.join('\n') };
}

async function main() {
  const send = process.argv.includes('--send');
  const { gaqlQuery } = await import('../lib/google-ads.js');
  const { notify } = await import('../lib/notify.js');
  const today = ptDate();
  const yesterdayDate = ptDate(new Date(), -1);
  try {
    const whole = `segments.date BETWEEN '${START}' AND '${today}'`;
    const yday = `segments.date = '${yesterdayDate}'`;
    const campFields = 'campaign.status, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.average_cpc, metrics.search_impression_share, metrics.search_rank_lost_impression_share, metrics.search_budget_lost_impression_share';
    const [totRow] = await gaqlQuery(`SELECT ${campFields} FROM campaign WHERE campaign.id = ${CAMPAIGN_ID} AND ${whole}`);
    const [yRow] = await gaqlQuery(`SELECT ${campFields} FROM campaign WHERE campaign.id = ${CAMPAIGN_ID} AND ${yday}`);
    const [meta] = await gaqlQuery(`SELECT campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${CAMPAIGN_ID}`);
    const status = meta?.campaign?.status || 'UNKNOWN';
    if (!shouldReport({ status, yesterdayCostMicros: yRow?.metrics?.costMicros })) {
      console.log(new Date().toISOString(), `campaign ${status} with no spend yesterday; nothing sent`);
      return;
    }
    const keywords = await gaqlQuery(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.quality_info.quality_score, ad_group_criterion.position_estimates.top_of_page_cpc_micros, metrics.impressions, metrics.clicks, metrics.cost_micros FROM keyword_view WHERE campaign.id = ${CAMPAIGN_ID} AND ${whole}`);
    const terms = await gaqlQuery(`SELECT campaign.id, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros FROM search_term_view WHERE campaign.id = ${CAMPAIGN_ID} AND ${whole} ORDER BY metrics.clicks DESC, metrics.impressions DESC LIMIT 10`);
    const { getOrders } = await import('../lib/shopify.js');
    const raw = (await getOrders(`${START}T00:00:00-08:00`, new Date().toISOString())).rawOrders;
    const ordersAll = taggedOrders(raw, { fromDate: START });
    const ordersYesterday = taggedOrders(raw, { fromDate: yesterdayDate, toDate: yesterdayDate });
    const { subject, body } = buildReport({
      today, yesterdayDate, status, budgetMicros: meta?.campaignBudget?.amountMicros,
      total: totRow?.metrics, yesterday: yRow?.metrics, keywords, terms, ordersAll, ordersYesterday,
    });
    console.log(`${new Date().toISOString()} ${subject}\n${body}`);
    if (send) await notify({ subject, body, status: 'info', category: 'ads', immediate: true });
  } catch (e) {
    console.error(new Date().toISOString(), 'FAILED:', e.message);
    if (send) await notify({ subject: 'Cream Search daily report FAILED', body: e.message, status: 'error', category: 'ads', immediate: true });
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) await main();
