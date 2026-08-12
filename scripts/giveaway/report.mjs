/**
 * Daily giveaway report -> data/reports/giveaway/latest.json
 *   node scripts/giveaway/report.mjs
 *
 * Emits the day-5 and day-10 gates from spec 11 through lib/notify.js, the same
 * way every other agent in this fleet surfaces a decision. Printing them to
 * stdout alone was not enough: the script runs from cron, and nobody reads
 * /var/log. Deferred notifications land in the 5 AM daily digest.
 *
 * Counts EVERY profile on the list, not just the currently-subscribed ones.
 * Official rules §12 keeps an entry valid after an unsubscribe, so an entrant
 * count that silently drops unsubscribers would understate the campaign and
 * disagree with the draw snapshot.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProfilesWithConsent } from '../../lib/klaviyo-profiles.js';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';
import { notify } from '../../lib/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'data', 'reports', 'giveaway');

const profiles = await listProfilesWithConsent(listId);
const subscribed = profiles.filter((p) => p.subscribed).length;
const summary = summarizeEntrants(profiles);
const report = {
  generatedAt: new Date().toISOString(),
  stillSubscribed: subscribed,
  ...summary,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);

const f = summary.answers.frustration || {};
// Denominator is survey RESPONDENTS, not all entrants. Dividing by every
// entrant counts people who have not reached the survey step as if they had
// answered "not reactive", mechanically deflating the share and firing a false
// drift alarm early in the campaign.
const answered = Object.values(f).reduce((a, b) => a + b, 0);
const reactiveShare = answered ? ((f.reactive || 0) + (f.fragrance || 0)) / answered : 0;

const gates = [];
if (answered >= 50 && reactiveShare < 0.5) {
  gates.push('GATE: answer mix is drifting off the fragrance-free angle — shift budget to creative #3.');
}
if (summary.total >= 50 && summary.ladder.entrantsWithReferrals === 0) {
  gates.push('GATE: zero referral participation — rework the nurture CTA, do not raise budget.');
}

console.log(`Entrants: ${summary.total}  Entries: ${summary.entriesTotal}  Still subscribed: ${subscribed}`);
console.log(`Reactive/fragrance share: ${(reactiveShare * 100).toFixed(0)}%`);
for (const gate of gates) console.log(gate);

// A gate that nobody reads decides nothing, so the gates are the subject line
// when one fires. A clean run still notifies, so the daily digest carries the
// campaign's only in-flight signal (the offer is day 30, so there is no revenue
// number to read until then). Deliberately NOT `immediate`: a gate is a budget
// decision for the morning, not an outage, and it belongs in the 5 AM digest
// with everything else rather than as a standalone ❌ email.
await notify({
  subject: gates.length
    ? `Giveaway: ${gates.length} gate(s) fired — ${summary.total} entrants`
    : `Giveaway: ${summary.total} entrants, ${summary.entriesTotal} entries`,
  body: [
    `Entrants: ${summary.total} (still subscribed: ${subscribed})`,
    `Entries: ${summary.entriesTotal}`,
    `Reactive/fragrance share: ${(reactiveShare * 100).toFixed(0)}% of ${answered} survey respondents`,
    `Ladder: confirmed ${summary.ladder.confirmed}, survey ${summary.ladder.survey}, `
      + `referrals ${summary.ladder.referrals} across ${summary.ladder.entrantsWithReferrals} entrants, `
      + `instagram ${summary.ladder.instagram}, upload ${summary.ladder.upload}`,
    '',
    ...(gates.length ? gates : ['No gates fired.']),
  ].join('\n'),
  status: 'info',
  category: 'ads',
}).catch(() => {});
