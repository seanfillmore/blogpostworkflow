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

let alerts = [];

beforeEach(async () => {
  calls = [];
  alerts = [];
  const m = await import('../../lib/meta-capi.js');
  m.__resetLeadAlertThrottle();
  m.__setLeadNotifier(async (n) => { alerts.push(n); });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const m = await import('../../lib/meta-capi.js');
  m.__setLeadNotifier(null);
});

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
  assert.equal(
    calls.filter((c) => c.url.includes('graph.facebook.com')).length, 0,
    'no request attempted without a pixel id',
  );
});

// ── failure alerting ────────────────────────────────────────────────────────
// A failed Lead used to reach console.error and stop there. The ad set optimises
// on LEAD, so a Lead that stops landing means budget is spent against a signal
// that cannot arrive — at $30/day, discovered a weekend later.

test('a rejected Lead raises an immediate alert, not just a log line', async () => {
  stubFetch(400, { error: { message: 'Invalid OAuth access token' } });
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'expired' });

  assert.equal(alerts.length, 1, 'the operator is told');
  assert.match(alerts[0].subject, /Lead event FAILED/);
  assert.equal(alerts[0].status, 'error');
  assert.equal(alerts[0].immediate, true, 'must not wait for the 5 AM digest — spend continues meanwhile');
  assert.match(alerts[0].body, /Invalid OAuth access token/, 'the actual Meta message is what identifies the cause');
});

test('a 200 with events_received: 0 alerts — the silent drop is the whole point', async () => {
  // Meta accepts a malformed event with a 200 and discards it. Nothing throws,
  // nothing logs at the HTTP layer, and the event simply never appears.
  stubFetch(200, { events_received: 0 });
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  assert.equal(await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' }), false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /accepted but dropped/);
});

test('a network failure alerts', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, /ECONNRESET/);
});

test('an entrant arriving with no credentials configured alerts — that is an outage, not a no-op', async () => {
  // Distinct from a caller bug: an email WITH missing credentials means a real
  // entrant came through and no Lead was even attempted. That is the exact state
  // the giveaway shipped in before 2026-08-13.
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: 'a@b.com', pixelId: null, accessToken: null });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /not configured/);
});

test('no email is a caller bug and stays silent — it must not page anyone', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  assert.equal(await sendLeadEvent({ pixelId: 'PX', accessToken: 'T' }), false);
  assert.equal(alerts.length, 0);
});

test('alerts are throttled per reason — an expired token fails EVERY entry', async () => {
  // Unthrottled, one outage becomes an inbox flood and gets muted, which is the
  // same as having no alert at all.
  stubFetch(400, { error: { message: 'bad token' } });
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  for (let i = 0; i < 5; i++) {
    await sendLeadEvent({ email: `e${i}@b.com`, pixelId: 'PX', accessToken: 'T' });
  }
  assert.equal(alerts.length, 1, 'five failures, one email');
});

test('a different failure reason is not suppressed by an unrelated one', async () => {
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  stubFetch(400, { error: { message: 'bad token' } });
  await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' });
  stubFetch(200, { events_received: 0 });
  await sendLeadEvent({ email: 'b@b.com', pixelId: 'PX', accessToken: 'T' });

  assert.equal(alerts.length, 2, 'throttling is per reason, so a NEW failure still gets through');
});

test('an alert that fails to send cannot break the entry', async () => {
  stubFetch(400, { error: { message: 'bad' } });
  const m = await import('../../lib/meta-capi.js');
  m.__setLeadNotifier(async () => { throw new Error('Resend down'); });
  assert.equal(
    await m.sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'T' }), false,
    'resolves false rather than rejecting — the entry is the paid-for thing',
  );
});

// ── token resolution ─────────────────────────────────────────────────────────
// Defence in depth for a caller with no hydration step. The dashboard itself is
// fine — it calls hydrateProcessEnv(loadEnvAuth()) at bootstrap, and a real entry
// through the live endpoint took the dataset's Lead count 6 -> 7 on 2026-08-17.
// But a cron script or one-off passing a bare process.env value through would get
// undefined, and without this fallback that is a silent false and a lost
// conversion.

test('resolveLeadAccessToken prefers process.env', async () => {
  const { resolveLeadAccessToken } = await import('../../lib/meta-capi.js');
  assert.equal(resolveLeadAccessToken({ FACEBOOK_ACCESS_TOKEN: 'from-process' }), 'from-process');
});

test('a caller passing no token still sends, by falling back to .env', async () => {
  // This is THE regression. Before the fix this path alerted "not configured"
  // and sent nothing.
  stubFetch();
  const { sendLeadEvent, resolveLeadAccessToken } = await import('../../lib/meta-capi.js');
  const onDisk = resolveLeadAccessToken({});
  if (!onDisk) return; // no .env in this checkout; nothing to assert against

  const ok = await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX' }); // note: no accessToken
  assert.equal(ok, true, 'a missing argument must not mean a missing Lead');
  assert.equal(alerts.length, 0, 'and it must not page anyone for a non-problem');
  assert.match(calls[0].url, /access_token=/, 'the resolved token reaches the request');
});

test('an explicitly passed token still wins over the file', async () => {
  stubFetch();
  const { sendLeadEvent } = await import('../../lib/meta-capi.js');
  await sendLeadEvent({ email: 'a@b.com', pixelId: 'PX', accessToken: 'explicit-token' });
  assert.match(calls[0].url, /access_token=explicit-token/);
});
