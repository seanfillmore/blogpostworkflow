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

test('subscribeToList sends a subscription job with the profile inline and consent requested', async () => {
  stubFetch(() => ({ status: 202, json: {} }));
  const { subscribeToList } = await import('../../lib/klaviyo-profiles.js');

  await subscribeToList('ABC123', {
    email: '  Sean@Example.COM ',
    firstName: 'Sean',
    properties: { gv_entrant: true, gv_entries: 1 },
  });

  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.match(url, /profile-subscription-bulk-create-jobs/);
  const profile = body.data.attributes.profiles.data[0];
  assert.equal(profile.attributes.email, 'sean@example.com', 'email must be normalised before it reaches Klaviyo');
  assert.equal(profile.attributes.properties.gv_entrant, true);
  assert.equal(
    profile.attributes.subscriptions.email.marketing.consent,
    'SUBSCRIBED',
    'consent must be requested so the list double-opt-in flow fires',
  );
  assert.equal(body.data.relationships.list.data.id, 'ABC123');
});

test('listSubscribedProfiles returns only confirmed profiles and follows pagination', async () => {
  let page = 0;
  stubFetch(({ url }) => {
    if (url.includes('/lists/')) {
      page += 1;
      return page === 1
        ? { json: { data: [{ id: 'p1', attributes: { email: 'a@b.com', properties: { gv_entries: 3 } } }], links: { next: 'https://a.klaviyo.com/api/next-page' } } }
        : { json: { data: [{ id: 'p2', attributes: { email: 'c@d.com', properties: {} } }], links: {} } };
    }
    return { json: { data: [{ id: 'p2', attributes: { email: 'c@d.com', properties: {} } }], links: {} } };
  });
  const { listSubscribedProfiles } = await import('../../lib/klaviyo-profiles.js');

  const out = await listSubscribedProfiles('ABC123');
  assert.equal(out.length, 2, 'both pages must be returned');
  assert.deepEqual(out.map((p) => p.email), ['a@b.com', 'c@d.com']);
  assert.match(calls[0].url, /filter=.*SUBSCRIBED/, 'the request must filter to confirmed consent');
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
