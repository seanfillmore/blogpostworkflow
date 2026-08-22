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
 * @param {{entryClosesAt:string, includeUnconfirmed:boolean, takenAt:string}} options
 */
export function buildSnapshot(profiles = [], { entryClosesAt, includeUnconfirmed, takenAt } = {}) {
  if (!entryClosesAt) throw new Error('buildSnapshot: entryClosesAt is required');
  if (!takenAt) throw new Error('buildSnapshot: takenAt is required');
  const closesMs = Date.parse(entryClosesAt);
  if (!Number.isFinite(closesMs)) throw new Error(`buildSnapshot: unparseable entryClosesAt: ${entryClosesAt}`);

  const excluded = { testProfiles: 0, unconfirmed: 0, unusable: 0 };
  const entrants = [];

  for (const p of profiles) {
    const email = norm(p.email);
    if (!email) { excluded.unusable += 1; continue; }
    if (isTestProfile(p.properties || {})) { excluded.testProfiles += 1; continue; }

    const props = p.properties || {};
    const stored = props.gv_breakdown || {};

    // Inclusive boundary: a click at the closing instant is inside the period.
    const stamp = Date.parse(props.gv_confirmed_at ?? '');
    const confirmed = Number.isFinite(stamp) && stamp <= closesMs;

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
    determinations: { drawIncludesUnconfirmedEntrants: Boolean(includeUnconfirmed) },
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
