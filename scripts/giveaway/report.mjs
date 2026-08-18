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
import { computeEntryPurchaseCohort, entryValue } from '../../lib/giveaway/cohort.js';
import { getOrders } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'data', 'reports', 'giveaway');

const profiles = await listProfilesWithConsent(listId);
const subscribed = profiles.filter((p) => p.subscribed).length;
const summary = summarizeEntrants(profiles);

// Entry -> purchase, the number that makes cost per entry mean anything. Meta
// cannot supply it: it attributes on 7-day click / 1-day view, and this
// campaign's offer lands around day 30 via an email click that Shopify credits
// to email rather than Meta. See lib/giveaway/cohort.js.
//
// A Shopify outage must not cost the daily entrant report, so this degrades to
// null rather than throwing. 120 days covers the widest window plus headroom.
let cohort = null;
try {
  const to = new Date();
  const from = new Date(to.getTime() - 120 * 86400000);
  const { rawOrders } = await getOrders(from.toISOString(), to.toISOString());
  cohort = computeEntryPurchaseCohort(profiles, rawOrders, { now: to });
} catch (e) {
  console.error('[giveaway] cohort skipped:', e.message);
}

const report = {
  generatedAt: new Date().toISOString(),
  stillSubscribed: subscribed,
  ...summary,
  cohort,
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

// A rate with no denominator is not a decision. Every line states what it is
// out of, and an immature window says so instead of printing a 0% that would
// read as "the giveaway does not convert" before it has had a chance to.
function cohortLines(c) {
  const v = entryValue(c);
  const out = ['', 'Entry -> purchase (channel-agnostic; Meta cannot see most of this):'];
  for (const d of [30, 60, 90]) {
    const w = c.windows[d];
    out.push(w.rate === null
      ? `  ${d}d: ${w.note}`
      : `  ${d}d: ${w.purchasers}/${w.matured} matured = ${w.rate}%  ($${w.revenue}, $${w.revenuePerEntrant}/entrant)`);
  }
  out.push(`  value per entry: ${v.value === null ? 'n/a' : '$' + v.value} (${v.basis})`);
  if (c.entrantsUndated) out.push(`  ${c.entrantsUndated} entrant(s) have no entry date and are excluded`);
  if (c.unjoinableOrders) out.push(`  ${c.unjoinableOrders} order(s) could not be joined to an entrant`);
  return out;
}

const gates = [];
if (answered >= 50 && reactiveShare < 0.5) {
  gates.push('GATE: answer mix is drifting off the fragrance-free angle — shift budget to creative #3.');
}
if (summary.total >= 50 && summary.ladder.entrantsWithReferrals === 0) {
  gates.push('GATE: zero referral participation — rework the nurture CTA, do not raise budget.');
}

console.log(`Entrants: ${summary.total}  Entries: ${summary.entriesTotal}  Still subscribed: ${subscribed}`);
console.log(`Reactive/fragrance share: ${(reactiveShare * 100).toFixed(0)}%`);
if (cohort) {
  const v = entryValue(cohort);
  console.log(`Entry value: ${v.value === null ? 'n/a' : '$' + v.value} per entrant (${v.basis}, ${v.matured} matured)`);
  for (const d of [30, 60, 90]) {
    const w = cohort.windows[d];
    console.log(`  ${d}d: ${w.rate === null ? w.note : `${w.rate}% of ${w.matured} -> $${w.revenue}`}`);
  }
}
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
    ...(cohort ? cohortLines(cohort) : ['', 'Entry -> purchase: unavailable (Shopify read failed).']),
    '',
    ...(gates.length ? gates : ['No gates fired.']),
  ].join('\n'),
  status: 'info',
  category: 'ads',
}).catch(() => {});
