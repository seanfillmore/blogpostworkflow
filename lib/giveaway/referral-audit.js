/**
 * Classify every referral pair by WHY it is not paying, so the nightly run can
 * tell the reachable half of each pair what would fix it.
 *
 * WHAT THIS DELIBERATELY CANNOT DO: change gv_referred_by. Official Rules §5
 * says referral "is identified solely by the referrer's email address entered in
 * that field", and §6 awards a second $536.40 prize to the referrer "named at
 * the time of entry". Rewriting the field after entry defeats both, and the only
 * modification power the rules grant Sponsor (§13) is conditioned on "fraud,
 * technical failure, or any other factor beyond Sponsor's reasonable control" —
 * an entrant's typo is none of those. So a near-miss is REPORTED and never
 * repaired. Prevention lives at entry time instead, in the entry form, while the
 * typed value is still the value being typed.
 *
 * WHAT MAKES IT WORTH RUNNING: reconcile.js re-evaluates referrer eligibility on
 * every nightly pass, so a referrer who has not entered YET is pending rather
 * than dead — the credit lands the moment they enter and confirm. That turns the
 * largest failure bucket into an acquisition prompt instead of a dead field.
 *
 * WHO CAN BE TOLD. Klaviyo will not deliver marketing email to a profile that
 * has not consented, which is the entire population of unconfirmed entrants. So
 * every status where the blocked party is the unconfirmed one resolves to
 * notify:null and is handled by scripts/giveaway/nudge-unconfirmed.mjs, whose
 * re-issued opt-in is a consent request rather than marketing.
 *
 * Pure: no Klaviyo, no clock, no randomness. Every rule below decides who
 * receives real email about a real prize, so it is provable in tests rather than
 * discovered in production.
 */
import { normalizeEmail } from './entries.js';
import { confirmedEver, CONFIRM_MECHANISMS } from './reconcile.js';
import { looksSamePerson, nearestWithin } from './email-similarity.js';

/** Statuses whose blocked party is the REFEREE, who is confirmed and reachable. */
const NOTIFIABLE = new Set(['referrer_missing', 'referrer_unconfirmed']);

/**
 * Union of everyone who SUBMITTED with everyone on the LIST.
 *
 * Klaviyo adds a profile to the giveaway list only once double opt-in
 * completes, so the list IS the confirmed set — measured 2026-08-22: 278
 * submitted, 77 on the list, 77 of 77 subscribed. Classifying from the list
 * alone therefore cannot see an unconfirmed entrant at all, which hid 6 of 7
 * referral pairs and made the `referee_unconfirmed` branch unreachable in
 * production despite being covered by tests.
 *
 * The `subscribed` flag is the load-bearing part. listEntrantProfiles does not
 * return one and confirmedEver treats a MISSING flag as true, so a naive merge
 * would mark all 278 submitted profiles confirmed. A profile absent from the
 * list is explicitly subscribed:false; the listed copy always wins, because it
 * is the one carrying real consent.
 *
 * @param {Array<{email:string, subscribed?:boolean, properties?:object}>} listed
 * @param {Array<{email:string, properties?:object}>} submitted
 */
export function mergeEntrantProfiles(listed = [], submitted = []) {
  const norm = (e) => String(e ?? '').trim().toLowerCase();
  const out = new Map();
  for (const p of submitted) {
    const email = norm(p.email);
    if (!email) continue;
    out.set(email, { ...p, email, subscribed: false });
  }
  for (const p of listed) {
    const email = norm(p.email);
    if (!email) continue;
    out.set(email, { ...p, email });
  }
  return [...out.values()];
}

/**
 * @param {Array<{email:string, properties:object, subscribed?:boolean}>} profiles
 *   Every profile on the giveaway list, regardless of current consent — the same
 *   input planEntryUpdates takes, for the same reason (confirmation is durable,
 *   consent is not).
 * @returns {Array<{referee:string, namedRaw:string, namedReferrer:string|null,
 *   status:string, suggestion:{email:string,distance:number,confirmedBeforeEntry:boolean}|null,
 *   notify:'referee'|null, reason:string}>} one row per referral pair, in input order.
 */
export function classifyReferrals(profiles = [], { mechanism = CONFIRM_MECHANISMS.DOUBLE_OPT_IN } = {}) {
  const byEmail = new Map();
  const confirmedEmails = [];
  for (const p of profiles) {
    let email;
    try { email = normalizeEmail(p.email); } catch { continue; }
    byEmail.set(email, p);
    if (confirmedEver(p, { mechanism })) confirmedEmails.push(email);
  }
  const confirmedSet = new Set(confirmedEmails);

  const rows = [];
  for (const p of profiles) {
    const namedRaw = p.properties?.gv_referred_by;
    if (!namedRaw) continue;

    let referee;
    try { referee = normalizeEmail(p.email); } catch { continue; }

    const row = {
      referee,
      namedRaw,
      namedReferrer: null,
      status: null,
      suggestion: null,
      notify: null,
      // Advisory, never disqualifying. See looksSamePerson below.
      samePersonSuspected: false,
      reason: '',
    };

    let named;
    try { named = normalizeEmail(namedRaw); } catch {
      // A hand-edited profile or a bad import must not take the nightly run down.
      rows.push({ ...row, status: 'referrer_unparseable', reason: 'the referrer field is not a usable email address' });
      continue;
    }
    row.namedReferrer = named;

    if (named === referee) {
      // The unambiguous §6 case, and the only one validateReferral blocks too:
      // naming the very address you entered with. One person holding TWO
      // addresses is a different question, handled just below.
      rows.push({ ...row, status: 'self_referral', reason: 'the entrant named their own address — void under §6' });
      continue;
    }

    // ADVISORY ONLY, by operator determination 2026-08-22: two addresses
    // belonging to one person are still a valid referral here.
    //
    // Suppressing on this heuristic put the audit at odds with the payment
    // path, which is the thing that actually pays: reconcile.js →
    // validateReferral blocks only an EXACT address match and has never
    // implemented §6's "any other entry you control". So a pair flagged here
    // was being denied its email while still being credited.
    //
    // The flag is kept because §6's PRIZE half reads "any email address Sponsor
    // determines resolves to the same person", and that determination happens at
    // the draw on a $536.40 second prize. Dropping the signal would leave
    // nothing to determine from.
    row.samePersonSuspected = looksSamePerson(named, referee);

    if (!confirmedEver(p, { mechanism })) {
      rows.push({ ...row, status: 'referee_unconfirmed', reason: 'this entrant has not confirmed, so the referral cannot pay and they cannot be emailed' });
      continue;
    }
    if (confirmedSet.has(named)) {
      rows.push({ ...row, status: 'creditable', reason: 'nothing is wrong — reconcile.js pays this on its next pass' });
      continue;
    }
    if (byEmail.has(named)) {
      rows.push({ ...row, status: 'referrer_unconfirmed', reason: 'the named referrer entered but has not confirmed their email' });
      continue;
    }

    const hit = nearestWithin(named, confirmedEmails.filter((e) => e !== referee));
    if (hit) {
      const candidate = byEmail.get(hit.email);
      const enteredAt = Date.parse(p.properties?.gv_entered_at ?? '');
      const candidateConfirmedAt = Date.parse(candidate?.properties?.gv_confirmed_at ?? '');
      rows.push({
        ...row,
        status: 'referrer_near_miss',
        // Recorded, not acted on. §5 makes the typed value the identifier, so
        // this is evidence for a human, never an instruction to rewrite.
        suggestion: {
          email: hit.email,
          distance: hit.distance,
          confirmedBeforeEntry: Number.isFinite(enteredAt) && Number.isFinite(candidateConfirmedAt)
            ? candidateConfirmedAt <= enteredAt
            : false,
        },
        reason: `the typed address is ${hit.distance} edit(s) from confirmed entrant ${hit.email}, which §5 does not permit us to correct`,
      });
      continue;
    }

    rows.push({ ...row, status: 'referrer_missing', reason: 'nobody by that address has entered yet — the credit lands if they enter and confirm' });
  }

  // Consent decides delivery, separately from what the row says is wrong.
  for (const row of rows) {
    const referee = byEmail.get(row.referee);
    if (NOTIFIABLE.has(row.status) && referee?.subscribed !== false) row.notify = 'referee';
  }
  return rows;
}

/** Roll the rows up for the report and the daily digest. */
export function summarizeAudit(rows = []) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return { pairs: rows.length, byStatus, notifiable: rows.filter((r) => r.notify).length };
}
