// tests/lib/giveaway-reconcile.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  planEntryUpdates, confirmedEver, confirmedEmailSet, resolveMechanism, CONFIRM_MECHANISMS,
} from '../../lib/giveaway/reconcile.js';
import { REFERRAL_CAP } from '../../lib/giveaway/entries.js';

// planEntryUpdates now receives EVERY profile on the list, each tagged with its
// current consent. `subscribed` defaults to true here (and in the function) so a
// caller handing it an already-filtered SUBSCRIBED set still behaves correctly.
// The fixtures represent the state AS STORED, which starts confirmed:false
// straight from entry.
const profile = (email, props = {}, { subscribed = true } = {}) => ({
  id: `id-${email}`,
  email,
  subscribed,
  properties: {
    gv_entrant: true,
    gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    ...props,
  },
});
const forEmail = (updates, email) => updates.find((u) => u.email === email);
const NOW = '2026-09-10T08:30:00.000Z';
const { FLOW_LINK } = CONFIRM_MECHANISMS;

test('REGRESSION: confirmation is credited — being in the SUBSCRIBED set IS the confirmation', () => {
  // Nothing in a request can know someone clicked the opt-in link, so if this
  // function does not credit it, the advertised +2 rung never pays and the
  // ladder shown on the entered page is a lie.
  const updates = planEntryUpdates([profile('a@x.com')]);
  const u = forEmail(updates, 'a@x.com');
  assert.ok(u, 'a profile stored as unconfirmed must produce an update');
  assert.equal(u.breakdown.confirmed, true);
  assert.equal(u.entries, 3, 'base 1 + confirm 2');
});

test('a confirmed entrant credits the referrer they named', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_referred_by: 'referrer@x.com' }),
  ]);
  const r = forEmail(updates, 'referrer@x.com');
  assert.equal(r.breakdown.referrals, 1);
  assert.equal(r.entries, 8, 'base 1 + confirm 2 + one referral 5');
});

test('a referrer who never ENTERED is never credited — there is no entry to credit', () => {
  const updates = planEntryUpdates([profile('friend@x.com', { gv_referred_by: 'ghost@x.com' })]);
  assert.equal(forEmail(updates, 'ghost@x.com'), undefined, 'ghost never submitted the form');
  assert.equal(forEmail(updates, 'friend@x.com').breakdown.referrals, 0);
});

test('REGRESSION: an UNCONFIRMED referrer IS credited when their friend confirms', () => {
  // §5 pays the referrer "+5 entries per confirmed friend" and conditions it on
  // the FRIEND confirming, not the referrer. Only §6's prize clause requires a
  // confirmed referrer, and that is decided at the draw. This function withheld
  // the entries §5 already granted.
  const updates = planEntryUpdates([
    // Entered, never clicked the opt-in link: no stamp, not subscribed.
    profile('pending@x.com', {}, { subscribed: false }),
    // subscribed defaults true in this fixture, which IS the confirmation.
    profile('friend@x.com', { gv_referred_by: 'pending@x.com' }),
  ], { now: NOW });

  const r = forEmail(updates, 'pending@x.com');
  assert.ok(r, 'an unconfirmed entrant who earned a referral must be updated');
  assert.equal(r.breakdown.referrals, 1);
  assert.equal(r.breakdown.confirmed, false, 'earning a referral is NOT confirming');
  assert.equal(r.entries, 1 + 5, 'base 1 + referral 5, with no +2 confirmation rung');
  assert.equal(r.confirmedAt, null, 'and nothing may stamp them as confirmed');
});

test('an unconfirmed entrant who earned NOTHING is left alone entirely', () => {
  // Only profiles that are confirmed or that earned a referral produce a write.
  // Touching every submitted profile would be 200+ pointless Klaviyo calls a night.
  const updates = planEntryUpdates([
    profile('quiet@x.com', {}, { subscribed: false }),
  ], { now: NOW });
  assert.equal(forEmail(updates, 'quiet@x.com'), undefined);
});

test('self-referral credits nobody', () => {
  const updates = planEntryUpdates([profile('solo@x.com', { gv_referred_by: 'solo@x.com' })]);
  assert.equal(forEmail(updates, 'solo@x.com').breakdown.referrals, 0);
});

test('credits stop at the cap even with more confirmed referees', () => {
  const referees = Array.from({ length: 14 }, (_, i) => profile(`f${i}@x.com`, { gv_referred_by: 'r@x.com' }));
  const updates = planEntryUpdates([profile('r@x.com'), ...referees]);
  const r = forEmail(updates, 'r@x.com');
  assert.equal(r.breakdown.referrals, REFERRAL_CAP, 'capped');
  assert.equal(r.entries, 1 + 2 + 50);
});

test('the run is idempotent — a profile already in its final state produces no update', () => {
  const stamp = '2026-09-01T08:30:00.000Z';
  const updates = planEntryUpdates([
    profile('r@x.com', { gv_breakdown: { confirmed: true, survey: false, referrals: 1, instagram: false, upload: false }, gv_confirmed_at: stamp }),
    profile('f1@x.com', { gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false }, gv_confirmed_at: stamp, gv_referred_by: 'r@x.com' }),
  ], { now: NOW });
  assert.deepEqual(updates, [], 'nothing left to change means no writes');
});

test('a first sighting stamps gv_confirmed_at, and a later run never rewrites it', () => {
  const first = planEntryUpdates([profile('a@x.com')], { now: NOW });
  assert.equal(forEmail(first, 'a@x.com').confirmedAt, NOW, 'the stamp is written on first sighting');

  // Same profile, now carrying the stamp but still missing breakdown.confirmed
  // (i.e. the write half-landed). The stamp must be carried forward verbatim,
  // not moved to today — it is the record of WHEN they confirmed.
  const later = planEntryUpdates(
    [profile('a@x.com', { gv_confirmed_at: NOW })],
    { now: '2026-09-30T08:30:00.000Z' },
  );
  assert.equal(forEmail(later, 'a@x.com').confirmedAt, NOW, 'an existing stamp is never overwritten');
});

test('REGRESSION: an entrant who confirmed then unsubscribed stays confirmed and still credits their referrer', () => {
  // Official rules §12 promises the draw snapshot is taken "independent of
  // ongoing email subscription status". Consent is point-in-time; a confirmation
  // click is history. Reading only the SUBSCRIBED set meant someone who
  // confirmed at 14:00 and unsubscribed at 16:00 vanished before the 08:30 run
  // ever saw them: their +2 was never credited, and every friend they referred
  // credited nobody. gv_confirmed_at is what makes it durable.
  const updates = planEntryUpdates([
    profile('gone@x.com', { gv_confirmed_at: '2026-09-05T14:00:00.000Z' }, { subscribed: false }),
    profile('friend@x.com', { gv_referred_by: 'gone@x.com' }),
  ], { now: NOW });

  const gone = forEmail(updates, 'gone@x.com');
  assert.ok(gone, 'an unsubscribed but previously-confirmed entrant is still reconciled');
  assert.equal(gone.breakdown.confirmed, true, 'confirmation must survive an unsubscribe');
  assert.equal(gone.breakdown.referrals, 1, 'and they still earn the referral they brought in');
  assert.equal(gone.entries, 1 + 2 + 5);
});

test('REGRESSION: a REFEREE who confirmed then unsubscribed still pays their referrer', () => {
  // The other direction of the same defect: the friend confirms at 14:00 and
  // unsubscribes at 16:00, so the 08:30 run no longer sees them in the
  // SUBSCRIBED set and the referrer's +5 silently never lands.
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_confirmed_at: '2026-09-05T14:00:00.000Z', gv_referred_by: 'referrer@x.com' }, { subscribed: false }),
  ], { now: NOW });

  const r = forEmail(updates, 'referrer@x.com');
  assert.equal(r.breakdown.referrals, 1, 'the referral was earned when the friend confirmed, not for as long as they stay subscribed');
  assert.equal(r.entries, 1 + 2 + 5);
});

test('an unsubscribed entrant already credited before the stamp existed does not regress', () => {
  // Backfill safety: runs before gv_confirmed_at existed wrote breakdown.confirmed
  // without a stamp. That stored flag is proof too, so those entrants keep their
  // +2 and only gain the stamp.
  const updates = planEntryUpdates([
    profile('legacy@x.com', {
      gv_breakdown: { confirmed: true, survey: true, referrals: 2, instagram: false, upload: false },
    }, { subscribed: false }),
  ], { now: NOW });

  const u = forEmail(updates, 'legacy@x.com');
  assert.equal(u.breakdown.confirmed, true);
  assert.equal(u.breakdown.referrals, 2, 'the never-decrease guarantee holds for an unsubscriber');
  assert.equal(u.confirmedAt, NOW, 'the missing stamp is backfilled');
});

test('someone who NEVER confirmed never earns the +2 confirmation rung', () => {
  // Pending double opt-in, or unsubscribed without ever clicking: no stamp, no
  // stored confirmed flag, not currently subscribed. Paying the +2 here would
  // credit the rung for doing nothing.
  //
  // NOTE what this test no longer claims. It used to assert that such a profile
  // "credits nobody" — i.e. that an unconfirmed REFERRER earns no +5. That was
  // stricter than the published rules: §5 conditions the +5 on the FRIEND
  // confirming, and only §6's prize clause requires a confirmed referrer. The
  // referral half now has its own regression test above.
  const updates = planEntryUpdates([
    profile('pending@x.com', {}, { subscribed: false }),
    profile('friend@x.com', { gv_referred_by: 'pending@x.com' }),
  ], { now: NOW });

  const pending = forEmail(updates, 'pending@x.com');
  assert.equal(pending.breakdown.confirmed, false, 'no +2 for a profile that never confirmed');
  assert.equal(pending.breakdown.referrals, 1, 'but the referral their friend generated IS theirs');
  assert.equal(pending.entries, 1 + 5, 'base 1 + referral 5 — no confirmation rung');
  assert.equal(pending.confirmedAt, null, 'and nothing stamps them confirmed');
});

test('other rungs already earned are preserved, not reset', () => {
  const updates = planEntryUpdates([
    profile('a@x.com', { gv_breakdown: { confirmed: false, survey: true, referrals: 0, instagram: true, upload: true } }),
  ]);
  const u = forEmail(updates, 'a@x.com');
  assert.equal(u.breakdown.survey, true);
  assert.equal(u.breakdown.upload, true);
  assert.equal(u.entries, 1 + 2 + 3 + 3 + 10, 'crediting confirmation must not clobber survey/instagram/upload');
});

test('matching is case-insensitive, so a mixed-case referral field still pays', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_referred_by: 'ReFerrer@X.com' }),
  ]);
  assert.equal(forEmail(updates, 'referrer@x.com').breakdown.referrals, 1);
});

// ---------------------------------------------------------------------------
// FLOW_LINK mechanism — the list is SINGLE opt-in and subscription proves nothing.
//
// Every test above holds `subscribed: true` to mean "clicked the double-opt-in
// link", because under DOUBLE_OPT_IN that is literally the only way onto the
// list. Under FLOW_LINK an entrant is subscribed the instant they submit the
// form, so that inference becomes false for EVERY entrant at once — which is
// exactly the shape of bug that quietly pays a rung nobody earned.
// ---------------------------------------------------------------------------

test('FLOW_LINK: being subscribed is NOT confirmation — the +2 is withheld until the link is clicked', () => {
  // The whole point of the cutover. Under DOUBLE_OPT_IN this same fixture earns
  // 3 entries (see the first test in this file); under FLOW_LINK it must earn 1.
  const updates = planEntryUpdates([profile('a@x.com')], { now: NOW, mechanism: FLOW_LINK });
  const u = forEmail(updates, 'a@x.com');
  assert.equal(u, undefined, 'nothing earned, nothing written — the profile is left alone');
});

test('FLOW_LINK: the confirmation link writes gv_confirmed as the STRING "true", and that counts', () => {
  // update_property_link takes its value as a quoted literal, so the property
  // arrives as the string 'true', never a boolean. Testing only for `=== true`
  // would reject every real confirmation while passing every unit test written
  // with a boolean fixture.
  const updates = planEntryUpdates([
    profile('a@x.com', { gv_confirmed: 'true' }),
  ], { now: NOW, mechanism: FLOW_LINK });
  const u = forEmail(updates, 'a@x.com');
  assert.equal(u.breakdown.confirmed, true);
  assert.equal(u.entries, 3, 'base 1 + confirm 2');
  assert.equal(u.confirmedAt, NOW, 'first sighting stamps the durable record');
});

test('FLOW_LINK: a boolean gv_confirmed counts too', () => {
  const updates = planEntryUpdates([
    profile('a@x.com', { gv_confirmed: true }),
  ], { now: NOW, mechanism: FLOW_LINK });
  assert.equal(forEmail(updates, 'a@x.com').breakdown.confirmed, true);
});

test('FLOW_LINK: a stray gv_confirmed value is not confirmation', () => {
  // A hand-edited profile, a CSV import, or a mistyped flow action must not be
  // able to pay the rung. Only the two spellings the link itself produces count.
  for (const value of ['false', false, '', 'yes', 1, null]) {
    const updates = planEntryUpdates([
      profile('a@x.com', { gv_confirmed: value }),
    ], { now: NOW, mechanism: FLOW_LINK });
    assert.equal(forEmail(updates, 'a@x.com'), undefined, `gv_confirmed=${JSON.stringify(value)} must not confirm`);
  }
});

test('FLOW_LINK: entrants who confirmed under DOUBLE_OPT_IN keep their confirmation across the cutover', () => {
  // The stamp is the durable record and it predates the mechanism switch. If the
  // cutover dropped it, every already-confirmed entrant would lose 2 entries
  // overnight and every referral they generated would stop paying.
  const updates = planEntryUpdates([
    profile('stamped@x.com', { gv_confirmed_at: '2026-08-20T00:00:00.000Z' }, { subscribed: false }),
    profile('legacy@x.com', {
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }, { subscribed: false }),
  ], { now: NOW, mechanism: FLOW_LINK });

  const stamped = forEmail(updates, 'stamped@x.com');
  assert.equal(stamped.breakdown.confirmed, true, 'the stamp still proves confirmation after the cutover');
  assert.equal(stamped.entries, 3, 'base 1 + confirm 2 — the +2 is not stripped by the switch');
  assert.equal(
    stamped.confirmedAt, '2026-08-20T00:00:00.000Z',
    'and the original stamp is carried forward verbatim, never rewritten to now',
  );

  assert.equal(forEmail(updates, 'legacy@x.com').breakdown.confirmed, true, 'a pre-stamp credit does not regress');
});

test('FLOW_LINK: an unconfirmed subscriber does not pay the referrer they named', () => {
  // §5 pays +5 per friend "who confirms their own entry". Under FLOW_LINK every
  // entrant is subscribed, so reading subscription as confirmation would pay
  // this rung for every form submission — inflating the referral half of the
  // ladder for the whole promotion, not just the +2.
  const updates = planEntryUpdates([
    profile('referrer@x.com', { gv_confirmed: 'true' }),
    profile('friend@x.com', { gv_referred_by: 'referrer@x.com' }),
  ], { now: NOW, mechanism: FLOW_LINK });

  const r = forEmail(updates, 'referrer@x.com');
  assert.equal(r.breakdown.referrals, 0, 'the friend submitted but never confirmed');
  assert.equal(r.entries, 3, 'base 1 + own confirm 2 — no referral');
});

test('FLOW_LINK: a confirmed friend DOES pay their referrer', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com', { gv_confirmed: 'true' }),
    profile('friend@x.com', { gv_referred_by: 'referrer@x.com', gv_confirmed: 'true' }),
  ], { now: NOW, mechanism: FLOW_LINK });
  assert.equal(forEmail(updates, 'referrer@x.com').entries, 8, 'base 1 + confirm 2 + referral 5');
});

test('FLOW_LINK: confirmation survives a later unsubscribe, exactly as under DOUBLE_OPT_IN', () => {
  // Rules §12 — the draw snapshot is independent of ongoing subscription status.
  const updates = planEntryUpdates([
    profile('a@x.com', { gv_confirmed: 'true' }, { subscribed: false }),
  ], { now: NOW, mechanism: FLOW_LINK });
  assert.equal(forEmail(updates, 'a@x.com').breakdown.confirmed, true);
});

test('the mechanism defaults to DOUBLE_OPT_IN, so an un-updated caller keeps today’s behaviour', () => {
  // Cutover safety: this library ships BEFORE the Klaviyo list is flipped, and
  // any caller that has not passed a mechanism yet must behave as it did.
  assert.equal(confirmedEver({ email: 'a@x.com', subscribed: true, properties: {} }), true);
  assert.equal(
    confirmedEver({ email: 'a@x.com', subscribed: true, properties: {} }, { mechanism: FLOW_LINK }),
    false,
  );
});

test('confirmedEmailSet replaces the "subscribed means confirmed" filter under both mechanisms', () => {
  const profiles = [
    profile('clicked@x.com', { gv_confirmed: 'true' }),
    profile('submitted@x.com'), // subscribed, never clicked
    profile('stamped@x.com', { gv_confirmed_at: '2026-08-20T00:00:00.000Z' }, { subscribed: false }),
  ];

  const doi = confirmedEmailSet(profiles);
  assert.deepEqual([...doi].sort(), ['clicked@x.com', 'stamped@x.com', 'submitted@x.com'],
    'under double opt-in, being on the list IS the click');

  const flow = confirmedEmailSet(profiles, { mechanism: FLOW_LINK });
  assert.deepEqual([...flow].sort(), ['clicked@x.com', 'stamped@x.com'],
    'under flow-link, the submitted-but-unclicked entrant is NOT confirmed');
});

test('confirmedEmailSet skips unusable rows instead of throwing the whole run', () => {
  const set = confirmedEmailSet([{ email: 'not-an-email', properties: {} }, profile('ok@x.com')]);
  assert.deepEqual([...set], ['ok@x.com']);
});

test('resolveMechanism defaults to double opt-in and rejects a typo', () => {
  assert.equal(resolveMechanism({}), CONFIRM_MECHANISMS.DOUBLE_OPT_IN);
  assert.equal(resolveMechanism({ confirmMechanism: 'flow_link' }), FLOW_LINK);
  assert.throws(() => resolveMechanism({ confirmMechanism: 'flowlink' }), /unknown confirm mechanism/i);
});

test('an unknown mechanism throws rather than silently picking one', () => {
  // The two mechanisms disagree about every entrant on the list. A typo in
  // config must not resolve to whichever branch happens to be the default.
  assert.throws(
    () => planEntryUpdates([profile('a@x.com')], { mechanism: 'single_opt_in' }),
    /unknown confirm mechanism/i,
  );
});
