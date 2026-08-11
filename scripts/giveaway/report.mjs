/**
 * Daily giveaway report -> data/reports/giveaway/latest.json
 *   node scripts/giveaway/report.mjs
 *
 * Prints the day-5 and day-10 gates from spec 11 so a human reading the log
 * sees the decision, not just the numbers.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSubscribedProfiles } from '../../lib/klaviyo-profiles.js';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'data', 'reports', 'giveaway');

const profiles = await listSubscribedProfiles(listId);
const summary = summarizeEntrants(profiles);
const report = { generatedAt: new Date().toISOString(), ...summary };

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);

const f = summary.answers.frustration || {};
const reactiveShare = summary.total
  ? ((f.reactive || 0) + (f.fragrance || 0)) / summary.total
  : 0;

console.log(`Entrants: ${summary.total}  Entries: ${summary.entriesTotal}`);
console.log(`Reactive/fragrance share: ${(reactiveShare * 100).toFixed(0)}%`);
if (summary.total >= 50 && reactiveShare < 0.5) {
  console.log('GATE: answer mix is drifting off the fragrance-free angle — shift budget to creative #3.');
}
if (summary.total >= 50 && summary.ladder.entrantsWithReferrals === 0) {
  console.log('GATE: zero referral participation — rework the nurture CTA, do not raise budget.');
}
