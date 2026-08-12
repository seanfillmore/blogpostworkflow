/**
 * Shopping Test Monitor
 *
 * Watches the paid-acquisition Shopping test campaigns (flight plan) and reports
 * the numbers Sean actually steers on: spend, clicks, CTR, CPC, conversions,
 * revenue, ROAS, CPA, CVR — per campaign and combined, over a trailing window
 * plus lifetime.
 *
 * Gate (Sean 2026-07-21, supersedes the plan's 2×): ~1× ROAS is a WIN. This
 * monitor does NOT auto-pause and does NOT fail a campaign for missing 2×. It
 * flags only genuinely DEAD spend — meaningful clicks with ~0 conversions, or
 * deeply unprofitable spend after a real conversion base — so Sean can evolve the
 * campaign manually. Everything else is reported as informational.
 *
 * Targets every campaign whose name starts with "RSC | " that is currently ENABLED or
 * spent money in the window (see selectCampaigns). Widened from "RSC | Shopping Test"
 * on 2026-08-12 — "RSC | Brand | Search" was unpaused and was invisible to this report,
 * which was the campaign being watched most closely.
 *
 * Usage:
 *   node agents/shopping-test-monitor/index.js            # 14-day window
 *   node agents/shopping-test-monitor/index.js --days 7
 *   node agents/shopping-test-monitor/index.js --json     # print JSON, no notify
 *
 * Cron (server): daily, e.g.
 *   30 15 * * * cd ~/seo-claude && node agents/shopping-test-monitor/index.js >> data/logs/shopping-test-monitor.log 2>&1
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gaqlQuery } from '../../lib/google-ads.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'shopping-test-monitor');

// Every RSC-managed campaign, not just the Shopping tests. Widened 2026-08-12: when
// 'RSC | Brand | Search' was unpaused it was invisible to this report, which is the
// campaign we had just been asked to watch most closely.
const NAME_PREFIX = 'RSC | ';

// Label stripping in the report still wants the old, longer prefix where it applies.
const SHOPPING_TEST_PREFIX = 'RSC | Shopping Test';

// Gate thresholds — deliberately permissive per the "~1× is a win" directive.
export const DEFAULTS = {
  // Statistical floor before a zero-conversion result means anything. The store's
  // true CVR is ~0.82%, so 40 clicks expects 0.33 conversions — seeing zero there
  // is the overwhelmingly likely outcome even for a perfectly healthy campaign,
  // and flagging it was a false positive. 150 clicks expects ~1.2-1.5, which is
  // the earliest point a zero is worth surfacing at all.
  deadClicks: 150,       // clicks in-window with 0 conversions ⇒ likely dead spend
  deepUnprofitRoas: 0.5, // ROAS below this, AFTER a conversion base, is a real problem
  minConvForRoasJudgement: 15,
  watchRoas: 1.0,        // ≥ this = healthy under the 1× gate
};

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * Which campaigns belong in the report.
 *
 * Matching every 'RSC | ' campaign would drag in a dozen long-dead paused ones and
 * bury the two or three that matter. Keep a campaign if it is currently ENABLED, or
 * if it spent money in the window — spend after a pause is still real money and must
 * stay visible until it stops.
 */
export function selectCampaigns(rows) {
  return rows.filter((r) => r.status === 'ENABLED' || Number(r.spend) > 0);
}

export function computeMetrics(row) {
  const m = row.metrics || {};
  const impressions = Number(m.impressions || 0);
  const clicks = Number(m.clicks || 0);
  const spend = Number(m.costMicros || 0) / 1_000_000;
  const conversions = Number(m.conversions || 0);
  const revenue = Number(m.conversionsValue || 0);
  return {
    id: row.campaign?.id,
    name: row.campaign?.name,
    status: row.campaign?.status,
    impressions,
    clicks,
    spend: round2(spend),
    ctr: impressions > 0 ? round4(clicks / impressions) : 0,
    avgCpc: clicks > 0 ? round2(spend / clicks) : 0,
    conversions: round2(conversions),
    revenue: round2(revenue),
    roas: spend > 0 ? round2(revenue / spend) : null,
    cpa: conversions > 0 ? round2(spend / conversions) : null,
    cvr: clicks > 0 ? round4(conversions / clicks) : 0,
  };
}

/**
 * Classify a campaign under the revised gate. Returns { verdict, reason } where
 * verdict ∈ 'no_spend' | 'ok' | 'watch' | 'learning' | 'dead_spend' | 'unprofitable'.
 * Only 'dead_spend' and 'unprofitable' are problems worth surfacing.
 *
 * 'learning' means the click volume is too low for a zero-conversion result to
 * carry information. Judge those campaigns on search-term quality and CTR, not
 * on ROAS — the conversion number is noise until deadClicks is reached.
 */
export function classifyCampaign(m, cfg = DEFAULTS) {
  if (m.spend === 0) return { verdict: 'no_spend', reason: 'No spend in window (paused or not yet serving).' };
  if (m.conversions >= cfg.minConvForRoasJudgement && m.roas !== null && m.roas < cfg.deepUnprofitRoas) {
    return { verdict: 'unprofitable', reason: `ROAS ${m.roas}× after ${m.conversions} conv — deeply below breakeven even for an LTV bet.` };
  }
  if (m.clicks >= cfg.deadClicks && m.conversions === 0) {
    return { verdict: 'dead_spend', reason: `${m.clicks} clicks, 0 conversions — spend not producing sales.` };
  }
  if (m.roas !== null && m.roas >= cfg.watchRoas) {
    return { verdict: 'ok', reason: `ROAS ${m.roas}× — at/above the 1× target.` };
  }
  if (m.conversions > 0) {
    return { verdict: 'watch', reason: `${m.conversions} conv, ROAS ${m.roas ?? 'n/a'}× — early, keep gathering data.` };
  }
  return { verdict: 'learning', reason:
    `${m.clicks} clicks, 0 conversions — not yet interpretable (needs ${cfg.deadClicks} clicks for a zero to mean anything). ` +
    `Judge on search-term quality and CTR ${pctStr(m.ctr)}, not ROAS.` };
}

export function summarize(recent, lifetime, cfg = DEFAULTS) {
  const rows = recent.map(m => ({ ...m, ...classifyCampaign(m, cfg) }));
  const totals = aggregate(recent);
  const lifeTotals = aggregate(lifetime);
  const flags = rows.filter(r => r.verdict === 'dead_spend' || r.verdict === 'unprofitable');
  return { rows, totals, lifetime: lifeTotals, flags };
}

function aggregate(list) {
  const spend = list.reduce((s, m) => s + m.spend, 0);
  const clicks = list.reduce((s, m) => s + m.clicks, 0);
  const impressions = list.reduce((s, m) => s + m.impressions, 0);
  const conversions = list.reduce((s, m) => s + m.conversions, 0);
  const revenue = list.reduce((s, m) => s + m.revenue, 0);
  return {
    spend: round2(spend), clicks, impressions, conversions: round2(conversions), revenue: round2(revenue),
    roas: spend > 0 ? round2(revenue / spend) : null,
    ctr: impressions > 0 ? round4(clicks / impressions) : 0,
    avgCpc: clicks > 0 ? round2(spend / clicks) : 0,
  };
}

const pctStr = v => `${((v || 0) * 100).toFixed(2)}%`;

const round2 = n => Math.round(n * 100) / 100;
const round4 = n => Math.round(n * 10000) / 10000;

export function ymdPT(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export function buildMarkdown({ rows, totals, lifetime, flags }, { start, end, days }) {
  const pct = v => v === 0 ? '0%' : `${(v * 100).toFixed(1)}%`;
  const roas = v => v === null ? '—' : `${v}×`;
  const money = v => `$${v.toFixed(2)}`;
  // Every RSC campaign name contains "|" as a separator, which is also the markdown
  // table delimiter — unescaped, "RSC | Brand | Search" renders as three extra columns
  // and collapses the table in the digest email.
  const label = name => String(name || '').replace(SHOPPING_TEST_PREFIX + ' | ', '').replace(/\|/g, '\\|');
  let md = `# Shopping Test Monitor — ${end}\n\n`;
  md += `Window: last ${days} days (${start} → ${end}). Gate: ~1× ROAS is a win; flag only dead spend.\n\n`;
  md += `## Combined (last ${days}d)\n`;
  md += `- Spend ${money(totals.spend)} · Revenue ${money(totals.revenue)} · **ROAS ${roas(totals.roas)}**\n`;
  md += `- ${totals.clicks} clicks · CTR ${pct(totals.ctr)} · CPC ${money(totals.avgCpc)} · ${totals.conversions} conv\n`;
  md += `- Lifetime: spend ${money(lifetime.spend)} · revenue ${money(lifetime.revenue)} · ROAS ${roas(lifetime.roas)} · ${lifetime.conversions} conv\n\n`;
  md += `## Per campaign (last ${days}d)\n\n`;
  md += `| Campaign | Status | Spend | Clicks | CPC | Conv | Revenue | ROAS | Verdict |\n`;
  md += `|---|---|--:|--:|--:|--:|--:|--:|---|\n`;
  for (const r of rows) {
    md += `| ${label(r.name)} | ${r.status} | ${money(r.spend)} | ${r.clicks} | ${money(r.avgCpc)} | ${r.conversions} | ${money(r.revenue)} | ${roas(r.roas)} | ${r.verdict} |\n`;
  }
  md += `\n`;
  if (flags.length) {
    md += `## ⚠️ Needs attention\n`;
    for (const f of flags) md += `- **${label(f.name)}**: ${f.reason}\n`;
  } else {
    md += `_No dead spend flagged — everything either producing sales or still gathering data._\n`;
  }
  return md;
}

// ── main ────────────────────────────────────────────────────────────────────

async function fetchWindow(dateClause) {
  const q = `
    SELECT campaign.id, campaign.name, campaign.status,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE campaign.name LIKE '${NAME_PREFIX}%' AND campaign.status != 'REMOVED'
      ${dateClause}
  `;
  return selectCampaigns((await gaqlQuery(q)).map(computeMetrics));
}

async function main() {
  const argv = process.argv.slice(2);
  const days = Number(argv[argv.indexOf('--days') + 1]) || 14;
  const asJson = argv.includes('--json');

  const end = ymdPT(1);              // yesterday PT (reporting lag)
  const start = ymdPT(days);         // N days back
  const recent = await fetchWindow(`AND segments.date BETWEEN '${start}' AND '${end}'`);
  const lifetime = await fetchWindow('');

  const report = summarize(recent, lifetime);
  const md = buildMarkdown(report, { start, end, days });

  if (asJson) {
    console.log(JSON.stringify({ start, end, days, ...report }, null, 2));
    return;
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({ start, end, days, ...report }, null, 2));
  writeFileSync(join(REPORTS_DIR, `${end}.md`), md);
  console.log(md);

  const hasSpend = report.totals.spend > 0;
  const status = report.flags.length ? 'error' : 'info';
  const subject = report.flags.length
    ? `Shopping test: ${report.flags.length} campaign(s) need attention`
    : hasSpend
      ? `Shopping test: $${report.totals.spend.toFixed(2)} spend → ROAS ${report.totals.roas ?? '—'}× (${report.totals.conversions} conv)`
      : `Shopping test: no spend yet (campaigns paused or not serving)`;
  await notify({ subject, body: md, status, category: 'ads' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
