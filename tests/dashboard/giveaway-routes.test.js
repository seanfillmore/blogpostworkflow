// tests/dashboard/giveaway-routes.test.js
// The endpoint is public and paid-for: every dropped entry is ~$2.50 of ad
// spend. These tests pin the validation and the server-authority rule.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  validateEntryPayload, mergeBreakdown, answerProperties, createEntriesHandler, entryProperties,
} from '../../agents/dashboard/routes/giveaway.js';

/** Minimal http.ServerResponse stand-in: captures status + body, nothing else. */
function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (body) => { res.body = body; };
  return res;
}

test('a client-supplied entry total is ignored — the server is the only authority', () => {
  const merged = mergeBreakdown(
    { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    { survey: true, gv_entries: 9999, referrals: 500 },
  );
  assert.equal(merged.survey, true);
  assert.equal(merged.referrals, 0, 'referrals are credited only by the reconciler, never by a request');
  assert.equal(merged.gv_entries, undefined, 'a client entry total must not survive the merge');
});

test('a missing or malformed email is a 400, not a silent drop', () => {
  assert.equal(validateEntryPayload({ email: 'a@b.com', firstName: 'A' }).ok, true);
  assert.equal(validateEntryPayload({ email: 'nope', firstName: 'A' }).ok, false);
  assert.equal(validateEntryPayload({ firstName: 'A' }).ok, false);
});

test('firstName is required, because every nurture email personalises on it', () => {
  const r = validateEntryPayload({ email: 'a@b.com' });
  assert.equal(r.ok, false);
  assert.match(r.error, /firstName/);
});

test('a self-referral in the entry payload is stripped rather than rejecting the entry', () => {
  // Losing a paid entry over a bad referral field would be the expensive
  // failure. Keep the entry, drop the referral.
  const r = validateEntryPayload({ email: 'a@b.com', firstName: 'A', referredBy: 'A@B.com' });
  assert.equal(r.ok, true);
  assert.equal(r.value.referredBy, null);
});

test('answer values outside the allowed enum are dropped, not stored', () => {
  const props = answerProperties({ household: 'martian', frustration: 'reactive' });
  assert.equal(props.gv_household, undefined, 'an unknown enum value must not reach the profile');
  assert.equal(props.gv_frustration, 'reactive');
});

test('survey answers are top-level gv_* properties, NOT keys inside the breakdown', () => {
  // A Klaviyo flow filter and a Klaviyo segment can only read a TOP-LEVEL
  // property. The nurture flow branches on gv_frustration and the daily report
  // reads gv_household / gv_frustration / gv_current_brand. Storing these inside
  // gv_breakdown made every one of those reads return empty forever, while the
  // unit tests on both sides still passed — this test pins the contract.
  const patch = { household: 'family', frustration: 'fragrance', currentBrand: 'cerave', survey: true };
  const props = answerProperties(patch);
  assert.deepEqual(props, {
    gv_household: 'family',
    gv_frustration: 'fragrance',
    gv_current_brand: 'cerave',
  });
  const breakdown = mergeBreakdown(
    { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    patch,
  );
  assert.equal(breakdown.survey, true, 'the ladder rung still lands in the breakdown');
  for (const k of ['household', 'frustration', 'currentBrand', 'gv_household', 'gv_frustration']) {
    assert.equal(breakdown[k], undefined, `${k} must not be in the breakdown`);
  }
});

test('the Instagram rung is NOT credited without a handle — +3 must be spot-checkable', () => {
  // The rung pays for a public tagged post and the handle is the only way to
  // verify one exists. `instagram: true` with no handle banks 3 entries against
  // nothing anyone can check.
  const base = { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
  assert.equal(mergeBreakdown(base, { instagram: true }).instagram, false, 'no handle, no credit');
  assert.equal(mergeBreakdown(base, { instagram: true, igHandle: '   ' }).instagram, false, 'whitespace is not a handle');
  assert.equal(mergeBreakdown(base, { instagram: true, igHandle: '@sean' }).instagram, true);
  // The handle itself is still stored (stripped of the @) as a top-level property.
  assert.equal(answerProperties({ igHandle: '@sean' }).gv_ig_handle, 'sean');
});

// --- POST /enter property building (the resubmit invariant) ---

test('a FIRST entry gets the zeroed baseline and one entry', () => {
  const props = entryProperties(null, { email: 'a@b.com', firstName: 'A', referredBy: null });
  assert.equal(props.gv_entrant, true);
  assert.deepEqual(props.gv_breakdown, { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false });
  assert.equal(props.gv_entries, 1);
  assert.equal(props.gv_referred_by, undefined);
});

test('REGRESSION: a REPEAT entry writes neither gv_breakdown nor gv_entries', () => {
  // Klaviyo REPLACES the value at a top-level property key rather than
  // deep-merging it, so re-writing the zeroed baseline wipes a confirmed,
  // surveyed, referred entrant from 11 entries back to 1. Double-submits and
  // back-button resubmissions are routine on a cold lander, so this is the
  // difference between an entrant keeping their ladder and losing it.
  const existing = { properties: {
    gv_entrant: true,
    gv_entries: 11,
    gv_breakdown: { confirmed: true, survey: true, referrals: 1, instagram: false, upload: false },
  } };
  const props = entryProperties(existing, { email: 'a@b.com', firstName: 'A', referredBy: null });
  assert.deepEqual(props, { gv_entrant: true }, 'a resubmit must touch nothing but the entrant flag');
});

test('the FIRST referrer wins — a resubmit cannot swap in a different one', () => {
  const first = entryProperties(null, { referredBy: 'one@x.com' });
  assert.equal(first.gv_referred_by, 'one@x.com');

  const existing = { properties: {
    gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    gv_referred_by: 'one@x.com',
  } };
  const second = entryProperties(existing, { referredBy: 'two@x.com' });
  assert.equal(second.gv_referred_by, undefined, 'the stored referrer must not be overwritten after the fact');

  // A profile that exists but named nobody can still pick up a referrer on a
  // later entry — the guard is "already set", not "already entered".
  const noReferrer = { properties: { gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false } } };
  assert.equal(entryProperties(noReferrer, { referredBy: 'two@x.com' }).gv_referred_by, 'two@x.com');
});

test('GET /entries answers only for actual entrants, not for anyone in Klaviyo', async () => {
  // getProfileByEmail searches the WHOLE account, so a bare profile-exists check
  // made this public, unauthenticated route an enumeration oracle: 200 meant
  // "this address is in Real Skin Care's Klaviyo", 404 meant it is not, at
  // whatever rate the caller liked, each hit proxied onto the account-wide
  // Klaviyo quota that the live customer flows share.
  const req = { url: '/api/giveaway/entries?email=test@example.com', headers: {} };

  const nonEntrant = createEntriesHandler({
    getProfileByEmail: async () => ({ id: 'P1', email: 'test@example.com', properties: { first_name: 'Sub' } }),
  });
  const res404 = makeRes();
  await nonEntrant(req, res404);
  assert.equal(res404.statusCode, 404, 'a newsletter subscriber who never entered must be indistinguishable from an unknown address');

  const entrant = createEntriesHandler({
    getProfileByEmail: async () => ({
      id: 'P2',
      email: 'test@example.com',
      properties: { gv_entries: 6, gv_breakdown: { confirmed: true, survey: true, referrals: 0, instagram: false, upload: false } },
    }),
  });
  const res200 = makeRes();
  await entrant(req, res200);
  assert.equal(res200.statusCode, 200);
  assert.equal(JSON.parse(res200.body).entries, 6);
});

test('a Klaviyo failure on GET /entries responds 502 instead of crashing the process', async () => {
  // dispatch() in agents/dashboard/lib/router.js calls the handler without
  // awaiting it, and this codebase installs no unhandledRejection hook, so an
  // un-caught throw here would terminate the whole PM2 process. This route is
  // public and unauthenticated, and klaviyoRequest throws on any non-2xx, so a
  // routine Klaviyo 5xx or rate-limit reply is enough to trigger it. Stub the
  // Klaviyo boundary to reject and prove the handler converts that into a 502
  // instead of letting the rejection escape.
  const handler = createEntriesHandler({
    getProfileByEmail: async () => { throw new Error('klaviyo 500'); },
  });
  const req = { url: '/api/giveaway/entries?email=test@example.com', headers: {} };
  const res = makeRes();

  // If the handler does not catch the rejection, awaiting it here throws and
  // this test fails outright — which is exactly what happens against the
  // un-wrapped (no try/catch) version of the handler.
  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).ok, false);
});
