// tests/lib/meta-capi.test.js
// Meta is stubbed at the fetch boundary. These assert the payload SHAPE, because
// the Conversions API accepts a malformed event with a 200 and simply drops it —
// there is no error to observe at runtime, and the only symptom is an event that
// never appears in the dataset. That is precisely the failure that hid here for
// weeks: /enter was documented as "the Meta Lead conversion" and fired nothing.
import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';
import { createHash } from 'node:crypto';

const realFetch = globalThis.fetch;
let calls = [];

function stubFetch(status = 200, body = { events_received: 1 }) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
}

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test('the email is normalised then SHA-256 hashed — raw PII must never leave this process', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: '  Sean@Example.COM ', pixelId: 'PX', accessToken: 'T' });

  const ev = calls[0].body.data[0];
  assert.equal(ev.user_data.em[0], sha256('sean@example.com'), 'lowercased and trimmed before hashing');
  const raw = JSON.stringify(calls[0].body);
  assert.ok(!raw.includes('Sean@Example.COM'), 'the raw address must not appear anywhere in the payload');
  assert.ok(!raw.includes('sean@example.com'), 'not even normalised — only the hash');
});

test('the event is a Lead, server-sourced, with a deduplication id', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: 'a@b.com', eventId: 'gv-123', pixelId: 'PX', accessToken: 'T' });

  const ev = calls[0].body.data[0];
  assert.equal(ev.event_name, 'Lead', 'the ad set optimises on LEAD — any other name is invisible to it');
  assert.equal(ev.action_source, 'website');
  assert.equal(ev.event_id, 'gv-123', 'event_id is what lets a future browser-side Lead deduplicate against this one');
  assert.equal(typeof ev.event_time, 'number');
  assert.match(calls[0].url, /\/PX\/events/);
});

test('fbc, fbp, IP and user agent are forwarded when present — they are the match-quality difference', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({
    email: 'a@b.com', pixelId: 'PX', accessToken: 'T',
    fbc: 'fb.1.123.AbC', fbp: 'fb.1.456.789', clientIp: '203.0.113.9', userAgent: 'Mozilla/5.0', sourceUrl: 'https://x/y',
  });

  const u = calls[0].body.data[0].user_data;
  assert.equal(u.fbc, 'fb.1.123.AbC');
  assert.equal(u.fbp, 'fb.1.456.789');
  assert.equal(u.client_ip_address, '203.0.113.9');
  assert.equal(u.client_user_agent, 'Mozilla/5.0');
  assert.equal(calls[0].body.data[0].event_source_url, 'https://x/y');
});

test('absent optional fields are omitted entirely, not sent as null', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' });

  const u = calls[0].body.data[0].user_data;
  for (const k of ['fbc', 'fbp', 'client_ip_address', 'client_user_agent']) {
    assert.ok(!(k in u), `${k} must be omitted when unknown — Meta treats an explicit null as a value`);
  }
});

test('a Meta outage never breaks the entry — it resolves false rather than throwing', async () => {
  // The entry is the paid-for thing. Losing a ~$2.50 entry because an analytics
  // call failed would be a far worse trade than losing the analytics event.
  globalThis.fetch = async () => { throw new Error('network down'); };
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  assert.equal(await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' }), false);
});

test('a non-2xx from Meta resolves false rather than throwing', async () => {
  stubFetch(400, { error: { message: 'bad' } });
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  assert.equal(await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' }), false);
});

test('missing configuration is a no-op, so an unconfigured environment cannot break entries', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  assert.equal(await sendLeadEvent({ email: 'a@b.com', pixelId: null, accessToken: 'T' }), false);
  assert.equal(calls.length, 0, 'no request attempted without a pixel id');
});
