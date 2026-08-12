// tests/lib/klaviyo-profiles.test.js
// Klaviyo is stubbed at the fetch boundary. These tests assert the request
// SHAPES we send, because a wrong pointer or a missing relationship block is
// the failure mode that costs an afternoon against a live API.
import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';

const realFetch = globalThis.fetch;
let calls = [];

function stubFetch(responder) {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method, body });
    const { status = 200, json = {} } = responder({ url: String(url), method: opts.method, body }) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(),
      text: async () => JSON.stringify(json),
    };
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// These four tests replace one that asserted the payload Klaviyo actually
// REJECTS. It stubbed a 202 and asserted `profile.attributes.properties`, so it
// passed forever while every live POST /enter 502'd:
//   400: 'first_name' is not a valid field for the resource 'profile'.
//        @ /data/attributes/profiles/data/0/attributes/first_name
//        'properties' is not a valid field for the resource 'profile'.
// Bulk-subscribe permits ONLY email, phone_number, subscriptions and
// age_gated_date_of_birth. Profile data belongs on POST /profile-import/, which
// upserts. A stubbed 2xx can never surface that 400, so the shape assertions
// below are the only thing standing between us and a repeat.
test('subscribeToList upserts the profile BEFORE requesting consent', async () => {
  stubFetch(() => ({ status: 200, json: { data: { id: 'P1' } } }));
  const { subscribeToList } = await import('../../lib/klaviyo-profiles.js');

  await subscribeToList('ABC123', {
    email: '  Sean@Example.COM ',
    firstName: 'Sean',
    properties: { gv_entrant: true, gv_entries: 1 },
  });

  assert.equal(calls.length, 2, 'an upsert and a subscribe — profile data cannot ride along on the subscribe');
  assert.match(calls[0].url, /profile-import/, 'the upsert must come first: consent triggers the opt-in email, and it must not go out before first_name exists');
  assert.match(calls[1].url, /profile-subscription-bulk-create-jobs/);
});

test('the upsert carries first_name and properties, normalised', async () => {
  stubFetch(() => ({ status: 200, json: { data: { id: 'P1' } } }));
  const { subscribeToList } = await import('../../lib/klaviyo-profiles.js');

  await subscribeToList('ABC123', {
    email: '  Sean@Example.COM ',
    firstName: 'Sean',
    properties: { gv_entrant: true, gv_entries: 1 },
  });

  const { attributes } = calls[0].body.data;
  assert.equal(calls[0].body.data.type, 'profile');
  assert.equal(attributes.email, 'sean@example.com', 'email must be normalised before it reaches Klaviyo');
  assert.equal(attributes.first_name, 'Sean');
  assert.equal(attributes.properties.gv_entrant, true);
  assert.equal(attributes.properties.gv_entries, 1);
});

test('the subscribe job carries NOTHING Klaviyo rejects — this is the assertion that would have caught the 502', async () => {
  stubFetch(() => ({ status: 200, json: { data: { id: 'P1' } } }));
  const { subscribeToList } = await import('../../lib/klaviyo-profiles.js');

  await subscribeToList('ABC123', {
    email: 'sean@example.com',
    firstName: 'Sean',
    properties: { gv_entrant: true },
  });

  const profile = calls[1].body.data.attributes.profiles.data[0];
  assert.deepEqual(
    Object.keys(profile.attributes).sort(),
    ['email', 'subscriptions'],
    'ONLY email and subscriptions. first_name or properties here is a hard 400 from Klaviyo.',
  );
  assert.equal(profile.attributes.email, 'sean@example.com');
  assert.equal(
    profile.attributes.subscriptions.email.marketing.consent,
    'SUBSCRIBED',
    'consent must be requested so the list double-opt-in flow fires',
  );
  assert.equal(calls[1].body.data.relationships.list.data.id, 'ABC123');
});

test('a profile with no firstName still upserts, without sending a null first_name', async () => {
  stubFetch(() => ({ status: 200, json: { data: { id: 'P1' } } }));
  const { subscribeToList } = await import('../../lib/klaviyo-profiles.js');

  await subscribeToList('ABC123', { email: 'sean@example.com' });

  assert.equal(calls.length, 2);
  assert.ok(!('first_name' in calls[0].body.data.attributes), 'a null first_name would overwrite a real one on a resubmit');
});

test('listSubscribedProfiles excludes unconfirmed profiles and follows pagination', async () => {
  // Membership of the SUBSCRIBED set is what later tasks treat as proof of a
  // double-opt-in click, so an UNCONFIRMED profile leaking through would credit
  // bonus entries nobody earned.
  const sub = (consent) => ({ email: { marketing: { consent } } });
  let page = 0;
  stubFetch(() => {
    page += 1;
    return page === 1
      ? { json: {
          data: [
            { id: 'p1', attributes: { email: 'confirmed@b.com', properties: { gv_entries: 3 }, subscriptions: sub('SUBSCRIBED') } },
            { id: 'p2', attributes: { email: 'pending@b.com', properties: {}, subscriptions: sub('UNCONFIRMED') } },
          ],
          links: { next: 'https://a.klaviyo.com/api/next-page' },
        } }
      : { json: {
          data: [{ id: 'p3', attributes: { email: 'page2@b.com', properties: {}, subscriptions: sub('SUBSCRIBED') } }],
          links: {},
        } };
  });
  const { listSubscribedProfiles } = await import('../../lib/klaviyo-profiles.js');

  const out = await listSubscribedProfiles('ABC123');
  assert.deepEqual(
    out.map((p) => p.email),
    ['confirmed@b.com', 'page2@b.com'],
    'UNCONFIRMED must be dropped and page 2 must be included',
  );
  assert.match(decodeURIComponent(calls[0].url), /additional-fields\[profile\]=subscriptions/);
  // Verified live 2026-08-11: this endpoint 400s on a consent filter.
  assert.doesNotMatch(calls[0].url, /filter=/, 'must not send a filter this endpoint rejects');
});

test('listProfilesWithConsent returns EVERY member tagged with its consent, and follows pagination', async () => {
  // Confirmation must survive an unsubscribe (official rules §12), so the
  // reconciler needs the unsubscribed members too — with enough information to
  // tell who is NEWLY confirmed. Dropping them here is what left a confirm-then-
  // unsubscribe entrant uncredited forever.
  const sub = (consent) => ({ email: { marketing: { consent } } });
  let page = 0;
  stubFetch(() => {
    page += 1;
    return page === 1
      ? { json: {
          data: [
            { id: 'p1', attributes: { email: 'in@b.com', properties: { gv_entries: 3 }, subscriptions: sub('SUBSCRIBED') } },
            { id: 'p2', attributes: { email: 'out@b.com', properties: {}, subscriptions: sub('UNSUBSCRIBED') } },
          ],
          links: { next: 'https://a.klaviyo.com/api/next-page' },
        } }
      : { json: {
          data: [{ id: 'p3', attributes: { email: 'pending@b.com', properties: {}, subscriptions: sub('UNCONFIRMED') } }],
          links: {},
        } };
  });
  const { listProfilesWithConsent } = await import('../../lib/klaviyo-profiles.js');

  const out = await listProfilesWithConsent('ABC123');
  assert.deepEqual(
    out.map((p) => [p.email, p.subscribed]),
    [['in@b.com', true], ['out@b.com', false], ['pending@b.com', false]],
    'every member is returned, with consent reduced to a boolean',
  );
});

test('getListOptInProcess reads the setting the API was long claimed not to expose', async () => {
  // The claim "the API does not expose this field" was false: GET /lists/{id}/
  // returns attributes.opt_in_process. Verified live 2026-08-11 — Y2ukbE is
  // double_opt_in while S6hKFq is single_opt_in, so the account is not uniform
  // and Gate A has to assert it rather than trust a checklist tick.
  stubFetch(() => ({ json: { data: { id: 'Y2ukbE', attributes: { opt_in_process: 'double_opt_in' } } } }));
  const { getListOptInProcess } = await import('../../lib/klaviyo-profiles.js');
  assert.equal(await getListOptInProcess('Y2ukbE'), 'double_opt_in');
  assert.match(decodeURIComponent(calls[0].url), /\/lists\/Y2ukbE\/\?fields\[list\]=opt_in_process/);
});

test('a missing opt_in_process reads as null, never as a pass', async () => {
  stubFetch(() => ({ json: { data: { id: 'Y2ukbE', attributes: {} } } }));
  const { getListOptInProcess } = await import('../../lib/klaviyo-profiles.js');
  assert.equal(await getListOptInProcess('Y2ukbE'), null, 'an absent field must fail the gate, not satisfy it');
});

test('findListByName tolerates case and whitespace so it cannot create a duplicate list', async () => {
  stubFetch(() => ({ json: { data: [{ id: 'L1', attributes: { name: 'Giveaway 2026-09 — Entrants' } }], links: {} } }));
  const { findListByName } = await import('../../lib/klaviyo-profiles.js');
  const hit = await findListByName('  giveaway 2026-09 — entrants ');
  assert.equal(hit?.id, 'L1');
});

test('updateProfileProperties PATCHes by id after resolving the email', async () => {
  stubFetch(({ method }) => (method === 'GET'
    ? { json: { data: [{ id: 'PROF1', attributes: { email: 'a@b.com', properties: {} } }] } }
    : { json: { data: { id: 'PROF1' } } }));
  const { updateProfileProperties } = await import('../../lib/klaviyo-profiles.js');

  const r = await updateProfileProperties('A@B.com', { gv_entries: 8 });
  assert.equal(r.id, 'PROF1');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /\/profiles\/PROF1\//);
  assert.equal(patch.body.data.id, 'PROF1', 'a PATCH without data.id is rejected by Klaviyo');
  assert.equal(patch.body.data.attributes.properties.gv_entries, 8);
});

test('getProfileByEmail returns null rather than throwing when nobody matches', async () => {
  stubFetch(() => ({ json: { data: [] } }));
  const { getProfileByEmail } = await import('../../lib/klaviyo-profiles.js');
  assert.equal(await getProfileByEmail('nobody@example.com'), null);
});
