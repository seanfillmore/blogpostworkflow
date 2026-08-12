import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildIdentities, isTestProfile, TEST_MARKER } from '../../lib/giveaway/test-identity.js';
import { ENTRY_VALUES, REFERRAL_CAP } from '../../lib/giveaway/entries.js';

const ids = buildIdentities('r1', 'someone@gmail.com');

test('all five identities are plus-aliases on the one real inbox, so every confirmation email lands together', () => {
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    assert.match(ids[k].email, /^someone\+gvtest-r1-[abcde]@gmail\.com$/, `${k} must be an alias`);
  }
  const emails = new Set(Object.values(ids).map((i) => i.email));
  assert.equal(emails.size, 5, 'the five addresses must be distinct');
});

test('A expects 24 — every positive rung plus exactly one confirmed referral', () => {
  const { base, confirm, survey, referral, instagram, upload } = ENTRY_VALUES;
  assert.equal(ids.a.expected, base + confirm + survey + instagram + upload + referral);
  assert.equal(ids.a.expected, 24, 'stated independently so a change to ENTRY_VALUES cannot silently move the target');
});

test('B expects 3: it only enters and confirms', () => {
  assert.equal(ids.b.expected, 4 - 1);
  assert.equal(ids.b.expected, 3);
});

test('C, D and E expect 1 — they must earn nothing at all', () => {
  for (const k of ['c', 'd', 'e']) assert.equal(ids[k].expected, 1, `${k} must stay at the base entry`);
});

test('only A and B are meant to confirm — leaving C unconfirmed is what proves the negative case', () => {
  assert.deepEqual(
    Object.values(ids).filter((i) => i.confirms).map((i) => i.key),
    ['a', 'b'],
  );
});

test('the referral graph is wired so each negative case is provable', () => {
  assert.equal(ids.a.referredBy, null, 'A names nobody');
  assert.equal(ids.b.referredBy, ids.a.email, 'B names A and confirms -> A earns +5');
  assert.equal(ids.c.referredBy, ids.a.email, 'C names A but never confirms -> A earns nothing more');
  assert.equal(ids.d.referredBy, ids.d.email, 'D names itself -> self-referral void');
  assert.match(ids.e.referredBy, /never-entered/, 'E names an address that never entered');
  assert.notEqual(ids.e.referredBy, ids.a.email);
});

test('every identity is marked, because Gate A refuses launch while any test profile remains', () => {
  for (const i of Object.values(ids)) {
    assert.equal(i.properties[TEST_MARKER], true);
    assert.equal(i.properties.gv_test_run, 'r1');
  }
});

test('isTestProfile recognises the marker and does not false-positive on a real entrant', () => {
  assert.equal(isTestProfile({ gv_test: true }), true);
  assert.equal(isTestProfile({ gv_entrant: true }), false);
  assert.equal(isTestProfile({}), false);
  assert.equal(isTestProfile(undefined), false);
});

test('the ladder ceiling is still 69, so the expected totals are anchored to the real rules', () => {
  const { base, confirm, survey, referral, instagram, upload } = ENTRY_VALUES;
  assert.equal(base + confirm + survey + referral * REFERRAL_CAP + instagram + upload, 69);
});
