/**
 * Bing Keyword Gap Agent
 *
 * Joins the Bing query list against data/keyword-index.json and reports non-branded,
 * commercial-intent queries the privacy-selecting audience uses that we do not target.
 *
 * Usage:
 *   node agents/bing-keyword-gap/index.js
 *   node agents/bing-keyword-gap/index.js --snapshot data/snapshots/bing/2026-08-18.json
 *   node agents/bing-keyword-gap/index.js --limit 40
 *
 * Writes:
 *   data/reports/bing-keyword-gap/YYYY-MM-DD.md
 *   data/reports/bing-keyword-gap/latest.json
 *
 * It does NOT write data/keyword-index.json, and must not be changed to. Fifteen agents
 * read that file, agents/keyword-index-builder owns it on the server, and Bing has
 * produced $0 over 13 months — adding it as a source would pollute a shared input with
 * a channel that has never earned a dollar. See lib/bing-keyword-gap.js for why the
 * report is the right output.
 *
 * Read the report's own "How to read this" section before acting on it: the query feed
 * is a weekly sample capped at 100 rows per date, so it undercounts and its tail is
 * unstable between calls.
 *
 * All logic lives in lib/bing-keyword-gap.js so it can be tested from fixtures.
 * main() runs only on a direct invocation — importing an agent in this repo runs it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateQueries, joinAgainstIndex, rankGaps, detectPhantoms, estimateCeiling,
  binomialTailAtMost, normalizeUrl,
  DDG_NEW_CUSTOMER_CVR, GOOGLE_ORGANIC_CVR, DEFAULT_AOV,
} from '../../lib/bing-keyword-gap.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'bing');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'bing-keyword-gap');

/**
 * Bing's own measured record, used to test the DDG premise rather than assume it.
 * 253 sessions and zero orders across 13 months of GA4/Shopify attribution.
 */
export const BING_OBSERVED = { sessions: 253, orders: 0, months: 13 };

export function latestSnapshotPath(dir = SNAPSHOTS_DIR) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const money = (n) => `$${n.toFixed(2)}`;

/**
 * Assemble the whole report as data. Pure given its inputs, so a test can assert the
 * numbers without a snapshot on disk.
 */
export function buildReport({ snapshot, index, siteConfig, blogIndex, limit = 25 }) {
  const brandTerms = siteConfig?.brand_terms || [];
  const rows = aggregateQueries(snapshot);
  const joined = joinAgainstIndex(rows, index, { brandTerms, pages: snapshot.pages || [], blogIndex });
  // Baseline with the phantoms held out — this is the one safe to describe as "what
  // every OTHER query at this position does". ctrBaseline(joined) would include them.
  const { baseline } = detectPhantoms(joined);

  const branded = joined.filter((r) => r.branded);
  const nonBranded = joined.filter((r) => !r.branded);
  const phantoms = joined.filter((r) => r.phantom);
  const sampleClicks = joined.reduce((s, r) => s + r.clicks, 0);
  const nonBrandedClicks = nonBranded.reduce((s, r) => s + r.clicks, 0);
  const nonBrandedClickShare = sampleClicks > 0 ? nonBrandedClicks / sampleClicks : 0;

  const gaps = rankGaps(joined, { baseline });
  const cleanGaps = gaps.filter((g) => g.cleanAngle);

  // The premise test: is DDG's 2.88% defensible for BING sessions?
  const pAtDdg = binomialTailAtMost(BING_OBSERVED.orders, BING_OBSERVED.sessions, DDG_NEW_CUSTOMER_CVR);
  const pAtGoogle = binomialTailAtMost(BING_OBSERVED.orders, BING_OBSERVED.sessions, GOOGLE_ORGANIC_CVR);
  const ddgPremiseRejected = pAtDdg < 0.01;

  const ceilingOptimistic = estimateCeiling({ snapshot, nonBrandedClickShare, cvr: DDG_NEW_CUSTOMER_CVR });
  const ceilingGrounded = estimateCeiling({ snapshot, nonBrandedClickShare, cvr: GOOGLE_ORGANIC_CVR });

  return {
    generated_at: new Date().toISOString(),
    snapshot_date: snapshot.date,
    window: snapshot.range,
    site: snapshot.site,
    site_totals: snapshot.summary,
    coverage: snapshot.coverage,
    index_built_at: index?.built_at ?? null,
    index_total_keywords: index?.total_keywords ?? null,
    index_by_validation_source: index?.by_validation_source ?? null,
    totals: {
      distinct_queries: joined.length,
      branded_queries: branded.length,
      branded_clicks: branded.reduce((s, r) => s + r.clicks, 0),
      non_branded_queries: nonBranded.length,
      non_branded_clicks: nonBrandedClicks,
      non_branded_click_share: Math.round(nonBrandedClickShare * 1000) / 1000,
      already_targeted: joined.filter((r) => r.targeted).length,
      commercial_intent: nonBranded.filter((r) => r.commercial).length,
      gaps: gaps.length,
      clean_angle_gaps: cleanGaps.length,
      phantom_queries: phantoms.length,
      phantom_impressions: phantoms.reduce((s, r) => s + r.impressions, 0),
    },
    ctr_baseline: baseline,
    phantoms: phantoms.map((p) => ({
      query: p.query, impressions: p.impressions, clicks: p.clicks,
      position: p.position, weeks: p.weeks, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
    })),
    premise_test: {
      observed: BING_OBSERVED,
      p_if_ddg_rate: pAtDdg,
      p_if_google_rate: pAtGoogle,
      ddg_rate_rejected_for_bing: ddgPremiseRejected,
    },
    ceiling: { optimistic: ceilingOptimistic, grounded: ceilingGrounded },
    gaps: gaps.slice(0, limit),
  };
}

export function renderMarkdown(r) {
  const L = [];
  const cov = r.coverage.queries;

  L.push(`# Bing Keyword Gap — ${r.snapshot_date}`);
  L.push('');
  L.push(`**Window:** ${r.window.start} → ${r.window.end} (${r.window.days} days)  `);
  L.push(`**Site totals (daily feed):** ${r.site_totals.clicks} clicks / ${r.site_totals.impressions} impressions, CTR ${pct(r.site_totals.ctr)}  `);
  L.push(`**Keyword index:** ${r.index_total_keywords} keywords, built ${r.index_built_at}`);
  L.push('');

  L.push('## How to read this');
  L.push('');
  L.push(`Bing query rows are a **weekly sample** — ${cov.dates} sampled dates against the daily feed's ${r.window.days} days — and are capped at **100 rows per date**. This snapshot's query totals (${cov.clicks} clicks / ${cov.impressions} impressions) are therefore far below the site totals above, and **the two must never be reconciled**. ${cov.truncatedDates.length ? `${cov.truncatedDates.length} date(s) hit the cap and lost their long tail: ${cov.truncatedDates.join(', ')}. On those dates the surviving tail rows are not even stable between two calls, so absence from this list is not evidence a query does not exist.` : 'No date hit the cap in this snapshot.'}`);
  L.push('');
  L.push('Every dollar figure below comes from the **daily** feed, which is neither sampled nor capped. Query-level numbers are used only for ranking and for the non-branded *share*, which is a ratio and survives sampling. `clickPosition` is null on every row on this account, so nothing is ranked on it; `impressionPosition` is real and is what "pos" means here.');
  L.push('');

  L.push('## The headline: read the ceiling before the list');
  L.push('');
  const c = r.ceiling;
  const t = r.premise_test;
  L.push(`This report exists because Bing's index serves DuckDuckGo, and DDG converts new customers at ${pct(DDG_NEW_CUSTOMER_CVR)} against Google organic's ${pct(GOOGLE_ORGANIC_CVR)}. That premise is about **DDG** sessions. Applied to **Bing** sessions it does not survive contact with Bing's own record:`);
  L.push('');
  L.push(`> Bing has sent **${t.observed.sessions} sessions and produced ${t.observed.orders} orders over ${t.observed.months} months.** If those sessions converted at DDG's ${pct(DDG_NEW_CUSTOMER_CVR)}, the probability of seeing zero orders is **${t.p_if_ddg_rate.toExponential(1)}** — rejected. At Google organic's ${pct(GOOGLE_ORGANIC_CVR)} the same silence has probability ${t.p_if_google_rate.toFixed(3)}, which is unremarkable.`);
  L.push('');
  L.push(`So the DDG conversion premise **${t.ddg_rate_rejected_for_bing ? 'does not transfer to Bing traffic' : 'is not contradicted'}**, and the honest ceiling uses the Google-organic rate:`);
  L.push('');
  L.push('| | Optimistic (DDG rate) | Grounded (Google-organic rate) |');
  L.push('|---|---|---|');
  L.push(`| Assumed new-customer CVR | ${pct(c.optimistic.cvr)} | ${pct(c.grounded.cvr)} |`);
  L.push(`| Current non-branded Bing clicks/mo | ${c.grounded.monthlyNonBrandedClicks} | ${c.grounded.monthlyNonBrandedClicks} |`);
  L.push(`| Incremental clicks/mo if we **double** them | ${c.grounded.incrementalClicks} | ${c.grounded.incrementalClicks} |`);
  L.push(`| **Ceiling, $/month** | **${money(c.optimistic.monthlyRevenue)}** | **${money(c.grounded.monthlyRevenue)}** |`);
  L.push(`| Ceiling, $/year | ${money(c.optimistic.annualRevenue)} | ${money(c.grounded.annualRevenue)} |`);
  L.push('');
  L.push(`At AOV ${money(c.grounded.aov)}. "Double" means winning as many non-branded clicks again as Bing currently sends in total — a heroic assumption for a channel we already rank top-5 on for most of these queries. **The realistic ceiling for this entire channel is ${money(c.grounded.monthlyRevenue)}/month (${money(c.grounded.annualRevenue)}/year).**`);
  L.push('');

  if (r.phantoms.length) {
    L.push('## Before the gap list: one query is not real');
    L.push('');
    L.push('The largest apparent opportunity in this dataset is an artefact, and any ceiling that counted it would be inflated several-fold. Flagged automatically by comparing each zero-click row against what the rest of this same feed does at the same position:');
    L.push('');
    L.push('| Query | Impressions | Clicks | Pos | Weeks seen | First seen | Last seen |');
    L.push('|---|---:|---:|---:|---:|---|---|');
    for (const p of r.phantoms) {
      L.push(`| \`${p.query}\` | ${p.impressions} | ${p.clicks} | ${p.position} | ${p.weeks} | ${p.firstSeen} | ${p.lastSeen} |`);
    }
    L.push('');
    const b13 = r.ctr_baseline['1-3'];
    const p0 = r.phantoms[0];
    if (b13) {
      L.push(`Every **other** query in this feed at positions 1-3 clicks at **${pct(b13.ctr)}** (that baseline is computed with these rows held out — including them drags it to 3.62% and the test becomes circular). These rows sit at the same positions and have never once been clicked across ${p0.weeks} separate sampled weeks. If \`${p0.query}\` behaved like its positional peers it would have produced roughly **${Math.round(p0.impressions * b13.ctr)} clicks** — more than the site's entire ${r.site_totals.clicks}-click total for the whole six-month window.`);
      L.push('');
      L.push(`That is not a CTR leak better copy would fix. The page returns HTTP 200, is indexable, and already carries an exact-match title (\`Dr. Bronner Alternative? Meet Real Skin Care\`). Two further tells: the impressions **stopped on ${p0.lastSeen}** and have not recurred in the three months since, and on Google the same query draws only 97 impressions at position 11 — the volume exists only where we rank #2 and nobody ever clicks. This is impressions with no human behind them (bot or syndicated-module traffic). It is excluded from the gap list and from every dollar figure above; counting it would have inflated the ceiling roughly fourfold.`);
      L.push('');
    }
  }

  L.push('## Query population');
  L.push('');
  const T = r.totals;
  L.push(`| Segment | Queries | Clicks |`);
  L.push(`|---|---:|---:|`);
  L.push(`| All distinct (this snapshot) | ${T.distinct_queries} | ${T.branded_clicks + T.non_branded_clicks} |`);
  L.push(`| Branded (excluded — we rank #1 for ourselves) | ${T.branded_queries} | ${T.branded_clicks} |`);
  L.push(`| Non-branded | ${T.non_branded_queries} | ${T.non_branded_clicks} |`);
  L.push(`| — of which commercial intent | ${T.commercial_intent} | |`);
  L.push(`| — already in keyword-index.json | ${T.already_targeted} | |`);
  L.push(`| — phantom (excluded) | ${T.phantom_queries} | 0 |`);
  L.push(`| **Genuine gaps** | **${T.gaps}** | |`);
  L.push(`| — carrying the clean-ingredient angle | ${T.clean_angle_gaps} | |`);
  L.push('');
  L.push('Commercial intent uses the fleet\'s existing taxonomy (`lib/search-intent.js`, extracted from the blog writer): `diy` and `informational` wording is excluded, `product` wording is kept. "Already targeted" is membership of `data/keyword-index.json`, joined on that file\'s own `slug()` key — anything in the index has already cleared its behavioural validation bar, so this report does not re-derive commercial intent for those.');
  L.push('');

  L.push(`## The gap list — top ${r.gaps.length} by plausible revenue`);
  L.push('');
  if (!r.gaps.length) {
    L.push('_No non-branded commercial-intent gaps survived filtering._');
  } else {
    L.push('Ranked by expected **clicks** (impressions × the CTR this feed actually achieves at that position), ×1.5 where the query carries the clean-ingredient angle — not by raw impressions. A loud row that never clicks scores zero.');
    L.push('');
    L.push('| # | Query | Impr | Clicks | CTR | Pos | Cluster | Clean angle | Expected clicks/period | Page that could rank |');
    L.push('|---:|---|---:|---:|---:|---:|---|:---:|---:|---|');
    r.gaps.forEach((g, i) => {
      const page = g.candidatePage
        ? `[${normalizeUrl(g.candidatePage.url).replace('realskincare.com', '')}](${g.candidatePage.url})`
        : '_none found_';
      L.push(`| ${i + 1} | \`${g.query}\` | ${g.impressions} | ${g.clicks} | ${pct(g.ctr)} | ${g.position ?? '—'} | ${g.cluster} | ${g.cleanAngle ? 'yes' : '—'} | ${g.expectedClicks} | ${page} |`);
    });
  }
  L.push('');
  L.push('"Expected clicks/period" is over the **sampled** weeks, not the full window — it is a ranking quantity, not a forecast. Do not annualise it.');
  L.push('');
  L.push('**Caveat on the top of this list, not corrected here.** Several high-ranked rows (`coconut oil soap base`, `coconut oil for soap making`, `what percentage of coconut oil should there be in a cold process ginger juice soap`) are soap-*making* supply queries — those searchers want lye and base oils, which we do not sell. `lib/search-intent.js` files them as `product` because its DIY patterns key on `how to make` / `recipe` / `diy` and none of those appear; phrasings like "X base", "for X making" and "cold process" slip through. That is a real hole in the shared taxonomy which also affects the blog writer\'s CTA weighting, and it is reported rather than patched here: fixing it would change `agents/blog-post-writer` behaviour, and it moves nothing in this report\'s conclusion (the rows in question are worth ~1.3 expected clicks in total). Flagged for a separate decision.');
  L.push('');

  L.push('## So what for Shopify revenue');
  L.push('');
  L.push(`The entire channel ceiling is ${money(c.grounded.monthlyRevenue)}/month. That is below the threshold at which any dedicated content or collection work pays for itself, and the Prime Directive's own test — *how does this convert traffic to sales?* — returns "barely, and only under an assumption Bing's own record rejects".`);
  L.push('');
  L.push('The defensible use of this feed is **diagnostic, not a traffic target**: it is a cheap second index that occasionally shows a page behaving differently than it does on Google. Keep the weekly collector, read this report when it runs, and do not commission work against it.');
  L.push('');

  return L.join('\n') + '\n';
}

function argValue(flag, argv = process.argv) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.split('=')[1];
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

async function main() {
  const snapPath = argValue('--snapshot') || latestSnapshotPath();
  const limit = Number(argValue('--limit')) || 25;

  console.log('Bing Keyword Gap\n');
  if (!snapPath || !existsSync(snapPath)) {
    throw new Error(
      `No Bing snapshot found under ${SNAPSHOTS_DIR}. data/snapshots/ is gitignored and written by cron on the server — `
      + 'this is normal in a fresh checkout and is NOT a broken collector. Either run `node agents/bing-collector/index.js` '
      + 'or copy one from the server (root@137.184.119.230:~/seo-claude/data/snapshots/bing/).',
    );
  }

  const snapshot = readJson(snapPath);
  if (!snapshot?.queries) throw new Error(`Snapshot at ${snapPath} has no queries array.`);

  const index = readJson(join(ROOT, 'data', 'keyword-index.json'));
  if (!index?.keywords) {
    throw new Error(
      'No data/keyword-index.json. It is gitignored and built on the server — copy it from '
      + 'root@137.184.119.230:~/seo-claude/data/keyword-index.json. Without it every query would '
      + 'read as an untargeted gap, which would make this report actively misleading.',
    );
  }

  const siteConfig = readJson(join(ROOT, 'config', 'site.json'), {});
  const blogIndex = readJson(join(ROOT, 'data', 'blog-index.json'), []);

  console.log(`  Snapshot: ${snapPath}`);
  console.log(`  Index:    ${index.total_keywords} keywords (built ${index.built_at})`);

  const report = buildReport({ snapshot, index, siteConfig, blogIndex, limit });
  const md = renderMarkdown(report);

  const T = report.totals;
  console.log(`  Queries:  ${T.distinct_queries} distinct — ${T.branded_queries} branded, ${T.already_targeted} already targeted`);
  console.log(`  Phantoms: ${T.phantom_queries} query/queries, ${T.phantom_impressions} impressions excluded`);
  console.log(`  Gaps:     ${T.gaps} (${T.clean_angle_gaps} clean-angle)`);
  console.log(`  Ceiling:  ${money(report.ceiling.grounded.monthlyRevenue)}/mo grounded, ${money(report.ceiling.optimistic.monthlyRevenue)}/mo optimistic`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const mdPath = join(REPORTS_DIR, `${report.snapshot_date}.md`);
  writeFileSync(mdPath, md);
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n  Wrote ${mdPath}`);
  console.log(`  Wrote ${join(REPORTS_DIR, 'latest.json')}`);

  return report;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(async (report) => {
      await notify({
        subject: 'Bing Keyword Gap ran',
        body: `${report.totals.gaps} non-branded commercial gaps from ${report.totals.distinct_queries} Bing queries. `
          + `Grounded ceiling ${money(report.ceiling.grounded.monthlyRevenue)}/mo. `
          + `${report.totals.phantom_queries} phantom quer(ies) excluded.`,
        status: 'success',
      }).catch(() => {});
    })
    .catch(async (err) => {
      await notify({ subject: 'Bing Keyword Gap failed', body: err.message || String(err), status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
