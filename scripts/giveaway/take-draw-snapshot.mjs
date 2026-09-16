#!/usr/bin/env node
/**
 * Freeze the entrant pool for the drawing.
 *
 *   node scripts/giveaway/take-draw-snapshot.mjs            # dry — prints totals
 *   node scripts/giveaway/take-draw-snapshot.mjs --apply    # writes the file
 *
 * Runs on the SERVER from close-entry-period.mjs on Sep 15. It does NOT commit:
 * this repo has no server-side push credentials and adding them for one annual
 * job would be a standing risk for a one-day benefit. The operator commits the
 * file, and draw.mjs refuses to run against an uncommitted or modified snapshot
 * — so forgetting that step produces a refusal, not a quietly unprovable draw.
 *
 * The notify is immediate: the 5 AM digest is the wrong latency for the one
 * artefact the drawing depends on.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* no .env is a valid state */ }

const { listProfilesWithConsent, listEntrantProfiles } = await import('../../lib/klaviyo-profiles.js');
const { mergeEntrantProfiles } = await import('../../lib/giveaway/referral-audit.js');
const { buildSnapshot } = await import('../../lib/giveaway/draw-snapshot.js');
const { snapshotWriteRefusal } = await import('../../lib/giveaway/entry-period.js');
const { notify } = await import('../../lib/notify.js');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');
const OUT = join(ROOT, 'data', 'giveaway', 'draw-snapshot.json');

// The frozen pool is the evidence the drawing rests on. Retaking it later reads
// live Klaviyo again and can silently draw from a different set than the one
// taken at the close, so an existing file is never overwritten without --force.
const refusal = snapshotWriteRefusal({ exists: existsSync(OUT), force: process.argv.includes('--force') });
if (apply && refusal) {
  console.error(`Refusing: ${refusal}`);
  process.exit(1);
}

// BOTH populations: the Klaviyo list only ever holds confirmed entrants, and the
// operator determination is that unconfirmed entrants are in the draw.
const [listed, submitted] = await Promise.all([
  listProfilesWithConsent(config.listId),
  listEntrantProfiles(config.entryOpensAt),
]);
const snapshot = buildSnapshot(mergeEntrantProfiles(listed, submitted), {
  entryClosesAt: config.entryClosesAt,
  includeUnconfirmed: config.drawIncludesUnconfirmedEntrants === true,
  takenAt: new Date().toISOString(),
  // §5 disqualification of automated entries. Declared in config so the reason
  // travels with the committed snapshot rather than living in this script.
  fraudWindows: Array.isArray(config.disqualifiedEntryWindows) ? config.disqualifiedEntryWindows : [],
});

console.log(`${snapshot.totals.entrants} entrants | ${snapshot.totals.entries} entries`);
console.log(`  confirmed: ${snapshot.totals.confirmed} | unconfirmed: ${snapshot.totals.unconfirmed}`);
console.log(`  excluded: ${JSON.stringify(snapshot.excluded)}`);

// A disqualification is the loudest thing this script can report: it removes real
// rows from a $1,072.80 drawing. Never let it sit inside the excluded blob alone.
for (const w of snapshot.determinations.fraudWindows) {
  console.log(`  §5 window ${w.from} .. ${w.to} — ${w.reason}`);
}
if (snapshot.excluded.fraudulent > 0) {
  console.log(`  §5 DISQUALIFIED ${snapshot.excluded.fraudulent} entrant(s) as automated.`);
}

if (!apply) { console.log('\nDry run — pass --apply to write.'); process.exit(0); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`\nWrote ${OUT}`);

await notify({
  subject: `Giveaway draw snapshot taken: ${snapshot.totals.entrants} entrants, ${snapshot.totals.entries} entries`,
  body: [
    `Snapshot written to data/giveaway/draw-snapshot.json at ${snapshot.takenAt}.`,
    `Confirmed ${snapshot.totals.confirmed}, unconfirmed ${snapshot.totals.unconfirmed}.`,
    `Excluded: ${JSON.stringify(snapshot.excluded)}.`,
    ...(snapshot.excluded.fraudulent > 0
      ? ['', `§5: ${snapshot.excluded.fraudulent} entrant(s) DISQUALIFIED as automated.`,
        ...snapshot.determinations.fraudWindows.map((w) => `  ${w.from} .. ${w.to} — ${w.reason}`)]
      : []),
    '',
    'ACTION REQUIRED before the drawing: pull this file down and COMMIT it.',
    'draw.mjs refuses to run against an uncommitted snapshot.',
    '',
    '  scp root@137.184.119.230:~/seo-claude/data/giveaway/draw-snapshot.json data/giveaway/',
  ].join('\n'),
  status: 'success',
  category: 'giveaway',
  immediate: true,
});
