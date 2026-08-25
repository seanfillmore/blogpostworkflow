/**
 * CTR Program — plans the blog click-through experiment, and refuses to plan one
 * that cannot be measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS AGENT EXISTS RATHER THAN A BIGGER `--limit`
 *
 * Sitewide blog CTR is 0.47% on ~521,000 impressions per 90 days. The obvious
 * response is to run `agents/meta-optimizer` harder. Measured against the data,
 * that is the wrong move on three separate counts:
 *
 *  1. THROUGHPUT IS NOT THE CONSTRAINT. Only 20 non-toothpaste blog pages carry
 *     4,000+ impressions per 90 days, and they hold 73.8% of all non-toothpaste
 *     blog impressions. At the existing `--limit 5` weekly cap that entire
 *     population is covered in FOUR WEEKS. Raising the cap exhausts it in two
 *     and then spends the budget on pages where nothing is measurable.
 *
 *  2. THE CANDIDATE RANKING LOOKS AT THE WRONG THING. meta-optimizer ranks
 *     QUERIES (Amazon-validated first, then query impressions) and rewrites the
 *     PAGE each query lands on. The flagship page earns 37,531 impressions
 *     across 666 distinct queries; its single biggest query is 1,045 of them,
 *     6.1%. Query impressions are therefore a poor proxy for page opportunity,
 *     and two queries can select the same page twice. Ranking by raw PAGE
 *     impressions is not the fix either — toothpaste is 41.4% of blog
 *     impressions for 2.9% of revenue, so that hands most of the budget to the
 *     worst-earning cluster. lib/ctr-opportunity.js ranks pages by recoverable
 *     clicks weighted by what the cluster earns.
 *
 *  3. NOTHING THAT HAS BEEN MEASURED SO FAR IS READABLE. Nine A/B tests have
 *     concluded. Replayed against data/snapshots/gsc/, none is attributable to
 *     the rewrite: every "improved" delta sits inside the noise band, the corpus
 *     tripled its own CTR underneath them, and the one auto-revert fired on a
 *     page whose average position had fallen 13.2 → 27.6. See
 *     lib/meta-ab-decision.js for the guards and lib/ctr-cohort.js for the unit
 *     of measurement that replaces the per-page before/after.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT PRODUCES
 *
 * A WAVE: a treatment cohort of pages to rewrite, and a matched HOLDOUT cohort
 * that must not be touched. Written to data/reports/ctr-program/wave.json, which
 * meta-optimizer reads as its candidate source — and, more importantly, as its
 * do-not-touch list. A holdout page that gets rewritten is not a holdout, and
 * the wave it was controlling becomes unmeasurable.
 *
 * Plus an `individual[]` list: the 3 of 190 pages that carry enough traffic to
 * be judged alone over 28 days. Those take the ORDINARY per-page A/B path and
 * are deliberately kept OUT of the cohort — `toothpaste-without-sls` is 19.7% of
 * the entire blog and would be half a ten-page arm on its own, which makes the
 * cohort a single-page test wearing a cohort's name. See
 * lib/ctr-cohort.js's partitionByPower.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS AGENT NEVER WRITES TO SHOPIFY. It reads GSC, ranks, assigns, and writes
 * two files. Every mutation still happens in meta-optimizer, behind the health
 * gate, the distinctness gate and the A/B tracker.
 *
 * Usage:
 *   node agents/ctr-program/index.js                  # plan + report (default)
 *   node agents/ctr-program/index.js --size 10        # treatment cohort size
 *   node agents/ctr-program/index.js --days 90        # ranking window
 *   node agents/ctr-program/index.js --audit          # A/B history audit only
 *   node agents/ctr-program/index.js --no-write       # print, write nothing
 *
 * Output: data/reports/ctr-program/wave.json, ctr-program-report.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as gsc from '../../lib/gsc.js';
import { notify } from '../../lib/notify.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { assignCluster } from '../../lib/keyword-index/cluster.js';
import { loadClusterHold, partitionHeld } from '../../lib/cluster-hold.js';
import { rankClusters } from '../../lib/cluster-efficiency.js';
import { rankOpportunities } from '../../lib/ctr-opportunity.js';
import { assignCohorts, partitionByPower, DEFAULT_COHORT_SIZE } from '../../lib/ctr-cohort.js';
import { assessPower, DEFAULT_TARGET_RELATIVE_LIFT } from '../../lib/ctr-power.js';
import { concentration, byCluster, reDecideTracker } from './lib/summarise.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ctr-program');
const SNAPSHOT_DIR = join(ROOT, 'data', 'snapshots', 'gsc');
const TRACKER_PATH = join(ROOT, 'data', 'reports', 'meta-ab', 'meta-ab-tracker.json');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const args = process.argv.slice(2);
const getArg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const cohortSize = parseInt(getArg('--size') ?? String(DEFAULT_COHORT_SIZE), 10);
const windowDays = parseInt(getArg('--days') ?? '90', 10);
const auditOnly = args.includes('--audit');
const write = !args.includes('--no-write');

// ── page-level source ────────────────────────────────────────────────────────

/**
 * Aggregate blog pages over the window.
 *
 * SNAPSHOTS FIRST, API SECOND. data/snapshots/gsc/ is written daily by cron on
 * the production box and is free to read; the API costs a quota call and, more
 * to the point, cannot be replayed. The snapshot path is also the only one that
 * can produce the historical windows the audit needs. A local checkout has no
 * snapshots at all (they are gitignored and server-authoritative), which is
 * normal and is why the API fallback exists rather than being an error path.
 */
function aggregateFromSnapshots(days) {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return null;

  const end = files[files.length - 1].slice(0, -5);
  const cutoff = new Date(`${end}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const pages = new Map();
  let used = 0;
  for (const f of files) {
    const date = f.slice(0, -5);
    if (date < cutoffIso) continue;
    let snap;
    try { snap = JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), 'utf8')); } catch { continue; }
    used++;
    for (const r of snap.topPages || []) {
      if (!r?.page || !r.page.includes('/blogs/')) continue;
      const e = pages.get(r.page) || { url: r.page, clicks: 0, impressions: 0, posWeighted: 0 };
      e.clicks += r.clicks || 0;
      e.impressions += r.impressions || 0;
      e.posWeighted += (r.position || 0) * (r.impressions || 0);
      pages.set(r.page, e);
    }
  }
  if (used === 0) return null;
  return { source: `snapshots (${used} days, ${cutoffIso}..${end})`, pages: [...pages.values()], end };
}

async function aggregateFromApi(days) {
  const rows = await gsc.getTopPages(500, days);
  const pages = (rows || [])
    .filter((r) => String(r.page || r.url || '').includes('/blogs/'))
    .map((r) => ({
      url: r.page || r.url,
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      posWeighted: (r.position || 0) * (r.impressions || 0),
    }));
  return { source: `GSC API (trailing ${days}d)`, pages, end: null };
}

function finalise(agg) {
  return agg.pages.map((p) => ({
    url: p.url,
    clicks: p.clicks,
    impressions: p.impressions,
    ctr: p.impressions > 0 ? p.clicks / p.impressions : 0,
    position: p.impressions > 0 ? p.posWeighted / p.impressions : null,
    // Cluster from the SLUG, because that is the only text a page-level row
    // carries. assignCluster is the same ordered matcher the keyword index and
    // demand-miner use, so a page and its queries cannot land in two different
    // clusters over a spelling.
    cluster: assignCluster(String(p.url).split('/').pop().replace(/-/g, ' ')),
  }));
}

// ── concentration, cluster rollup, A/B audit ─────────────────────────────────
// All three are pure and live in ./lib/summarise.js — this index imports
// lib/gsc.js, which reads .env and throws at import time, so nothing testable
// may live here. Same split as agents/meta-optimizer/lib/{sort,hold,gate}.js.

function auditTracker() {
  if (!existsSync(TRACKER_PATH)) return null;
  let tracker;
  try { tracker = JSON.parse(readFileSync(TRACKER_PATH, 'utf8')); } catch { return null; }
  if (!Array.isArray(tracker)) return null;
  return reDecideTracker(tracker);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCTR Program — ${config.name}`);

  const audit = auditTracker();
  if (audit) {
    console.log(`\n  A/B history: ${audit.total} tests, ${audit.concluded} concluded, ${audit.open} open`);
    console.log(`  Re-decided under the current rules: ${audit.downgraded} of ${audit.concluded} change verdict`);
    console.log(`  Verdicts that survive as evidence: ${audit.survivingVerdicts}`);
    for (const r of audit.rows) {
      if (!r.changed) continue;
      console.log(`    · "${r.keyword}" ${r.recordedOutcome} → ${r.reDecided}`
        + (r.mde != null ? ` (needs ${(r.mde * 100).toFixed(2)}pp to read; delta was ${(r.delta * 100).toFixed(2)}pp)` : ''));
    }
  } else {
    console.log('\n  A/B history: no tracker found.');
  }

  if (auditOnly) {
    if (write) writeReport({ audit });
    return;
  }

  // ── rank ──────────────────────────────────────────────────────────────────
  let agg = aggregateFromSnapshots(windowDays);
  if (!agg) {
    console.log('  No usable GSC snapshots (normal in a local checkout) — falling back to the API.');
    agg = await aggregateFromApi(windowDays);
  }
  const pages = finalise(agg);
  console.log(`\n  Source: ${agg.source} — ${pages.length} blog pages`);

  const conc = concentration(pages);
  console.log(`  Blog impressions (${windowDays}d): ${conc.totalImpressions.toLocaleString()} across ${conc.totalPages} pages`);
  for (const r of conc.rows) {
    console.log(`    top ${String(r.topN).padStart(2)}: ${r.impressions.toLocaleString().padStart(8)} imps = ${(r.share * 100).toFixed(1)}%`);
  }

  const clusters = byCluster(pages);
  console.log('\n  By cluster:');
  for (const c of clusters) {
    console.log(`    ${c.cluster.padEnd(14)} ${String(c.pages).padStart(3)} pages  ${c.impressions.toLocaleString().padStart(8)} imps  ${(c.ctr * 100).toFixed(2)}% CTR`);
  }

  // The $0-cluster hold, applied BEFORE ranking — same order and same reason as
  // agents/meta-optimizer/lib/hold.js documents: a held candidate that is
  // filtered after the cap has still eaten an earning cluster's budget.
  const hold = loadClusterHold({ root: ROOT });
  const { kept, held } = partitionHeld(pages, hold, {
    describe: (p) => ({ keyword: p.url, url: p.url, slug: String(p.url).split('/').pop() }),
  });
  if (held.length) console.log(`\n  Cluster hold: ${held.length} page(s) withheld`);

  const ranking = rankClusters(hold);
  const ranked = rankOpportunities(kept, { ranking });

  // Pages that can be judged ALONE are pulled out before the cohort is built.
  // Pooling them is harmful both ways — see partitionByPower's header: on the
  // real corpus `toothpaste-without-sls` is 19.7% of the whole blog and 51% of a
  // ten-page arm, so a cohort containing it is a single-page test wearing a
  // cohort's name, while the page itself clears the power bar comfortably alone.
  const { individual, pooled } = partitionByPower(ranked, { windowDays });
  if (individual.length) {
    console.log(`\n  Individually powered (test alone, NOT pooled): ${individual.length} of ${ranked.length}`);
    for (const p of individual) {
      console.log(`    ${String(p.impressions).padStart(7)} imps ${(p.ctr * 100).toFixed(2)}%`
        + `  reads ${(p.power.mde * 100).toFixed(3)}pp vs ${(p.power.targetAbsoluteLift * 100).toFixed(3)}pp target`
        + `  ${String(p.url).split('/').pop().slice(0, 44)}`);
    }
  }

  const wave = assignCohorts(pooled, { size: cohortSize });

  // ── capacity ──────────────────────────────────────────────────────────────
  const perArm = (arm) => {
    const imps = arm.reduce((s, p) => s + p.impressions, 0);
    const clicks = arm.reduce((s, p) => s + p.clicks, 0);
    return { imps, clicks, ctr: imps > 0 ? clicks / imps : 0 };
  };
  const t = perArm(wave.treatment);
  const h = perArm(wave.holdout);
  // Scale the ranking window down to one 28-day measurement arm.
  const armImpressions = (t.imps / windowDays) * 28;
  const power = assessPower({ impressionsPerArm: armImpressions, baselineCtr: t.ctr });

  console.log(`\n  WAVE: ${wave.treatment.length} treated, ${wave.holdout.length} holdout, ${wave.unassigned.length} deferred`);
  console.log(`    treatment ${t.imps.toLocaleString()} imps / ${t.clicks} clicks / ${(t.ctr * 100).toFixed(2)}% CTR`);
  console.log(`    holdout   ${h.imps.toLocaleString()} imps / ${h.clicks} clicks / ${(h.ctr * 100).toFixed(2)}% CTR`);
  console.log(`    arm balance skew ${(wave.balance.skew * 100).toFixed(1)}%`);
  console.log(`    power: ${power.powered ? 'POWERED' : 'UNDERPOWERED'} — smallest readable move ${(power.mde * 100).toFixed(3)}pp`
    + ` against a ${(power.targetAbsoluteLift * 100).toFixed(3)}pp target`
    + (power.powered ? '' : `; needs ${Math.round(power.shortfall).toLocaleString()} more impressions per arm`));

  if (!power.powered) {
    console.log('    → This wave cannot be measured as designed. Widen the cohort or lengthen the window before running it.');
  }

  console.log('\n  Treatment cohort (rewrite these):');
  for (const p of wave.treatment) {
    console.log(`    ${String(p.impressions).padStart(6)} imps  ${(p.ctr * 100).toFixed(2)}% @ #${(p.position ?? 0).toFixed(1)}  ${p.cluster.padEnd(12)} ${String(p.url).split('/').pop().slice(0, 46)}`);
  }
  console.log('\n  Holdout cohort (DO NOT TOUCH):');
  for (const p of wave.holdout) {
    console.log(`    ${String(p.impressions).padStart(6)} imps  ${(p.ctr * 100).toFixed(2)}% @ #${(p.position ?? 0).toFixed(1)}  ${p.cluster.padEnd(12)} ${String(p.url).split('/').pop().slice(0, 46)}`);
  }

  if (write) {
    writeWave({ agg, wave, power, windowDays, t, h, individual });
    writeReport({ audit, conc, clusters, wave, power, agg, t, h, ranked, individual });
  }

  // Deferred to the 5 AM digest like everything else — never `immediate: true`.
  // An underpowered wave is a planning result, not an outage.
  notify({
    category: 'ctr-program',
    status: 'success',
    subject: `CTR wave planned — ${wave.treatment.length} treated, ${wave.holdout.length} holdout`,
    body: `${conc.totalImpressions.toLocaleString()} blog impressions over ${windowDays}d, top 10 pages hold `
      + `${(conc.rows.find((r) => r.topN === 10)?.share * 100 || 0).toFixed(1)}%. `
      + `Treatment ${t.imps.toLocaleString()} imps at ${(t.ctr * 100).toFixed(2)}%; holdout ${h.imps.toLocaleString()} imps at ${(h.ctr * 100).toFixed(2)}%. `
      + `${power.powered ? 'Powered' : 'UNDERPOWERED'} — smallest readable move ${(power.mde * 100).toFixed(3)}pp.`
      + (audit ? ` A/B history: ${audit.survivingVerdicts} of ${audit.concluded} concluded verdicts survive re-decision.` : ''),
  });
}

function writeWave({ agg, wave, power, windowDays: days, t, h, individual = [] }) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    source: agg.source,
    window_days: days,
    target_relative_lift: DEFAULT_TARGET_RELATIVE_LIFT,
    powered: power.powered,
    power,
    balance: wave.balance,
    treatment_totals: t,
    holdout_totals: h,
    // The two lists meta-optimizer reads: what to rewrite, and what it must
    // refuse to rewrite. A holdout page that gets rewritten stops being a
    // control and takes the whole wave's measurability with it.
    // Powered on their own: these get ORDINARY per-page A/B tests through
    // meta-optimizer + meta-ab-checker, not a cohort slot. They are listed here
    // so the wave file is the whole plan rather than most of it.
    individual: individual.map(slim),
    treatment: wave.treatment.map(slim),
    holdout: wave.holdout.map(slim),
    deferred: wave.unassigned.map(slim),
  };
  writeFileSync(join(REPORTS_DIR, 'wave.json'), JSON.stringify(payload, null, 2));
  console.log(`\n  Wave: ${join(REPORTS_DIR, 'wave.json')}`);
}

const slim = (p) => ({
  url: p.url,
  cluster: p.cluster,
  impressions: p.impressions,
  clicks: p.clicks,
  ctr: p.ctr,
  position: p.position,
  recoverable: p.recoverable ?? null,
  score: p.score ?? null,
});

function writeReport(ctx) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const { audit, conc, clusters, wave, power, agg, t, h, ranked, individual = [] } = ctx;
  const L = [];
  L.push(`# CTR Program — ${config.name}`);
  L.push(`**Run:** ${new Date().toISOString().slice(0, 10)}`);
  if (agg) L.push(`**Source:** ${agg.source}`);
  L.push('');

  if (audit) {
    L.push('## A/B history — is the existing program winning?');
    L.push('');
    L.push(`${audit.total} tests recorded, ${audit.concluded} concluded, ${audit.open} still open.`);
    L.push(`Re-decided under the current rules, **${audit.downgraded} of ${audit.concluded} change verdict**, `
      + `and **${audit.survivingVerdicts}** survive as evidence of anything.`);
    L.push('');
    L.push('| Tested | Keyword | Recorded | Re-decided | Impressions/arm | Smallest readable move | Delta |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of audit.rows) {
      L.push(`| ${r.testedAt} | ${r.keyword} | ${r.recordedOutcome ?? '—'} | ${r.reDecided} | `
        + `${Number(r.impressionsPerArm || 0).toLocaleString()} | ${r.mde != null ? `${(r.mde * 100).toFixed(2)}pp` : '—'} | `
        + `${(r.delta * 100).toFixed(2)}pp |`);
    }
    L.push('');
  }

  if (conc) {
    L.push('## Impression concentration');
    L.push('');
    L.push(`${conc.totalImpressions.toLocaleString()} blog impressions across ${conc.totalPages} pages.`);
    L.push('');
    L.push('| Top N pages | Impressions | Share |');
    L.push('|---|---|---|');
    for (const r of conc.rows) L.push(`| ${r.topN} | ${r.impressions.toLocaleString()} | ${(r.share * 100).toFixed(1)}% |`);
    L.push('');
  }

  if (clusters) {
    L.push('## By cluster');
    L.push('');
    L.push('| Cluster | Pages | Impressions | Clicks | CTR |');
    L.push('|---|---|---|---|---|');
    for (const c of clusters) {
      L.push(`| ${c.cluster} | ${c.pages} | ${c.impressions.toLocaleString()} | ${c.clicks} | ${(c.ctr * 100).toFixed(2)}% |`);
    }
    L.push('');
  }

  if (individual.length) {
    L.push('## Tested individually (not pooled)');
    L.push('');
    L.push('These pages carry enough traffic to be judged on their own over 28 days, so they go');
    L.push('through the ordinary per-page A/B path. Pooling them would make the cohort a');
    L.push('single-page test wearing a cohort\'s name.');
    L.push('');
    L.push('| Page | Impressions | CTR | Smallest readable move | Target |');
    L.push('|---|---|---|---|---|');
    for (const p of individual) {
      L.push(`| ${String(p.url).split('/').pop()} | ${p.impressions.toLocaleString()} | ${(p.ctr * 100).toFixed(2)}% | `
        + `${(p.power.mde * 100).toFixed(3)}pp | ${(p.power.targetAbsoluteLift * 100).toFixed(3)}pp |`);
    }
    L.push('');
  }

  if (wave) {
    L.push('## The wave');
    L.push('');
    L.push(`**Treatment:** ${wave.treatment.length} pages, ${t.imps.toLocaleString()} impressions, ${(t.ctr * 100).toFixed(2)}% CTR`);
    L.push(`**Holdout:** ${wave.holdout.length} pages, ${h.imps.toLocaleString()} impressions, ${(h.ctr * 100).toFixed(2)}% CTR`);
    L.push(`**Arm balance skew:** ${(wave.balance.skew * 100).toFixed(1)}%`);
    L.push(`**Power:** ${power.powered ? 'POWERED' : '**UNDERPOWERED**'} — the smallest move this wave can `
      + `distinguish from noise is ${(power.mde * 100).toFixed(3)}pp, against a target of `
      + `${(power.targetAbsoluteLift * 100).toFixed(3)}pp (+${(power.targetRelativeLift * 100).toFixed(0)}% relative).`);
    L.push('');
    L.push('> The holdout must not be rewritten by anything, for any reason, until the wave concludes.');
    L.push('');
    for (const [name, arm] of [['Treatment', wave.treatment], ['Holdout', wave.holdout]]) {
      L.push(`### ${name}`);
      L.push('');
      L.push('| Page | Cluster | Impressions | CTR | Position |');
      L.push('|---|---|---|---|---|');
      for (const p of arm) {
        L.push(`| ${String(p.url).split('/').pop()} | ${p.cluster} | ${p.impressions.toLocaleString()} | `
          + `${(p.ctr * 100).toFixed(2)}% | ${(p.position ?? 0).toFixed(1)} |`);
      }
      L.push('');
    }
    if (ranked) {
      L.push(`_${wave.unassigned.length} further pages ranked but deferred to a later wave._`);
      L.push('');
    }
  }

  const path = join(REPORTS_DIR, 'ctr-program-report.md');
  writeFileSync(path, L.join('\n'));
  console.log(`  Report: ${path}`);
}

// Guarded: importing this module must not run the agent. See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { finalise };
