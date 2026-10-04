import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFromAllFolders, fetchInboxFrom, composeMessage, AGENT_HEADER } from '../../lib/hushmail.js';

function fakeClient(boxes) {
  let current = null;
  return {
    connect: async () => {}, logout: async () => {},
    list: async () => Object.keys(boxes).map((path) => ({ path, name: path, specialUse: boxes[path].special || null })),
    getMailboxLock: async (path) => { current = path; return { release() {} }; },
    async *fetch(q, fields, opts) {
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
