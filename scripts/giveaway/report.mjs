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
import { confirmedEmailSet, resolveMechanism } from '../../lib/giveaway/reconcile.js';
import { computeEntryPurchaseCohort, entryValue, PRIOR_LOOKBACK_DAYS } from '../../lib/giveaway/cohort.js';
import {
  fetchCampaignSpend, evaluateSpendGate, resolveAccessToken, spendWindow,
} from '../../lib/giveaway/meta-spend.js';
import {
  referralAskReach, referralParticipationGate, evaluateKillThreshold, paidReadoutLines,
} from '../../lib/giveaway/paid-readout.js';
import { getAllOrders } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const {
  listId, metaCampaignId, provisionalCostPerEntryTargetUsd,
  killThresholdEntryPurchaseRatePct,
} = config;
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
// How many entrants have actually RECEIVED the referral ask. Null when the funnel read
// failed, which is not the same as zero — see the referral gate below, which treats a
// null reach as "cannot judge" rather than as "nobody was asked".
let askReach = null;
try {
  const submitted = await listEntrantProfiles(config.entryOpensAt);
  // NOT "everyone on the list". That held under double opt-in, where Klaviyo
  // only adds a profile once the link is clicked; under flow_link the list is
  // every entrant, and this funnel would report 100% confirmed forever.
  const confirmedEmails = confirmedEmailSet(profiles, { mechanism: resolveMechanism(config) });
  const now = Date.now();
  funnel = confirmationFunnel({ submitted, confirmedEmails, now });
  askReach = referralAskReach({ submitted, confirmedEmails, now });
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
//
// The explicit window is what includes TODAY: Meta's `maximum` preset ends
// yesterday, so without this every cost-per-entry figure in the report lagged a
// full day. A null window (unparseable entryOpensAt) falls back to the old
// preset rather than dropping the spend block entirely.
const spend = await fetchCampaignSpend({
  campaignId: metaCampaignId,
  accessToken: resolveAccessToken(),
  ...(spendWindow({ entryOpensAt: config.entryOpensAt }) ?? {}),
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

// The number that decides whether to keep buying leads at all, pre-committed in
// config/giveaway.json before the data landed. Returns 'not-readable' — never a 0% kill —
// until a 30-day window has both matured and accumulated a sample worth acting on.
const kill = evaluateKillThreshold({
  cohort,
  thresholdPct: killThresholdEntryPurchaseRatePct ?? null,
});

const report = {
  funnel,
  generatedAt: new Date().toISOString(),
  stillSubscribed: subscribed,
  ...summary,
  cohort,
  ordersTruncated,
  spend: spend ?? null,
  spendGate: spendGate ?? null,
  referralAskReach: askReach,
  killThreshold: kill,
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
// Anchored to how many entrants have RECEIVED the referral ask, not to how many exist.
// The old form (`summary.total >= 50`) fired on 2026-08-22 across 88 entrants and told the
// operator to hold budget three days into a campaign whose referral email had barely sent.
// See lib/giveaway/paid-readout.js.
const referralGate = referralParticipationGate({
  reach: askReach,
  entrantsWithReferrals: summary.ladder.entrantsWithReferrals,
});
if (referralGate) gates.push(referralGate);
if (kill.verdict === 'kill') gates.push(kill.line);

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
if (kill.line) console.log(kill.line);
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
    // "referrals N" alone reads as participation and is not — it is what has been
    // CREDITED, and a rung pays only once both parties confirm. Named-but-uncredited
    // is the normal mid-campaign state, so the named count is printed beside it and
    // a 0 is spelled out rather than left to be misread as nobody trying.
    `Ladder: confirmed ${summary.ladder.confirmed}, survey ${summary.ladder.survey}, `
      + `referrals ${summary.ladder.referrals} credited across ${summary.ladder.entrantsWithReferrals} entrants`
      + ` / ${summary.ladder.referralsNamed} named`
      + (askReach === null ? '' : ` (${askReach} have received the ask)`) + `, `
      + `instagram ${summary.ladder.instagram}, upload ${summary.ladder.upload}`,
    ...(summary.ladder.referralsNamed > 0 && summary.ladder.referrals === 0
      ? [`  ${summary.ladder.referralsNamed} referral(s) named, none credited yet — a rung pays only once BOTH`
         + ` parties confirm, and reconcile.js re-evaluates nightly. See the referral audit for why each is`
         + ` waiting; this is pending, not a CTA failure.`]
      : []),
    // Spend, leads and cost per lead were previously printed to stdout only, which on a
    // cron-run script means a log file nobody reads. The digest is the only artifact
    // anyone actually sees, so the paid numbers belong in it.
    ...paidReadoutLines({ spend, funnel, kill }),
    ...(spendGate ? ['', spendGate.line] : []),
    ...(cohort ? cohortLines(cohort) : ['', 'Entry -> purchase: unavailable (Shopify read failed).']),
    '',
    ...(gates.length ? gates : ['No gates fired.']),
  ].join('\n'),
  status: 'info',
  category: 'ads',
}).catch(() => {});
