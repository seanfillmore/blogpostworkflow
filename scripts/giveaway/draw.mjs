#!/usr/bin/env node
/**
 * Conduct the drawing.
 *
 *   node scripts/giveaway/draw.mjs --seed 43214.87            # dry run
 *   node scripts/giveaway/draw.mjs --seed 43214.87 --apply    # writes the result
 *
 * Reads ONLY the committed snapshot. It never queries Klaviyo: the pool was
 * frozen at entry close and re-reading live data would silently draw from a
 * different set than the one that was published.
 *
 * Every failure path refuses. This runs once, disposes of $1,072.80 of prizes,
 * and cannot be undone — a wrong result that completes is far worse than a run
 * that stops.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { drawOrdering, determineReferralPrize } from '../../lib/giveaway/draw.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT_REL = 'data/giveaway/draw-snapshot.json';
const RESULT_REL = 'data/giveaway/draw-result.json';

/**
 * The snapshot must be committed AND unmodified.
 *
 * This is what makes the manual commit step safe: an operator who forgets it
 * gets a refusal here rather than an unprovable draw nobody notices.
 */
export function assertSnapshotCommitted(root, relPath) {
  const full = join(root, relPath);
  if (!existsSync(full)) throw new Error(`snapshot missing: ${relPath}`);
  let committed;
  try {
    committed = execFileSync('git', ['rev-parse', `HEAD:${relPath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`${relPath} is not committed — commit the snapshot before drawing`);
  }
  const actual = execFileSync('git', ['hash-object', full], { cwd: root, encoding: 'utf8' }).trim();
  if (actual !== committed) {
    throw new Error(`${relPath} differs from the committed copy — the frozen pool has been edited`);
  }
  return committed;
}

// Importing this module must not conduct a drawing. Guarded because importing a
// script module RUNS it, and this one awards $1,072.80 of prizes.
const isDirectRun = process.argv[1] && process.argv[1].endsWith('draw.mjs');
if (isDirectRun) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
  };
  const seed = arg('--seed');
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  if (!seed) {
    console.error('Refusing: --seed is required. Use the published seed value.');
    process.exit(1);
  }
  if (existsSync(join(ROOT, RESULT_REL)) && !force) {
    console.error(`Refusing: ${RESULT_REL} already exists. A second draw must be deliberate (--force).`);
    process.exit(1);
  }

  let blob;
  try {
    blob = assertSnapshotCommitted(ROOT, SNAPSHOT_REL);
  } catch (e) {
    console.error(`Refusing: ${e.message}`);
    process.exit(1);
  }

  const snapshot = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_REL), 'utf8'));

  const summed = snapshot.entrants.reduce((n, e) => n + e.entries, 0);
  if (summed !== snapshot.totals.entries) {
    console.error(`Refusing: snapshot totals disagree with its rows (${snapshot.totals.entries} vs ${summed}).`);
    process.exit(1);
  }
  if (!snapshot.entrants.length) {
    console.error('Refusing: the snapshot holds no entrants.');
    process.exit(1);
  }

  const ordering = drawOrdering(snapshot, seed);
  const winner = ordering[0];
  const prize = determineReferralPrize(snapshot, winner);

  console.log(`Snapshot ${blob.slice(0, 12)} — ${snapshot.totals.entrants} entrants, ${snapshot.totals.entries} entries`);
  console.log(`Taken ${snapshot.takenAt} | entries closed ${snapshot.entryClosesAt}`);
  console.log(`Seed: ${seed}\n`);
  console.log(`WINNER: ${winner}`);
  console.log(`Referral prize: ${prize.awarded ? prize.email : 'NOT AWARDED'} — ${prize.reason}`);
  console.log(`\nAlternates, in order: ${ordering.slice(1, 6).join(', ')}`);

  if (!apply) {
    console.log('\nDry run — pass --apply to write the result.');
  } else {
    const result = {
      drawnAt: new Date().toISOString(),
      seed,
      seedSha256: createHash('sha256').update(String(seed), 'utf8').digest('hex'),
      snapshotBlob: blob,
      snapshotTakenAt: snapshot.takenAt,
      totals: snapshot.totals,
      winner,
      referralPrize: prize,
      ordering,
    };
    writeFileSync(join(ROOT, RESULT_REL), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nWrote ${RESULT_REL}. Commit it.`);
  }
}
