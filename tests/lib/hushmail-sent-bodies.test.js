import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSentBodiesTo } from '../../lib/hushmail.js';

// FAKE DATA ONLY: invented people on example.com.
function fakeClient(boxes, rec = { locks: [], fetches: [], writes: [] }) {
  let current = null;
  return {
    rec,
    connect: async () => {}, logout: async () => {},
    list: async () => Object.keys(boxes).map((path) => ({ path, name: path, specialUse: boxes[path].special || null })),
    getMailboxLock: async (path, opts) => { current = path; rec.locks.push({ path, opts }); return { release() {} }; },
    append: async () => { rec.writes.push('append'); },
    messageFlagsAdd: async () => { rec.writes.push('flags'); },
    messageMove: async () => { rec.writes.push('move'); },
    async *fetch(q, fields, opts) {
      rec.fetches.push({ path: current, fields, opts });
      for (const m of boxes[current].msgs) {
        if (Array.isArray(q) && !q.includes(m.uid)) continue;
        yield { uid: m.uid, envelope: { to: m.to.map((address) => ({ address })), subject: m.subject, messageId: m.id, date: new Date(m.date) }, source: m.body };
      }
    },
  };
}
const parseImpl = async (body) => ({ text: `${body}\n\nOn Mon, Jane wrote:\n> old quoted text`, headers: new Map() });

test('fetchSentBodiesTo returns Sent messages to the given recipients with their text body, read-only', async () => {
  const client = fakeClient({
    INBOX: { msgs: [{ uid: 9, to: ['jane@example.com'], subject: 'inbox', id: '<i>', date: '2026-09-20', body: 'nope' }] },
    Sent: { special: '\\Sent', msgs: [
      { uid: 1, to: ['jane@example.com'], subject: 'Coconut cream', id: '<p1@realskincare.com>', date: '2026-09-20T17:00:00Z', body: 'Hi Jane, our pitch body.' },
      { uid: 2, to: ['other@example.com'], subject: 'Else', id: '<p2>', date: '2026-09-21T17:00:00Z', body: 'not for jane' },
    ] },
  });
  const rows = await fetchSentBodiesTo({ user: 'sean@realskincare.com', pass: 'x' },
    { recipients: ['Jane@Example.com'], since: new Date('2026-09-01') }, { clientImpl: client, parseImpl });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['date', 'messageId', 'subject', 'text', 'to']);
  assert.equal(rows[0].messageId, '<p1@realskincare.com>');
  assert.equal(rows[0].subject, 'Coconut cream');
  assert.equal(rows[0].date, '2026-09-20T17:00:00.000Z');
  assert.deepEqual(rows[0].to, ['jane@example.com']);
  assert.equal(rows[0].text, 'Hi Jane, our pitch body.', 'quoted history stripped');
  // Read-only: only the Sent folder, locked readOnly; no flag, move or append calls.
  assert.deepEqual(client.rec.locks.map((l) => l.path), ['Sent']);
  for (const l of client.rec.locks) assert.equal(l.opts?.readOnly, true);
  assert.deepEqual(client.rec.writes, []);
  const allowed = new Set(['envelope', 'uid', 'source']);
  for (const f of client.rec.fetches) for (const k of Object.keys(f.fields)) assert.ok(allowed.has(k), `unexpected fetch field ${k}`);
  // Bodies are fetched only for matching messages.
  const bodyFetch = client.rec.fetches.find((f) => f.fields.source);
  assert.ok(bodyFetch);
});

test('fetchSentBodiesTo: no recipients means no connection at all', async () => {
  let made = 0;
  const rows = await fetchSentBodiesTo({ user: 'sean@realskincare.com', pass: 'x' }, { recipients: [], since: new Date() }, { clientImpl: { connect: async () => { made += 1; } } });
  assert.deepEqual(rows, []);
  assert.equal(made, 0);
});
