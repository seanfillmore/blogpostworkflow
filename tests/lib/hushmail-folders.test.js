import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFromAllFolders, fetchInboxFrom, composeMessage, AGENT_HEADER } from '../../lib/hushmail.js';

function fakeClient(boxes, rec = { locks: [], fetches: [], opened: [] }) {
  let current = null;
  return {
    rec,
    connect: async () => {}, logout: async () => {},
    list: async () => Object.keys(boxes).map((path) => ({ path, name: path, specialUse: boxes[path].special || null, flags: boxes[path].flags })),
    getMailboxLock: async (path, opts) => { current = path; rec.locks.push({ path, opts }); rec.opened.push(path); return { release() {} }; },
    async *fetch(q, fields, opts) {
      rec.fetches.push({ path: current, fields });
      for (const m of boxes[current].msgs) {
        if (Array.isArray(q) && !q.includes(m.uid)) continue;
        yield { uid: m.uid, envelope: { from: [{ address: m.from }], subject: m.subject, messageId: m.id, date: new Date('2026-10-05') }, source: m.from };
      }
    },
  };
}
const parseImpl = async (from) => ({ messageId: `<${from}>`, text: 'Thanks, happy to try it', subject: 're', date: new Date('2026-10-05'), headers: new Map() });

test('reads filed folders, skips Sent/Drafts/Trash, tags the folder', async () => {
  const client = fakeClient({
    INBOX: { msgs: [] },
    'Cold Pitches': { msgs: [{ uid: 1, from: 'jane@example.com', subject: 'Re: hi', id: '<x>' }] },
    Sent: { special: '\\Sent', msgs: [{ uid: 2, from: 'jane@example.com', subject: 'no', id: '<y>' }] },
    Trash: { special: '\\Trash', msgs: [{ uid: 3, from: 'jane@example.com', subject: 'no', id: '<z>' }] },
  });
  const rows = await fetchFromAllFolders({ user: 'sean@realskincare.com', pass: 'x' },
    { senders: ['Jane@Example.com'], since: new Date('2026-10-01') }, { clientImpl: client, parseImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'Cold Pitches');
  assert.equal(rows[0].from, 'jane@example.com');
});

test('fetchInboxFrom rows carry no folder key (creator-outreach shape unchanged)', async () => {
  const client = fakeClient({ INBOX: { msgs: [{ uid: 1, from: 'jane@example.com', subject: 'hi', id: '<x>' }] } });
  const rows = await fetchInboxFrom({ user: 'sean@realskincare.com', pass: 'x' },
    { senders: ['jane@example.com'], since: new Date('2026-10-01') }, { clientImpl: client, parseImpl });
  assert.equal(rows.length, 1);
  assert.equal('folder' in rows[0], false);
});

test('composeMessage stamps the agent name it is given', async () => {
  const { raw } = await composeMessage({ user: 'sean@realskincare.com' }, { to: 'a@example.com', subject: 's', text: 't', agent: 'press-outreach' });
  assert.match(raw.toString(), new RegExp(`${AGENT_HEADER}: press-outreach`, "i"));
});

test('composeMessage defaults to creator-outreach', async () => {
  const { raw } = await composeMessage({ user: 'sean@realskincare.com' }, { to: 'a@example.com', subject: 's', text: 't' });
  assert.match(raw.toString(), new RegExp(`${AGENT_HEADER}: creator-outreach`, "i"));
});

test('every mailbox is locked readOnly and fetches never ask for flag changes', async () => {
  const client = fakeClient({
    INBOX: { msgs: [{ uid: 1, from: 'jane@example.com', subject: 'hi', id: '<a>' }] },
    'Cold Pitches': { msgs: [{ uid: 2, from: 'jane@example.com', subject: 'hi', id: '<b>' }] },
  });
  await fetchFromAllFolders({ user: 'sean@realskincare.com', pass: 'x' },
    { senders: ['jane@example.com'], since: new Date('2026-10-01') }, { clientImpl: client, parseImpl });
  assert.ok(client.rec.locks.length >= 2);
  for (const l of client.rec.locks) assert.equal(l.opts?.readOnly, true, `${l.path} not readOnly`);
  const allowed = new Set(['envelope', 'uid', 'source']);
  assert.ok(client.rec.fetches.length >= 2);
  for (const f of client.rec.fetches) {
    for (const k of Object.keys(f.fields)) assert.ok(allowed.has(k), `unexpected fetch field ${k}`);
  }
});

test('name fallback and \\Noselect skip folders without specialUse', async () => {
  const msg = (uid) => [{ uid, from: 'jane@example.com', subject: 's', id: `<${uid}>` }];
  const client = fakeClient({
    'Sent Items': { msgs: msg(1) },
    Drafts: { msgs: msg(2) },
    'Deleted Items': { msgs: msg(3) },
    Unselectable: { flags: new Set(['\\Noselect']), msgs: msg(4) },
    'Cold Pitches': { msgs: msg(5) },
    Junk: { msgs: msg(6) },
  });
  const rows = await fetchFromAllFolders({ user: 'sean@realskincare.com', pass: 'x' },
    { senders: ['jane@example.com'], since: new Date('2026-10-01') }, { clientImpl: client, parseImpl });
  assert.deepEqual(client.rec.opened.sort(), ['Cold Pitches', 'Junk']);
  assert.deepEqual(rows.map((r) => r.folder).sort(), ['Cold Pitches', 'Junk']);
});

test('M5: sendMail via Resend posts X-RSC-Agent: press-outreach', async () => {
  const { sendMail } = await import('../../lib/hushmail.js');
  let posted;
  const fetchImpl = async (url, init) => { posted = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '{"id":"re_1"}' }; };
  await sendMail({ user: 'sean@realskincare.com', pass: 'x' }, { to: 'a@example.com', subject: 's', text: 't', agent: 'press-outreach' },
    { via: 'resend', resendKey: 'k', fetchImpl, appendSent: async () => {} });
  assert.equal(posted.headers[AGENT_HEADER], 'press-outreach');
});
