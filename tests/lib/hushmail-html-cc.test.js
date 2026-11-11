import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, composeMessage } from '../../lib/hushmail.js';

const creds = { user: 'sean@realskincare.com', pass: 'x' };

test('resend payload carries html and cc', async () => {
  let body;
  const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); return { ok: true, text: async () => '{"id":"r1"}' }; };
  await sendMail(creds,
    { to: 'travis@traviswales.com', cc: 'sean@realskincare.com', subject: 's', text: 't', html: '<p>h</p>', agent: 'culina-report' },
    { via: 'resend', resendKey: 'k', fetchImpl, appendSent: async () => {} });
  assert.deepEqual(body.cc, ['sean@realskincare.com']);
  assert.equal(body.html, '<p>h</p>');
  assert.deepEqual(body.to, ['travis@traviswales.com']);
});

test('composeMessage includes Cc header and an html part', async () => {
  const { raw } = await composeMessage(creds, { to: 'a@b.c', cc: ['d@e.f'], subject: 's', text: 't', html: '<b>h</b>' });
  const s = raw.toString();
  assert.match(s, /^Cc: d@e\.f/m);
  assert.match(s, /text\/html/);
});

test('smtp passes cc and html to the transport', async () => {
  let sent;
  const transportImpl = { sendMail: async (m) => { sent = m; return { messageId: 'm1' }; } };
  await sendMail(creds, { to: 'a@b.c', cc: ['d@e.f'], subject: 's', text: 't', html: '<b>h</b>' }, { transportImpl });
  assert.deepEqual(sent.cc, ['d@e.f']);
  assert.equal(sent.html, '<b>h</b>');
});

test('no cc and no html keeps the old payload shape', async () => {
  let body;
  const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); return { ok: true, text: async () => '{"id":"r1"}' }; };
  await sendMail(creds, { to: 'a@b.c', subject: 's', text: 't' },
    { via: 'resend', resendKey: 'k', fetchImpl, appendSent: async () => {} });
  assert.equal(body.cc, undefined);
  assert.equal(body.html, undefined);
  assert.deepEqual(body.to, ['a@b.c']);
  let sent;
  await sendMail(creds, { to: 'a@b.c', subject: 's', text: 't' }, { transportImpl: { sendMail: async (m) => { sent = m; return { messageId: 'x' }; } } });
  assert.equal('cc' in sent, false);
  assert.equal('html' in sent, false);
});
