#!/usr/bin/env node
/**
 * Backfill country breakdown onto historical GA4 snapshots.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * PR #768 added sessionsByCountry / us / usLandingPages to fetchGA4Snapshot, so
 * every snapshot from that deploy forward carries country. The ~180 files already
 * on disk do not, and without them every historical CVR read repeats the mistake
 * that nearly set a paid-media budget on a 0.090% site-wide rate whose real,
 * US-only, product-page value was 1.03%.
 *
 * ── The rule this script obeys: ADD, never REWRITE ───────────────────────────
 * GA4 numbers move after the fact (late-arriving data, modelling), so re-fetching
 * a whole snapshot would silently change history. This writes ONLY the three new
 * fields and leaves every existing key byte-identical. A file that already has
 * them is skipped, so the script is idempotent.
 *
 * ── The guard that matters ───────────────────────────────────────────────────
 * Beyond GA4's retention window the API returns 200 with ZERO rows — indistinguishable
 * from a genuine no-traffic day if you only look at the response. So a date whose
 * snapshot records sessions > 0 while the country report comes back empty is a
 * RETENTION MISS: it is reported and SKIPPED, never written. Writing
 * `sessionsByCountry: []` there would permanently record "nobody visited" for a day
 * that had traffic — worse than leaving the field absent, because absent is honest.
 *
 * Usage:
 *   node scripts/backfill-ga4-country.mjs                 # dry run, reports what it would do
 *   node scripts/backfill-ga4-country.mjs --apply         # write
 *   node scripts/backfill-ga4-country.mjs --apply --limit 20
 *   node scripts/backfill-ga4-country.mjs --date 2026-08-01 [--apply]
 */

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCountryBreakdown } from '../lib/ga4.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'snapshots', 'ga4');

export function needsBackfill(snap) {
  return !Array.isArray(snap?.sessionsByCountry);
}

/**
 * Decide what to do with one snapshot given what GA4 returned for its date.
 * Pure, so every branch is a case a test constructs rather than a claim in a comment.
 */
export function decideBackfill(snap, breakdown) {
  if (!needsBackfill(snap)) return { action: 'skip', reason: 'already has country data' };
  const rows = breakdown?.sessionsByCountry ?? [];
  const snapshotSessions = Number(snap?.sessions ?? 0);
  if (rows.length === 0 && snapshotSessions > 0) {
    return {
      action: 'skip',
      reason: `retention miss — snapshot records ${snapshotSessions} sessions but GA4 returned no country rows`,
    };
  }
  return { action: 'write' };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const one = argv[argv.indexOf('--date') + 1];
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg === -1 ? Infinity : Number(argv[limitArg + 1]);

  // data/snapshots/ is gitignored and server-written, so a local checkout legitimately
  // has none. Say so plainly rather than throwing ENOENT at somebody who did nothing wrong.
  if (!existsSync(DIR)) {
    console.log(`No GA4 snapshots at ${DIR}.`);
    console.log('These are written by cron on the production server and are gitignored;');
    console.log('run this there, or `npm run sync-snapshots` first.');
    return;
  }

  let files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
  if (argv.includes('--date')) files = files.filter(f => f.startsWith(one));

  let written = 0, skipped = 0, missed = 0, already = 0;
  const misses = [];

  for (const file of files) {
    if (written >= limit) break;
    const path = join(DIR, file);
    const date = file.replace(/\.json$/, '');

    let snap;
    try { snap = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { console.log(`  ✗ ${date}  unreadable: ${err.message}`); skipped++; continue; }

    if (!needsBackfill(snap)) { already++; continue; }

    let breakdown;
    try { breakdown = await fetchCountryBreakdown(date); }
    catch (err) { console.log(`  ✗ ${date}  fetch failed: ${err.message}`); skipped++; continue; }

    const decision = decideBackfill(snap, breakdown);
    if (decision.action === 'skip') {
      console.log(`  ⚠ ${date}  ${decision.reason}`);
      misses.push(date); missed++; continue;
    }

    const us = breakdown.us;
    const total = breakdown.sessionsByCountry.reduce((a, b) => a + b.sessions, 0);
    const share = total ? ((100 * us.sessions) / total).toFixed(1) : '0.0';
    console.log(`  ${apply ? '✓' : '·'} ${date}  ${total} sessions, US ${us.sessions} (${share}%), ${breakdown.sessionsByCountry.length} countries`);

    if (apply) {
      // ADD only. Existing keys are untouched and key order is preserved.
      const merged = { ...snap, ...breakdown };
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2));
      JSON.parse(readFileSync(tmp, 'utf8')); // refuse to leave a broken file behind
      renameSync(tmp, path);
    }
    written++;
  }

  console.log(`\n${apply ? 'WROTE' : 'WOULD WRITE'} ${written} · already had it ${already} · retention misses ${missed} · errors ${skipped}`);
  if (misses.length) console.log(`retention misses: ${misses.join(', ')}`);
  if (!apply) console.log('\n(dry run — pass --apply to write)');
}

if (isDirectRun(import.meta.url)) await main();
