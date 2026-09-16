/**
 * Freeze the entrant pool for the drawing.
 *
 * Pure: no Klaviyo, no clock, no filesystem. This function decides who is in the
 * draw and with how many entries, for a promotion with $1,072.80 of prizes and
 * entrants who can complain, so every rule in it is provable in tests.
 *
 * THE ENTRY-PERIOD GATE. reconcile.js credits a confirmation whenever it
 * happens; it has no concept of the Entry Period, and it runs at 01:30 PT on
 * Sep 15 — AFTER entries close at 23:59:59 PT on Sep 14. Left alone it would
 * credit post-close confirmations. §5 requires every entry action to be
 * completed "during the Entry Period", so entries are RECOMPUTED here from a
 * time-filtered breakdown rather than read from the stored gv_entries.
 *
 * Only the confirmation rung carries a timestamp we can check. Survey,
 * Instagram and upload have no per-rung stamp, so they are taken as stored —
 * documented rather than silently assumed, and recorded in
 * docs/giveaway-referral-lessons.md as something the next promotion should fix
 * by stamping each rung when it is credited.
 *
 * Referral credits are zeroed for an entrant who is unconfirmed AT THE CLOSE,
 * for the same reason: their stored count was earned under a confirmation the
 * gate has just rejected.
 */
import { entryTotal } from './entries.js';
import { looksSamePerson } from './email-similarity.js';
import { isTestProfile } from './test-identity.js';

const norm = (e) => String(e ?? '').trim().toLowerCase();

/**
 * @param {Array<{email:string, subscribed?:boolean, properties?:object}>} profiles
 *   Every entrant — the merged submitted-and-listed population, since the
 *   Klaviyo list alone is only the confirmed set.
 * @param {{entryClosesAt:string, includeUnconfirmed:boolean, takenAt:string,
 *          fraudWindows?:Array<{from:string,to:string,reason:string}>}} options
 */
export function buildSnapshot(profiles = [], { entryClosesAt, includeUnconfirmed, takenAt, fraudWindows = [] } = {}) {
  if (!entryClosesAt) throw new Error('buildSnapshot: entryClosesAt is required');
  if (!takenAt) throw new Error('buildSnapshot: takenAt is required');
  const closesMs = Date.parse(entryClosesAt);
  if (!Number.isFinite(closesMs)) throw new Error(`buildSnapshot: unparseable entryClosesAt: ${entryClosesAt}`);

  // Parsed once, and unparseable bounds THROW rather than silently matching
  // nothing: a disqualification window that quietly disqualified nobody would be
  // indistinguishable from a clean pool, which is the failure this is guarding.
  const windows = fraudWindows.map((w) => {
    const from = Date.parse(w.from);
    const to = Date.parse(w.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error(`buildSnapshot: unparseable fraudWindow bounds: ${w.from} .. ${w.to}`);
    }
    if (to <= from) throw new Error(`buildSnapshot: empty fraudWindow: ${w.from} .. ${w.to}`);
    return { from, to };
  });

  const excluded = { testProfiles: 0, lateEntries: 0, fraudulent: 0, unconfirmed: 0, unusable: 0 };
  const entrants = [];

  for (const p of profiles) {
    const email = norm(p.email);
    if (!email) { excluded.unusable += 1; continue; }
    if (isTestProfile(p.properties || {})) { excluded.testProfiles += 1; continue; }

    const props = p.properties || {};

    // ENTERED after the close. Nothing stops the form at the deadline and the
    // snapshot is taken about an hour later, so an entry in that hour would
    // otherwise be drawn — §8 draws only from entries "received during the Entry
    // Period". The entry route stamps gv_entered_at on a first entry; a profile
    // with no stamp is KEPT, because a missing stamp is not proof of a late entry.
    const enteredMs = Date.parse(props.gv_entered_at ?? '');
    if (Number.isFinite(enteredMs) && enteredMs > closesMs) { excluded.lateEntries += 1; continue; }

    const stored = props.gv_breakdown || {};

    // Inclusive boundary: a click at the closing instant is inside the period.
    const stamp = Date.parse(props.gv_confirmed_at ?? '');
    const confirmed = Number.isFinite(stamp) && stamp <= closesMs;

    // §5 FRAUDULENT/AUTOMATED ENTRY. An entry stamped inside a declared attack
    // window is disqualified UNLESS the entrant did something a script does not:
    // clicked the confirmation link, answered the survey, posted to Instagram,
    // uploaded a photo, or was credited a referral. A single unengaged POST is
    // the whole of what the automated cohort produced.
    //
    // The per-entrant predicate is the stamp because the user agent — where the
    // real proof lives — is forwarded to Meta's CAPI and never persisted here.
    // The window is therefore doing the accusing, so it FAILS OPEN twice over: a
    // profile with no parseable stamp is kept, and any engagement rescues.
    const engaged = confirmed
      || stored.survey === true
      || stored.instagram === true
      || stored.upload === true
      || Number(stored.referrals ?? 0) > 0;
    const inFraudWindow = Number.isFinite(enteredMs)
      && windows.some((w) => enteredMs >= w.from && enteredMs < w.to);
    if (inFraudWindow && !engaged) { excluded.fraudulent += 1; continue; }

    if (!confirmed && !includeUnconfirmed) { excluded.unconfirmed += 1; continue; }

    const breakdown = {
      confirmed,
      survey: stored.survey === true,
      instagram: stored.instagram === true,
      upload: stored.upload === true,
      referrals: confirmed ? Number(stored.referrals ?? 0) : 0,
    };

    entrants.push({
      email,
      entries: entryTotal(breakdown),
      confirmed,
      referredBy: props.gv_referred_by ? norm(props.gv_referred_by) : null,
      samePersonSuspected: props.gv_referred_by
        ? looksSamePerson(norm(props.gv_referred_by), email)
        : false,
    });
  }

  // Sorted so the committed file is diff-stable and two runs are byte-identical.
  entrants.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));

  return {
    takenAt,
    entryClosesAt,
    determinations: {
      drawIncludesUnconfirmedEntrants: Boolean(includeUnconfirmed),
      fraudWindows,
    },
    totals: {
      entrants: entrants.length,
      entries: entrants.reduce((n, e) => n + e.entries, 0),
      confirmed: entrants.filter((e) => e.confirmed).length,
      unconfirmed: entrants.filter((e) => !e.confirmed).length,
    },
    entrants,
    excluded,
  };
}
