#!/usr/bin/env node
/**
 * Recompute the AI-citation baseline with Gemini's grounding redirector resolved.
 *
 * WHY. `agents/ai-citation-tracker` asked `url.includes(brand.domain)` of
 * citation URLs, and EVERY Gemini citation — 8,400 of 8,400 across all stored
 * snapshots — is an opaque `vertexaisearch.cloud.google.com/grounding-api-
 * redirect/<token>`. So `citation_rate.gemini` has been 0 by construction since
 * the engine started returning citations on 2026-07-12, and every competitor
 * citation tally is missing Gemini's contribution entirely. The agent is fixed
 * going forward; this re-reads what is already on disk.
 *
 * It matters right now because 19 PR pitches went out on 2026-09-21 and the
 * 2026-09-20 snapshot is their pre-outreach baseline.
 *
 * READ-ONLY OVER THE HISTORY. `data/reports/ai-citations/*.json` is
 * server-written and is the only copy of this history. This script NEVER writes
 * there, and writes anywhere only under --apply.
 *
 *   node scripts/recompute-citation-baseline.mjs                  # dry: report to stdout
 *   node scripts/recompute-citation-baseline.mjs --apply          # also write the report
 *   node scripts/recompute-citation-baseline.mjs --since 2026-08-23
 *   node scripts/recompute-citation-baseline.mjs --date 2026-09-20
 *   node scripts/recompute-citation-baseline.mjs --dir <path>     # read snapshots elsewhere
 *   node scripts/recompute-citation-baseline.mjs --no-resolve     # degrade: recompute nothing
 *
 * Output (--apply): data/reports/ai-citation-baseline/<stamp>.{json,md}
 *
 * NOTE ON RECOVERABILITY. Grounding tokens expire after roughly 30 days
 * (measured 2026-09-21: 2026-08-16 resolves 0/25, 2026-08-23 resolves 25/25),
 * so the recoverable window SHRINKS EVERY DAY and the early snapshots are gone
 * for good. Unresolved redirects are counted, never quietly dropped.
 *
 * SO PASS --since, AND NOT ONLY TO SAVE TIME. Measured 2026-09-21, the two runs
 * disagreed and the bigger one was the WRONG answer:
 *
 *   whole history   8,400 requests   2,032 resolved   109.5s
 *   --since 2026-08-23   4,432 requests   4,432 resolved    57.1s
 *
 * The unbounded sweep spends its first ~4,300 requests on tokens that are
 * genuinely expired and then starts being refused, so 2026-09-13 and 2026-09-20
 * — both fully recoverable — came back as zeros. **A default run can therefore
 * UNDER-REPORT a snapshot it could have recovered.** The counts in
 * `redirects_unresolved` are what distinguishes the two cases; they are not
 * interchangeable with "expired". Scope the run to the recoverable window.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGroundingRedirects, resolveGroundingRedirects, DEFAULT_CONCURRENCY } from '../lib/citation-redirects.js';
import { recomputeSnapshot, reconciliationMismatches } from '../lib/citation-baseline-recompute.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'ai-citation-baseline');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESOLVE = !args.includes('--no-resolve');
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};
const SNAPSHOT_DIR = argVal('--dir', join(ROOT, 'data', 'reports', 'ai-citations'));
const SINCE = argVal('--since', null);
const ONLY_DATE = argVal('--date', null);

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));
const { brand, competitors } = config;

function loadSnapshots() {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  // `latest.json` is a copy of the newest dated file; including it would double
  // that day's weight in every aggregate.
  return readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter((f) => !SINCE || f.slice(0, 10) >= SINCE)
    .filter((f) => !ONLY_DATE || f.slice(0, 10) === ONLY_DATE)
    .sort()
    .map((f) => {
      try { return JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const range = (row) =>
  row.citation_rate_corrected_min === null
    ? 'n/a'
    : row.exact
      ? pct(row.citation_rate_corrected_min)
      : `${pct(row.citation_rate_corrected_min)} – ${pct(row.citation_rate_corrected_max)}`;

function renderMarkdown(report) {
  const L = [];
  L.push('# AI Citation Baseline — RECOMPUTED');
  L.push('');
  L.push(`Generated: ${report.generated_at}`);
  L.push('');
  L.push('> **This is a RECOMPUTATION, not a measurement.** It re-reads the stored');
  L.push('> `citation_urls` from snapshots already on disk and resolves Gemini\'s grounding');
  L.push('> redirector, which `agents/ai-citation-tracker` did not do before 2026-09-21.');
  L.push('> **No snapshot was modified.** The original figures are shown beside the corrected');
  L.push('> ones so nothing is silently replaced.');
  L.push('');
  L.push('> A corrected rate is a RANGE wherever a cell was sampled more than once: the stored');
  L.push('> `citation_urls` is a union across runs, so a resolved brand URL proves at least one');
  L.push('> run cited us and cannot say how many did. A single figure means both bounds agree.');
  L.push('');
  L.push(`Redirect resolution: **${report.redirect_resolution.mode}** — `
    + `${report.redirect_resolution.resolved}/${report.redirect_resolution.seen} redirect(s) resolved`
    + `${report.redirect_resolution.unresolved ? `, ${report.redirect_resolution.unresolved} EXPIRED or unresolvable` : ''}.`);
  L.push('');
  if (report.redirect_resolution.unresolved) {
    L.push('> Grounding tokens expire after roughly 30 days. Snapshots whose tokens have expired');
    L.push('> cannot be recovered at all and their Gemini rows stay at their original 0 — that is');
    L.push('> an UNKNOWN, not a measured zero.');
    L.push('');
  }

  for (const snap of report.snapshots) {
    L.push(`## ${snap.date}${snap.runs_per_core_cell > 1 ? ` (${snap.runs_per_core_cell} runs per core cell)` : ''}`);
    L.push('');
    L.push('| Engine | Citation rate (original) | Citation rate (CORRECTED) | n | cells newly cited | redirects unresolved |');
    L.push('|---|---|---|---|---|---|');
    for (const [source, row] of Object.entries(snap.engines)) {
      L.push(`| ${source}${row.changed ? ' **←**' : ''} | ${pct(row.citation_rate_original)} | ${range(row)} | ${row.n} | ${row.cells_newly_cited} | ${row.redirects_unresolved} |`);
    }
    L.push('');
    if (snap.mismatches.length) {
      L.push(`> ⚠ The recomputed ORIGINAL column disagrees with this snapshot's own stored summary for: ${snap.mismatches.join(', ')}. Treat the corrected column beside it as suspect.`);
      L.push('');
    }
    const compChanged = Object.entries(snap.top_competitor_citations_corrected)
      .filter(([n, c]) => c !== (snap.top_competitor_citations_original[n] || 0));
    if (compChanged.length) {
      L.push('### Competitor citations — original → corrected');
      L.push('');
      L.push('| Competitor | Original | Corrected |');
      L.push('|---|---|---|');
      for (const [name, count] of compChanged) {
        L.push(`| ${name} | ${snap.top_competitor_citations_original[name] || 0} | ${count} |`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

async function main() {
  const snapshots = loadSnapshots();
  if (!snapshots.length) {
    console.log(`[recompute-citation-baseline] No snapshots in ${SNAPSHOT_DIR}.`);
    console.log('  These are SERVER-WRITTEN and gitignored — a local checkout holding none is normal.');
    console.log('  Pull them read-only first, or pass --dir.');
    return;
  }
  console.log(`[recompute-citation-baseline] ${snapshots.length} snapshot(s) from ${SNAPSHOT_DIR}`);

  const redirects = RESOLVE ? collectGroundingRedirects(snapshots) : [];
  let resolved = new Map();
  let stats = { attempted: 0, failed: 0, skipped: 0 };
  if (redirects.length) {
    if (!SINCE && !ONLY_DATE && redirects.length > 5000) {
      console.log(`  ⚠ ${redirects.length} redirects and no --since. Most of the early ones are EXPIRED`);
      console.log('    (tokens live ~30 days), and spending requests on them has been measured to get');
      console.log('    the later, recoverable snapshots refused. Scope the run: --since <YYYY-MM-DD>.');
    }
    console.log(`  Resolving ${redirects.length} grounding redirect(s) at concurrency ${DEFAULT_CONCURRENCY}...`);
    const t0 = Date.now();
    stats = await resolveGroundingRedirects(redirects, {
      concurrency: DEFAULT_CONCURRENCY,
      onProgress: (done, total) => console.log(`    ...${done}/${total}`),
    });
    resolved = stats.resolved;
    console.log(`  Resolved ${resolved.size}/${redirects.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      + ` (${redirects.length - resolved.size} expired or unresolvable).`);
  } else if (!RESOLVE) {
    console.log('  --no-resolve: nothing is recomputed; every figure below reproduces the original.');
  }

  const rows = snapshots.map((snap) => {
    const out = recomputeSnapshot(snap, resolved, { brand, competitors });
    out.mismatches = reconciliationMismatches(out);
    return out;
  });

  const report = {
    generated_at: new Date().toISOString(),
    kind: 'recomputation',
    note:
      'Recomputed from stored citation_urls with Gemini grounding redirects resolved. '
      + 'No ai-citations snapshot was modified. Corrected rates are bounds where a cell was '
      + 'sampled more than once, because citation_urls is a union across runs.',
    source_dir: SNAPSHOT_DIR,
    redirect_resolution: {
      mode: RESOLVE ? 'on' : 'off',
      seen: redirects.length,
      resolved: resolved.size,
      unresolved: redirects.length - resolved.size,
    },
    snapshots: rows,
  };

  for (const snap of rows) {
    const changed = Object.entries(snap.engines).filter(([, r]) => r.changed);
    if (!changed.length) continue;
    console.log(`  ${snap.date}:`);
    for (const [source, r] of changed) {
      console.log(`    ${source}: ${pct(r.citation_rate_original)} → ${range(r)} (n=${r.n}, ${r.cells_newly_cited} cell(s) newly cited)`);
    }
    if (snap.mismatches.length) console.log(`    ⚠ original column disagrees with stored summary for: ${snap.mismatches.join(', ')}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to save the report.');
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  writeFileSync(join(OUT_DIR, `${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, `${stamp}.md`), renderMarkdown(report));
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nSaved: ${join(OUT_DIR, `${stamp}.md`)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
