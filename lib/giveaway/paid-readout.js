/**
 * The paid-acquisition half of the daily giveaway report: what the ads bought,
 * what it cost at each step, and whether the campaign has earned its budget.
 *
 * WHY THIS EXISTS. Every number here was already computed by scripts/giveaway/report.mjs
 * and then printed to stdout only. The script runs from cron, so "printed" means
 * data/reports/scheduler/giveaway-report.log, which nobody reads — the same reason the
 * gates were moved into notify() in the first place. The notify body carried entrants,
 * entries, survey mix, ladder and cohort, and NOT spend, NOT cost per lead, NOT the
 * confirmation funnel. So the one question a paid campaign exists to answer was absent
 * from the only artifact anyone actually reads.
 *
 * Pure: no Klaviyo, no Meta, no Shopify, no clock except an injected `now`. Everything
 * here decides whether to keep spending real money, so it is provable in tests rather
 * than discovered in production.
 */
import { CONFIRM_MATURITY_HOURS } from './summarize.js';
import { FLOW_DELAYS_HOURS } from './nurture-schedule.js';

/**
 * How long after SUBMISSION an entrant has certainly been asked to refer someone.
 *
 * The referral ask is 02-referral.html, which the nurture flow sends
 * FLOW_DELAYS_HOURS[1] after the entrant CONFIRMS — and confirmation is itself some
 * unknown time after submission. Klaviyo's list-profiles endpoint does not hand back a
 * confirmation timestamp (only `gv_entered_at`, the submission), so the exact per-entrant
 * ask time is not knowable from the data this report already holds.
 *
 * CONFIRM_MATURITY_HOURS + the flow delay is therefore used as a conservative bound: an
 * entrant who submitted this long ago and is confirmed has almost certainly received the
 * ask, because the confirmation nudge has had its full first chance and the flow delay
 * has run on top of it. Someone who confirmed unusually late is counted as not-yet-asked,
 * which UNDERSTATES reach and can only delay the gate — never fire it early. That
 * direction is the whole point; see referralParticipationGate.
 *
 * Derived from the two constants rather than written as 96, so that moving either the
 * nudge cadence or the flow delay moves this with it instead of silently desynchronising.
 */
export const REFERRAL_ASK_HOURS = CONFIRM_MATURITY_HOURS + FLOW_DELAYS_HOURS[1];

/**
 * Minimum matured 30-day entrants before a kill verdict is allowed to mean anything.
 *
 * The threshold this guards is a low single-digit percentage, so a small sample cannot
 * distinguish "does not convert" from "has not converted YET". At a true 1.5% rate,
 * seeing zero purchasers out of 30 matured entrants happens about 63% of the time — that
 * is a coin flip being reported as a verdict. At 100 it is about 22%, which is still not
 * proof but is enough for the number to be worth a human decision, which is all this
 * gate claims to produce.
 */
export const KILL_MIN_MATURED = 100;

/**
 * How many entrants have certainly been asked to refer someone.
 *
 * @param {{email:string, properties?:object}[]} submitted everyone who submitted the form
 * @param {Set<string>} confirmedEmails lowercase emails on the list
 * @param {number} now epoch ms
 * @returns {number}
 */
export function referralAskReach({
  submitted = [], confirmedEmails = new Set(), now = Date.now(),
  hours = REFERRAL_ASK_HOURS,
} = {}) {
  let reached = 0;
  for (const p of submitted) {
    if (!confirmedEmails.has(String(p.email || '').toLowerCase().trim())) continue;
    const t = Date.parse(p.properties?.gv_entered_at ?? '');
    // Undateable entrants are never assumed asked, for the same reason
    // confirmationFunnel never assumes them mature.
    if (!Number.isFinite(t)) continue;
    if ((now - t) / 3_600_000 >= hours) reached += 1;
  }
  return reached;
}

/**
 * Zero-referral participation is only a finding once people have been ASKED.
 *
 * THE BUG THIS REPLACES. The gate was `entrants >= 50 && entrantsWithReferrals === 0`,
 * and on 2026-08-22 it fired on 88 entrants and told the operator "rework the nurture CTA,
 * do not raise budget". That instruction was wrong in both halves. The ads had been
 * delivering for three days; the referral ask lands two days after a confirmation that is
 * itself up to two days after entry, so almost nobody had been asked yet. Only 8 of 316
 * submissions had even touched the optional referrer field on the form, and the referral
 * audit classified all 8 as pending rather than failed (7 referee_unconfirmed, 1
 * referrer_missing — both of which reconcile.js re-evaluates nightly and pays the moment
 * the other half confirms).
 *
 * So the gate was reading the campaign's own youth as a broken CTA, and the remedy it
 * named — hold budget — was the opposite of what the cost per lead supported. Counting
 * only entrants who have actually received the ask makes the denominator mean what the
 * gate always assumed it meant.
 */
export function referralParticipationGate({ reach, entrantsWithReferrals, minReach = 50 } = {}) {
  if (!Number.isFinite(reach) || reach < minReach) return null;
  if (entrantsWithReferrals > 0) return null;
  return `GATE: zero referral participation across ${reach} entrant(s) who have received the `
    + `referral ask (${REFERRAL_ASK_HOURS}h+ since entry, confirmed) — rework the nurture CTA. `
    + `This is now a CTA finding, not a timing artifact.`;
}

/**
 * Has the campaign cleared the entry->purchase rate that justifies buying leads at all?
 *
 * MEASURED ON THE NEW SEGMENT, NEVER THE BLEND. An existing customer who enters and then
 * buys would have repurchased anyway at the ~18-22.5% baseline, so folding them in makes
 * the giveaway look like it converts far better than it acquires — and the whole purpose
 * of this number is to decide whether to keep PAYING for strangers. See cohort.js, which
 * splits the segments for exactly this reason and whose entryValue() defaults the same way.
 *
 * Returns a verdict, never a bare boolean: 'kill' and 'ok' both require a matured window
 * AND a sample big enough to tell them apart, and everything short of that is
 * 'not-readable' rather than a 0% that would read as total failure on day three.
 */
export function evaluateKillThreshold({ cohort, thresholdPct, window = 30 } = {}) {
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return { verdict: 'not-readable', rate: null, matured: 0, line: null };
  }
  const w = cohort?.segments?.new?.windows?.[window];
  const matured = w?.matured ?? 0;

  if (!matured) {
    return {
      verdict: 'not-readable',
      rate: null,
      matured: 0,
      line: `Kill threshold (${thresholdPct}% of NEW entrants buying within ${window}d): not readable — `
        + `${w?.note ?? 'no entrant has matured yet'}.`,
    };
  }
  if (matured < KILL_MIN_MATURED) {
    return {
      verdict: 'not-readable',
      rate: w.rate,
      matured,
      line: `Kill threshold (${thresholdPct}%): ${w.purchasers}/${matured} new entrants bought within `
        + `${window}d = ${w.rate}%, but ${matured} is below the ${KILL_MIN_MATURED} needed to tell a real `
        + `rate from noise. Directional only — do not act on it yet.`,
    };
  }

  const over = w.rate >= thresholdPct;
  return {
    verdict: over ? 'ok' : 'kill',
    rate: w.rate,
    matured,
    line: over
      ? `Kill threshold OK: ${w.rate}% of ${matured} matured NEW entrants bought within ${window}d, `
        + `against a ${thresholdPct}% floor.`
      : `GATE — KILL THRESHOLD BREACHED: only ${w.rate}% of ${matured} matured NEW entrants bought within `
        + `${window}d, below the ${thresholdPct}% floor set in config/giveaway.json. The giveaway is buying `
        + `sweepstakes entrants rather than customers. Stop the campaign or change the offer — do not `
        + `raise budget.`,
  };
}

const money = (n) => `$${n.toFixed(2)}`;
const per = (spend, n) => (n > 0 ? money(spend / n) : 'n/a');

/**
 * The block that goes in the daily digest: spend in, leads out, cost at each step.
 *
 * Reports Meta's lead count and the site's own submission count SEPARATELY rather than
 * reconciling them, because they are different measurements and their gap is itself the
 * signal — Meta attributes on 7-day click / 1-day view and counts a Lead at form submit,
 * while `submitted` is every entry the site actually recorded from any source, paid or not.
 */
export function paidReadoutLines({ spend, funnel, kill } = {}) {
  if (!spend) return ['', 'Paid (Meta): unavailable — could not read the campaign.'];
  if (spend.error) return ['', `Paid (Meta): unavailable — ${spend.error}`];
  if (!(spend.spend > 0)) return ['', 'Paid (Meta): no spend recorded yet.'];

  const out = ['', 'Paid (Meta) — what the ads bought:'];
  out.push(`  spend ${money(spend.spend)} · ${spend.impressions} impressions`
    + (spend.leads ? ` · ${spend.leads} leads · ${per(spend.spend, spend.leads)}/lead` : ' · no leads attributed yet'));

  if (funnel) {
    const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
    out.push(`  site funnel: ${funnel.submitted} submitted -> ${funnel.confirmed} confirmed `
      + `(${pct(funnel.matured.rate ?? funnel.confirmationRate)}${funnel.matured.rate == null ? ' raw' : ' matured'})`);
    // The number that actually sets the CAC ceiling. A submission that never confirms
    // cannot be emailed, nurtured, or credited as a referrer, so it is not a lead you own.
    out.push(`  cost per submission ${per(spend.spend, funnel.submitted)} · `
      + `per CONFIRMED ${per(spend.spend, funnel.confirmed)}`);
  }

  if (kill?.line) out.push(`  ${kill.line}`);
  return out;
}

export default {
  REFERRAL_ASK_HOURS,
  KILL_MIN_MATURED,
  referralAskReach,
  referralParticipationGate,
  evaluateKillThreshold,
  paidReadoutLines,
};
