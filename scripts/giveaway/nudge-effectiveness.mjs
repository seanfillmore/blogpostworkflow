#!/usr/bin/env node
/**
 * Is the confirmation nudge actually recovering anyone?
 *
 *   node scripts/giveaway/nudge-effectiveness.mjs
 *
 * READ ONLY. No writes, no sends, no --apply. Safe to run any time.
 *
 * WHY THIS IS THE METRIC THAT MATTERS. Confirmation gates everything downstream:
 * the +2 rung, list membership, every nurture email, referral crediting, and
 * whether we can sell to the person at all. Measured 2026-08-22: 283 submitted,
 * 77 confirmed — 73% of paid-for leads sitting behind one click.
 * scripts/giveaway/nudge-unconfirmed.mjs is the only lever on that number, and
 * until this script existed nothing said whether it worked.
 *
 * HOW IT DECIDES. gv_confirmed_at and gv_last_nudge_at are both stamps, so
 * "confirmed AFTER being nudged" is decidable per profile rather than inferred
 * from a rate. The comparison that means something is:
 *
 *   nudged and then confirmed   vs   never nudged and confirmed anyway
 *
 * It is NOT a controlled experiment — the nudge goes to everyone who is due, so
 * the never-nudged group is mostly people who confirmed within 48h of entering
 * and were never eligible. That group is therefore biased HEAVILY toward
 * confirmers, and its rate should be read as a ceiling, not a control. Stated
 * here because the obvious reading of these two numbers is the wrong one.
 *
 * WHAT WOULD CHANGE A DECISION:
 *   - post-nudge confirmations near zero      -> the nudge is not the lever;
 *                                                the opt-in email itself is.
 *   - lots of people capped at MAX_NUDGES     -> raising the cap is worth testing
 *     while still unconfirmed
 *   - lots stuck in the MIN_HOURS window at   -> 48h is too slow for a promotion
 *     close of the entry period                  this short
 */
import { readFileSync } from 'node:fs';
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

const { listEntrantProfiles, listProfilesWithConsent } = await import('../../lib/klaviyo-profiles.js');
const { MIN_HOURS_BETWEEN, MAX_NUDGES } = await import('./nudge-unconfirmed.mjs');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const [listed, submitted] = await Promise.all([
  listProfilesWithConsent(config.listId),
  listEntrantProfiles(config.entryOpensAt),
]);

const norm = (e) => String(e ?? '').trim().toLowerCase();

// WHO COUNTS AS CONFIRMED, and why it is not simply "has a gv_confirmed_at".
// That stamp is written by the nightly reconciler (08:30 UTC), not at the moment
// someone clicks. Anyone who confirmed since the last run is on the list, fully
// confirmed, and carries no stamp yet. A first draft of this script keyed on the
// stamp alone and reported 21 confirmed against a list of 81 — undercounting by
// three quarters and making the nudge look far more necessary than it is.
//
// Being on the list IS the confirmation (Klaviyo only adds after double opt-in).
// The stamp is used only for TIMING, and its absence means "confirmed, when
// unknown" rather than "not confirmed".
const confirmedSet = new Set();
const confirmedAtByEmail = new Map();
for (const p of listed) {
  const email = norm(p.email);
  const stamp = p.properties?.gv_confirmed_at;
  if (p.subscribed || stamp) confirmedSet.add(email);
  if (stamp) confirmedAtByEmail.set(email, Date.parse(stamp));
}

const now = Date.now();
const buckets = {
  neverNudgedConfirmed: 0,
  neverNudgedUnconfirmed: 0,
  nudgedThenConfirmed: 0,
  nudgedStillUnconfirmed: 0,
  // Confirmed BEFORE the nudge landed: the nudge cannot claim these, and
  // counting them as recoveries is the easiest way to flatter this number.
  confirmedBeforeNudge: 0,
  // Confirmed, but the reconciler has not stamped them yet, so the nudge can be
  // neither credited nor cleared for this one.
  nudgedConfirmedTimingUnknown: 0,
};
const blockedBy = { capped: 0, insideWindow: 0, dueNow: 0 };
let totalNudgesSent = 0;

for (const p of submitted) {
  const email = norm(p.email);
  const nudges = Number(p.properties?.gv_confirm_nudges || 0);
  totalNudgesSent += nudges;
  const isConfirmed = confirmedSet.has(email);
  const confirmedAt = confirmedAtByEmail.get(email) ?? null;
  const lastNudge = p.properties?.gv_last_nudge_at ? Date.parse(p.properties.gv_last_nudge_at) : null;

  if (!nudges) {
    if (isConfirmed) buckets.neverNudgedConfirmed += 1;
    else buckets.neverNudgedUnconfirmed += 1;
  } else if (!isConfirmed) {
    buckets.nudgedStillUnconfirmed += 1;
  } else if (confirmedAt && lastNudge) {
    if (confirmedAt > lastNudge) buckets.nudgedThenConfirmed += 1;
    else buckets.confirmedBeforeNudge += 1;
  } else {
    buckets.nudgedConfirmedTimingUnknown += 1;
  }

  if (isConfirmed) continue;
  if (nudges >= MAX_NUDGES) { blockedBy.capped += 1; continue; }
  const since = lastNudge ?? Date.parse(p.properties?.gv_entered_at ?? '');
  const hours = Number.isFinite(since) ? (now - since) / 36e5 : Infinity;
  if (hours < MIN_HOURS_BETWEEN) blockedBy.insideWindow += 1;
  else blockedBy.dueNow += 1;
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const nudgedTotal = buckets.nudgedThenConfirmed + buckets.nudgedStillUnconfirmed
  + buckets.confirmedBeforeNudge + buckets.nudgedConfirmedTimingUnknown;
const neverTotal = buckets.neverNudgedConfirmed + buckets.neverNudgedUnconfirmed;

console.log(`${submitted.length} submitted | ${listed.length} confirmed (${pct(listed.length, submitted.length)})`);
console.log(`${totalNudgesSent} nudge(s) sent across ${nudgedTotal} profile(s)\n`);

console.log('NUDGED');
console.log(`  confirmed AFTER a nudge : ${buckets.nudgedThenConfirmed}  (${pct(buckets.nudgedThenConfirmed, nudgedTotal)} of nudged)`);
console.log(`  still unconfirmed       : ${buckets.nudgedStillUnconfirmed}`);
console.log(`  confirmed before nudge  : ${buckets.confirmedBeforeNudge}  (not a recovery)`);
console.log(`  confirmed, timing n/k   : ${buckets.nudgedConfirmedTimingUnknown}  (awaiting the 08:30 UTC reconciler stamp)`);
console.log('\nNEVER NUDGED  — biased toward confirmers, read as a ceiling not a control');
console.log(`  confirmed               : ${buckets.neverNudgedConfirmed}  (${pct(buckets.neverNudgedConfirmed, neverTotal)} of never-nudged)`);
console.log(`  still unconfirmed       : ${buckets.neverNudgedUnconfirmed}`);

console.log('\nWHY THE REMAINING UNCONFIRMED ARE NOT BEING NUDGED RIGHT NOW');
console.log(`  at the ${MAX_NUDGES}-nudge cap      : ${blockedBy.capped}`);
console.log(`  inside the ${MIN_HOURS_BETWEEN}h gap      : ${blockedBy.insideWindow}`);
console.log(`  due on the next run     : ${blockedBy.dueNow}`);

if (!totalNudgesSent) {
  console.log('\nNo nudge has been delivered yet, so none of the above means anything.');
  console.log(`The gap is measured from ENTRY, so an entrant is not eligible until ${MIN_HOURS_BETWEEN}h after they entered.`);
}
