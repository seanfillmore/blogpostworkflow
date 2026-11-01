import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, composeMessage, validateAttachments } from '../../lib/hushmail.js';

// FAKE DATA ONLY: invented people on example.com.
const creds = { user: 'sean@realskincare.com', pass: 'x' };
const pdf = Buffer.from('%PDF-1.4 fake brief');

test('resend path sends the attachment base64 and the Sent copy carries the same file', async () => {
  let body; let raw;
  const r = await sendMail(creds, {
    to: 'jane@example.com', subject: 'Ideas', text: 'Hi Jane',
    attachments: [{ filename: 'Brief.pdf', content: pdf }],
  }, {
    via: 'resend', resendKey: 'k',
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, text: async () => '{"id":"r1"}' }; },
    appendSent: async (_c, bytes) => { raw = bytes.toString(); },
  });
  assert.equal(r.resendId, 'r1');
  assert.deepEqual(body.attachments, [{ filename: 'Brief.pdf', content: pdf.toString('base64') }]);
  assert.match(raw, /filename=Brief\.pdf/);
  assert.match(raw, new RegExp(pdf.toString('base64')));
});

test('no attachments leaves the resend body unchanged', async () => {
  let body;
  await sendMail(creds, { to: 'jane@example.com', subject: 'S', text: 'T' }, {
    via: 'resend', resendKey: 'k',
    fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, text: async () => '{"id":"r"}' }; },
    appendSent: async () => {},
  });
  assert.equal('attachments' in body, false);
});

test('smtp path passes attachments to the transport', async () => {
  let sent;
  await sendMail(creds, { to: 'jane@example.com', subject: 'S', text: 'T', attachments: [{ filename: 'a.pdf', content: pdf }] }, {
    transportImpl: { sendMail: async (m) => { sent = m; return { messageId: '<m>' }; } },
  });
  assert.equal(sent.attachments[0].filename, 'a.pdf');
  assert.ok(Buffer.isBuffer(sent.attachments[0].content));
});

test('a bad attachment is refused before anything is sent', async () => {
  let called = false;
  const opts = { via: 'resend', resendKey: 'k', fetchImpl: async () => { called = true; }, appendSent: async () => {} };
  await assert.rejects(sendMail(creds, { to: 'j@example.com', subject: 'S', text: 'T', attachments: [{ filename: 'a.pdf', content: Buffer.alloc(0) }] }, opts), /non-empty Buffer/);
  await assert.rejects(sendMail(creds, { to: 'j@example.com', subject: 'S', text: 'T', attachments: [{ content: pdf }] }, opts), /filename/);
  assert.equal(called, false);
  assert.doesNotThrow(() => validateAttachments(undefined));
});

test('composeMessage without attachments is a single text part', async () => {
  const { raw } = await composeMessage(creds, { to: 'j@example.com', subject: 'S', text: 'T' });
  assert.doesNotMatch(raw.toString(), /multipart\/mixed/);
});
