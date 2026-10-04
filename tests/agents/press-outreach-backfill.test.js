import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, parseSet } from '../../agents/press-outreach/index.js';

const NOW = Date.parse('2026-10-05T18:00:00Z');
const contact = (id, pitchOver = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-09-20', concept: 'intro', outcome: 'sent', subject: 'Coconut cream', follow_ups_sent: 0, ...pitchOver }],
});
const copy = (id, over = {}) => ({ to: [`${id}@example.com`], date: '2026-09-20T17:00:00Z', messageId: `<${id}-sent@realskincare.com>`, subject: 'coconut CREAM', ...over });
const reply = (id, text) => ({ from: `${id}@example.com`, messageId: `<r-${id}>`, text, subject: 'Re: Coconut cream', date: '2026-09-25T10:00:00Z' });

test('a sent pitch with a Sent copy gets a message_id patch and a bump draft', () => {
  const r = planBackfill({ book: { contacts: [contact('jane')] }, sentCopies: [copy('jane')], replies: [], now: NOW });
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].id, 'jane');
  assert.equal(r.patches[0].patch.message_id, '<jane-sent@realskincare.com>');
  assert.equal(r.patches[0].patch.last_sent_at, '2026-09-20T17:00:00.000Z');
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0].kind, 'bump');
  assert.equal(r.drafts[0].in_reply_to, '<jane-sent@realskincare.com>');
  assert.equal(r.drafts[0].subject, 'Re: coconut CREAM');
  assert.match(r.drafts[0].text, /^Hi Jane,/);
});

test('a pitch with no Sent copy gets a note and no draft', () => {
  const r = planBackfill({ book: { contacts: [contact('sam')] }, sentCopies: [copy('sam', { subject: 'Something else' })], replies: [], now: NOW });
  assert.equal(r.drafts.length, 0);
  assert.equal(r.patches.length, 0);
  assert.ok(r.notes.some((n) => /sam/.test(n) && /no Sent copy/.test(n)));
});

test('a decline reply patches declined and makes no draft', () => {
  const r = planBackfill({ book: { contacts: [contact('lee')] }, sentCopies: [copy('lee')], replies: [reply('lee', 'Thanks, but not interested.')], now: NOW });
  assert.equal(r.drafts.length, 0);
  assert.ok(r.patches.some((p) => p.id === 'lee' && p.patch.outcome === 'declined'));
});

test('a yes reply is reported in notes, not patched, and gets no bump', () => {
  const r = planBackfill({ book: { contacts: [contact('kim')] }, sentCopies: [copy('kim')], replies: [reply('kim', 'Yes please, send me the samples!')], now: NOW });
  assert.equal(r.drafts.length, 0);
  assert.ok(!r.patches.some((p) => p.patch.outcome));
  assert.ok(r.notes.some((n) => /kim/.test(n) && /NOT acted on/.test(n)));
});

test('a recent pitch or an existing pending draft makes no bump', () => {
  const recent = contact('ann', { date: '2026-10-01' });
  const r1 = planBackfill({ book: { contacts: [recent] }, sentCopies: [copy('ann', { date: '2026-10-01T17:00:00Z' })], replies: [], now: NOW });
  assert.equal(r1.drafts.length, 0);
  const r2 = planBackfill({ book: { contacts: [contact('bob')] }, sentCopies: [copy('bob')], replies: [], now: NOW, drafts: [{ contact_id: 'bob', status: 'pending' }] });
  assert.equal(r2.drafts.length, 0);
});

test('parseSet reads id=outcome:order and rejects a bad outcome', () => {
  assert.deepEqual(parseSet('x=samples-sent:#2373'), { id: 'x', outcome: 'samples-sent', sampleOrder: '#2373' });
  assert.deepEqual(parseSet('x=declined'), { id: 'x', outcome: 'declined', sampleOrder: null });
  assert.throws(() => parseSet('x=bogus'), /must be one of/);
});

test('a later "Re: <subject>" Sent message, or one before the pitch date, is never the thread id', () => {
  const r = planBackfill({
    book: { contacts: [contact('jane')] },
    sentCopies: [
      copy('jane', { subject: 'Re: Coconut cream', date: '2026-09-28T10:00:00Z', messageId: '<later-reply@x>' }),
      copy('jane', { subject: 'Coconut cream', date: '2026-09-10T10:00:00Z', messageId: '<too-early@x>' }),
      copy('jane', { messageId: '<right@x>', date: '2026-09-21T10:00:00Z', subject: 'Coconut cream' }),
      copy('jane', { messageId: '<right-but-later@x>', date: '2026-09-22T10:00:00Z', subject: 'Coconut cream' }),
    ],
    replies: [], now: NOW,
  });
  assert.equal(r.patches[0].patch.message_id, '<right@x>');
});

test('a blank pitch subject gives a note and no patch, never a date-only match', () => {
  const r = planBackfill({ book: { contacts: [contact('jane', { subject: '' })] }, sentCopies: [copy('jane')], replies: [], now: NOW });
  assert.equal(r.patches.length, 0);
  assert.equal(r.drafts.length, 0);
  assert.ok(r.notes.some((n) => /cannot match the Sent copy safely/.test(n)));
});

test('an opt-out reply is patched even when no Sent copy was found', () => {
  const r = planBackfill({ book: { contacts: [contact('lee')] }, sentCopies: [], replies: [reply('lee', 'Please remove me, do not contact me again.')], now: NOW });
  assert.ok(r.patches.some((p) => p.id === 'lee' && p.contactStatus === 'do_not_contact'));
  assert.ok(r.patches.some((p) => p.id === 'lee' && p.patch.outcome === 'declined'));
  assert.equal(r.drafts.length, 0);
});
