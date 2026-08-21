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
import { listProfilesWithConsent, listEntrantProfiles } from '../../lib/klaviyo-profiles.js';
import { summarizeEntrants, confirmationFunnel } from '../../lib/giveaway/summarize.js';
import { computeEntryPurchaseCohort, entryValue, PRIOR_LOOKBACK_DAYS } from '../../lib/giveaway/cohort.js';
import { fetchCampaignSpend, evaluateSpendGate, resolveAccessToken } from '../../lib/giveaway/meta-spend.js';
import { getAllOrders } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const { listId, metaCampaignId, provisionalCostPerEntryTargetUsd } = config;
const OUT_DIR = join(ROOT, 'data', 'reports', 'giveaway');

const profiles = await listProfilesWithConsent(listId);
const subscribed = profiles.filter((p) => p.subscribed).length;
const summary = summarizeEntrants(profiles);

// SUBMISSIONS vs CONFIRMATIONS — two different questions, and reporting only the second
// as "entrants" hid a 27% confirmation rate on day one of the paid campaign. `profiles`
// above is list membership, which under double opt-in means CONFIRMED. This is everyone
// who submitted the form. See listEntrantProfiles.
//
// Never fatal: the daily report must survive Klaviyo being slow or this filter changing
// shape. A null funnel renders as "unavailable", exactly like the spend block does.
let funnel = null;
try {
  const submitted = await listEntrantProfiles(config.entryOpensAt);
  const confirmedEmails = new Set(
    profiles.map((p) => String(p.email || '').toLowerCase().trim()).filter(Boolean),
  );
  funnel = confirmationFunnel({ submitted, confirmedEmails, now: Date.now() });
} catch (e) {
  console.error('[giveaway] submission funnel unavailable:', e.message);
}

// Entry -> purchase, the number that makes cost per entry mean anything. Meta
// cannot supply it: it attributes on 7-day click / 1-day view, and this
// campaign's offer lands around day 30 via an email click that Shopify credits
// to email rather than Meta. See lib/giveaway/cohort.js.
//
// A Shopify outage must not cost the daily entrant report, so this degrades to
// null rather than throwing.
//
// The lookback is PRIOR_LOOKBACK_DAYS, not the widest measurement window: the
// cohort has to see orders from BEFORE each entry to tell a first-time buyer
// from a returning one. That is far more than 250 orders, so it uses the
// paginating getAllOrders — getOrders takes one page and stops at 250 with no
// error, which would silently mark long-standing customers as new.
let cohort = null;
let ordersTruncated = false;
try {
  const to = new Date();
  const from = new Date(to.getTime() - PRIOR_LOOKBACK_DAYS * 86400000);
  const { orders, truncated } = await getAllOrders(from.toISOString(), to.toISOString());
  ordersTruncated = truncated;
  cohort = computeEntryPurchaseCohort(profiles, orders, { now: to });
} catch (e) {
  console.error('[giveaway] cohort skipped:', e.message);
}

// Actual spend, not budget x days. See lib/giveaway/meta-spend.js.
const spend = await fetchCampaignSpend({
  campaignId: metaCampaignId,
  accessToken: resolveAccessToken(),
});
const spendGate = spend && !spend.error && cohort
  ? evaluateSpendGate({
    spend: spend.spend,
    entrants: summary.total,
    entryValue: entryValue(cohort),
    // Used only while measured entrant value is unavailable, and labelled 'provisional'
    // in the line when it is. See config/giveaway.json's note for what the number is and
    // is not.
    provisionalTarget: provisionalCostPerEntryTargetUsd ?? null,
  })
  : null;

const report = {
  funnel,
  generatedAt: new Date().toISOString(),
  stillSubscribed: subscribed,
  ...summary,
  cohort,
  ordersTruncated,
  spend: spend ?? null,
  spendGate: spendGate ?? null,
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
  out.push(`  value per NEW entrant: ${v.value === null ? 'n/a' : '$' + v.value} (${v.basis}, ${v.matured} matured)`);
  const seg = (label, m) => {
    const w = m.windows[30];
    out.push(`  ${label}: ${m.entrants} entrant(s)` + (w.rate === null ? ' — 30d not matured' : `, 30d ${w.rate}% -> $${w.revenue}`));
  };
  seg('new customers     ', c.segments.new);
  seg('existing customers', c.segments.existing);
  out.push('  (existing-customer conversions are NOT incremental — they repurchase anyway)');
  if (c.entrantsUndated) out.push(`  ${c.entrantsUndated} entrant(s) have no entry date and are excluded`);
  if (c.unjoinableOrders) out.push(`  ${c.unjoinableOrders} order(s) could not be joined to an entrant`);
  return out;
}

const gates = [];
if (spendGate?.verdict === 'over') gates.push(spendGate.line);
if (ordersTruncated) {
  gates.push('GATE: Shopify order lookback truncated — the new-vs-existing split is unreliable this run.');
}
if (answered >= 50 && reactiveShare < 0.5) {
  gates.push('GATE: answer mix is drifting off the fragrance-free angle — shift budget to creative #3.');
}
if (summary.total >= 50 && summary.ladder.entrantsWithReferrals === 0) {
  gates.push('GATE: zero referral participation — rework the nurture CTA, do not raise budget.');
}

console.log(`Entrants: ${summary.total}  Entries: ${summary.entriesTotal}  Still subscribed: ${subscribed}`);
if (funnel) {
  // Lead with the MATURED rate. The raw one moves with how fast entrants arrive,
  // so on a running campaign it reads as a collapsing funnel when nothing is wrong.
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  console.log(
    `Funnel: ${funnel.submitted} submitted -> ${funnel.confirmed} confirmed, `
    + `${funnel.unconfirmed} awaiting confirmation`
  );
  console.log(
    funnel.matured.submitted
      ? `  confirmation ${pct(funnel.matured.rate)} `
        + `(${funnel.matured.confirmed}/${funnel.matured.submitted} past ${funnel.maturityHours}h) `
        + `· ${funnel.pending} still inside the window · raw ${pct(funnel.confirmationRate)}`
      : `  confirmation not yet readable — no entrant has reached ${funnel.maturityHours}h, `
        + `so the nudge has not had its first chance. ${funnel.pending} still inside the window. `
        + `Raw ${pct(funnel.confirmationRate)} measures recency, not consent.`
  );
  if (funnel.undateable) {
    console.log(`  ${funnel.undateable} entrant(s) have no gv_entered_at and are excluded from the rate`);
  }
  if (spend?.spend > 0 && funnel.submitted) {
    console.log(`  cost per submission $${(spend.spend / funnel.submitted).toFixed(2)}`
      + (funnel.confirmed ? ` | per confirmed $${(spend.spend / funnel.confirmed).toFixed(2)}` : ''));
  }
}
console.log(`Reactive/fragrance share: ${(reactiveShare * 100).toFixed(0)}%`);
if (cohort) {
  const v = entryValue(cohort);
  console.log(`Entry value: ${v.value === null ? 'n/a' : '$' + v.value} per entrant (${v.basis}, ${v.matured} matured)`);
  for (const d of [30, 60, 90]) {
    const w = cohort.windows[d];
    console.log(`  ${d}d: ${w.rate === null ? w.note : `${w.rate}% of ${w.matured} -> $${w.revenue}`}`);
  }
}
if (spendGate) console.log(spendGate.line);
if (ordersTruncated) console.log('WARNING: the Shopify order lookback was truncated — new/existing split may be wrong.');
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
