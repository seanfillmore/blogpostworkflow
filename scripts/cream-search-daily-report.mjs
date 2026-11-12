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
 *   node scripts/cream-search-daily-report.mjs --html-out <file>   # write the email HTML to preview
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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** '2026-11-10' -> 'Tue, Nov 10' (dates here are already PT calendar dates). */
export const niceDate = (d, weekday = true) => {
  const dt = new Date(`${d}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' } : {}) });
};
const money = (micros) => `$${(Number(micros || 0) / 1e6).toFixed(2)}`;

/** One plain-English line on what limited the campaign yesterday. */
export function verdict({ total, yesterday }) {
  const clicks = num(total?.clicks);
  if (clicks >= TARGET_CLICKS) return `The ${TARGET_CLICKS}-click read is due. Time to decide.`;
  const y = yesterday || {};
  const rank = num(y.searchRankLostImpressionShare);
  const budget = num(y.searchBudgetLostImpressionShare);
  if (num(y.impressions) === 0) return 'No impressions yesterday. Bids are not winning any auctions.';
  if (budget >= 0.2 && budget > rank) return `Budget-limited: missed ${pct(budget)} of searches because the daily budget ran out.`;
  if (rank >= 0.5) return `Bid-limited: lost ${pct(rank)} of searches on ad rank (bid x Quality Score). Budget is not the constraint.`;
  return `Showing on ${pct(y.searchImpressionShare)} of eligible searches.`;
}

/**
 * Pure: phone-first HTML email. Inline styles only (Gmail strips <style>),
 * one ~560px column, tables for layout because mail clients still need them.
 */
export function buildHtml({ today, yesterdayDate, status, budgetMicros, total, yesterday, keywords, terms, ordersAll, ordersYesterday }) {
  const t = total || {};
  const y = yesterday || {};
  const clicks = num(t.clicks);
  const spend = num(t.costMicros) / 1e6;
  const revenue = ordersAll.reduce((s, o) => s + Number(o.total_price || 0), 0);
  const left = Math.max(0, TARGET_CLICKS - clicks);
  const yClicks = num(y.clicks);
  const progress = Math.min(100, Math.round((clicks / TARGET_CLICKS) * 100));
  const pace = left === 0 ? 'Read is due' : yClicks > 0 ? `~${Math.ceil(left / yClicks)} days at yesterday's pace` : 'No pace yet (0 clicks yesterday)';
  const ctr = num(t.impressions) ? `${((clicks / num(t.impressions)) * 100).toFixed(1)}%` : '0%';

  const C = { ink: '#1f2328', muted: '#656d76', line: '#d8dee4', soft: '#f6f8fa', accent: '#1a7f37', warn: '#9a6700', bar: '#2da44e' };
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const tile = (label, value, sub = '') => `
    <td width="50%" style="padding:6px;vertical-align:top;">
      <div style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:12px 14px;">
        <div style="font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;">${label}</div>
        <div style="font-size:26px;font-weight:700;color:${C.ink};line-height:1.2;margin-top:2px;">${value}</div>
        ${sub ? `<div style="font-size:13px;color:${C.muted};margin-top:2px;">${sub}</div>` : ''}
      </div>
    </td>`;
  const h2 = (s) => `<div style="font-size:15px;font-weight:700;color:${C.ink};margin:22px 0 8px;">${s}</div>`;

  const kws = [...keywords].sort((a, b) => num(b.metrics?.clicks) - num(a.metrics?.clicks) || num(b.metrics?.impressions) - num(a.metrics?.impressions));
  const shown = kws.filter((k) => num(k.metrics?.impressions) > 0);
  const silent = kws.filter((k) => num(k.metrics?.impressions) === 0).map((k) => esc(k.adGroupCriterion?.keyword?.text));
  const th = (s, align = 'left') => `<th style="text-align:${align};font-size:12px;font-weight:600;color:${C.muted};padding:6px 4px;border-bottom:1px solid ${C.line};">${s}</th>`;
  const td = (s, align = 'left', extra = '') => `<td style="text-align:${align};font-size:14px;color:${C.ink};padding:8px 4px;border-bottom:1px solid ${C.line};${extra}">${s}</td>`;
  const kwRows = shown.map((k) => {
    const c = k.adGroupCriterion || {};
    const m = k.metrics || {};
    const bid = num(c.effectiveCpcBidMicros);
    const top = num(c.positionEstimates?.topOfPageCpcMicros);
    const under = top && bid < top;
    const qs = c.qualityInfo?.qualityScore;
    return `<tr>
      ${td(`${esc(c.keyword?.text)}${qs ? `<div style="font-size:12px;color:${C.muted};">Quality ${qs}/10</div>` : ''}`)}
      ${td(`${money(bid)}<div style="font-size:12px;color:${under ? C.warn : C.muted};">top ${top ? money(top) : '?'}</div>`, 'right')}
      ${td(String(num(m.impressions)), 'right')}
      ${td(String(num(m.clicks)), 'right', 'font-weight:600;')}
    </tr>`;
  }).join('');

  const clickedTerms = terms.filter((s) => num(s.metrics?.clicks) > 0);
  const otherTerms = terms.filter((s) => num(s.metrics?.clicks) === 0).slice(0, Math.max(0, 6 - clickedTerms.length));
  const termLine = (s) => `<div style="font-size:14px;color:${C.ink};padding:5px 0;border-bottom:1px solid ${C.line};">${esc(s.searchTermView?.searchTerm)} <span style="color:${C.muted};">· ${num(s.metrics?.impressions)} impr · ${num(s.metrics?.clicks)} click${num(s.metrics?.clicks) === 1 ? '' : 's'}</span></div>`;

  const orderLines = ordersAll.map((o) => `<div style="font-size:14px;color:${C.ink};padding:5px 0;border-bottom:1px solid ${C.line};">${esc(o.name)} · ${esc(niceDate(ptDate(new Date(o.created_at)), false))} · <b>$${esc(o.total_price)}</b></div>`).join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;padding:16px;font-family:${font};color:${C.ink};">
  <div style="font-size:13px;color:${C.muted};">Google Search test · cream pre-sell page</div>
  <div style="font-size:22px;font-weight:700;margin:2px 0 4px;">Cream Search · ${esc(niceDate(yesterdayDate))}</div>
  <div style="font-size:13px;color:${C.muted};">Campaign ${esc(status)} · ${money(budgetMicros)}/day · since ${esc(niceDate(START, false))}</div>

  <div style="margin:14px 0 4px;padding:12px 14px;border-left:4px solid ${C.warn};background:#fff8c5;border-radius:6px;font-size:15px;line-height:1.4;">${esc(verdict({ total, yesterday }))}</div>

  ${h2('Yesterday')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px;"><tr>
    ${tile('Clicks', yClicks, `${num(y.impressions)} impressions`)}
    ${tile('Spend', money(y.costMicros), yClicks ? `${money(y.averageCpc)} per click` : 'no clicks')}
  </tr><tr>
    ${tile('Orders', ordersYesterday.length, 'from the campaign link')}
    ${tile('Search share', pct(y.searchImpressionShare), `lost: ${pct(y.searchRankLostImpressionShare)} bids · ${pct(y.searchBudgetLostImpressionShare)} budget`)}
  </tr></table>

  ${h2(`Whole test · ${clicks} of ${TARGET_CLICKS} clicks`)}
  <div style="background:${C.line};border-radius:6px;height:12px;overflow:hidden;"><div style="background:${C.bar};width:${progress}%;height:12px;"></div></div>
  <div style="font-size:13px;color:${C.muted};margin-top:6px;">${left} to go · ${esc(pace)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px -6px 0;"><tr>
    ${tile('Spend', `$${spend.toFixed(2)}`, `${money(t.averageCpc)} per click · CTR ${ctr}`)}
    ${tile('Orders', ordersAll.length, `$${revenue.toFixed(2)} revenue${spend ? ` · ${(revenue / spend).toFixed(2)}x ROAS` : ''}`)}
  </tr></table>
  <div style="font-size:13px;color:${C.muted};margin-top:4px;">Break-even is about 1 order per $${BREAK_EVEN_SPEND_PER_ORDER} spent.</div>
  ${orderLines ? h2('Orders') + orderLines : ''}

  ${h2('Keywords')}
  ${shown.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>${th('Keyword')}${th('Bid', 'right')}${th('Impr', 'right')}${th('Clicks', 'right')}</tr>${kwRows}</table>
  <div style="font-size:12px;color:${C.muted};margin-top:6px;">"top" is Google's estimate to show above the results; <span style="color:${C.warn};">amber</span> means our bid is below it.</div>` : `<div style="font-size:14px;color:${C.muted};">No keyword has shown yet.</div>`}
  ${silent.length ? `<div style="font-size:13px;color:${C.muted};margin-top:8px;"><b>Not shown yet:</b> ${silent.join(', ')}</div>` : ''}

  ${terms.length ? h2('What people searched') + [...clickedTerms, ...otherTerms].map(termLine).join('') : ''}

  <div style="font-size:12px;color:${C.muted};margin-top:24px;">Orders are counted from Shopify (landing link carries utm_campaign=${LANDING_TAG}), not from Google's conversion column. Report only; nothing is changed.</div>
</div></body></html>`;
}

async function main() {
  const send = process.argv.includes('--send');
  const { gaqlQuery } = await import('../lib/google-ads.js');
  const { notify, sendHtmlEmail } = await import('../lib/notify.js');
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
    const data = {
      today, yesterdayDate, status, budgetMicros: meta?.campaignBudget?.amountMicros,
      total: totRow?.metrics, yesterday: yRow?.metrics, keywords, terms, ordersAll, ordersYesterday,
    };
    const { subject, body } = buildReport(data);
    const html = buildHtml(data);
    console.log(`${new Date().toISOString()} ${subject}\n${body}`);
    if (process.argv.includes('--html-out')) {
      const { writeFileSync } = await import('node:fs');
      const out = process.argv[process.argv.indexOf('--html-out') + 1];
      writeFileSync(out, html);
      console.log('HTML written to', out);
    }
    // The email is HTML (phone-readable); the text body above is the cron log.
    if (send) await sendHtmlEmail(subject, html);
  } catch (e) {
    console.error(new Date().toISOString(), 'FAILED:', e.message);
    if (send) await notify({ subject: 'Cream Search daily report FAILED', body: e.message, status: 'error', category: 'ads', immediate: true });
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) await main();
