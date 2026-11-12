import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAY_AFTER_HOURS, RELAY_OPENING, relayToken, relayDue, relayRequestEmail, recordRelayRequest,
  matchRelayReply, interpretRelayReply, closeEscalation,
} from '../../lib/creator-relay.js';

// FAKE DATA ONLY: invented people on example.com.
const SIG = 'Sean\nReal Skin Care\nrealskincare.com';
const H = 3_600_000;
const esc = { escalatedOpen: true, escalatedAt: '2026-11-01T00:00:00.000Z', escalationSubject: 'Re: samples', escalationReasons: ['money'], thread: { text: 'What do you pay per video?' } };

test('relay is due only after the wait, once per escalation', () => {
  const t0 = Date.parse(esc.escalatedAt);
  assert.equal(relayDue(esc, t0 + (RELAY_AFTER_HOURS - 1) * H), false);
  assert.equal(relayDue(esc, t0 + RELAY_AFTER_HOURS * H), true);
  const rec = recordRelayRequest({ ...esc }, { token: 'abcdef12', at: 'x', messageId: '<r1@x>' });
  assert.equal(relayDue(rec, t0 + 100 * H), false, 'already requested for this escalation');
  rec.escalatedAt = '2026-11-03T00:00:00.000Z';
  assert.equal(relayDue(rec, Date.parse(rec.escalatedAt) + RELAY_AFTER_HOURS * H), true, 'a newer escalation gets a fresh request');
  assert.equal(relayDue({ ...esc, escalatedOpen: false }, t0 + 100 * H), false);
  assert.equal(relayDue({ ...esc, optedOut: true }, t0 + 100 * H), false);
});

test('the request names the creator, quotes their message and carries the tag', () => {
  const token = relayToken('lori@example.com', esc.escalatedAt);
  assert.match(token, /^[0-9a-f]{8}$/);
  const m = relayRequestEmail({ name: 'Lori Yockim', email: 'lori@example.com', rec: { ...esc, escalationSuggestion: 'draft text' }, token });
  assert.equal(m.subject, `[CR-${token}] Lori Yockim is waiting on you: Re: samples`);
  assert.ok(m.text.startsWith(RELAY_OPENING));
  assert.match(m.text, /What do you pay per video\?/);
  assert.match(m.text, /draft text/);
  assert.match(m.text, /goes to Lori exactly as you write it/);
  assert.ok(!/—/.test(m.text));
});

test('a reply matches by thread header or subject tag, never the agent copy', () => {
  const creators = { 'lori@example.com': recordRelayRequest({ ...esc }, { token: 'abcdef12', at: 'x', messageId: '<r1@x>' }), 'other@example.com': {} };
  assert.equal(matchRelayReply({ messageId: '<sean1@hushmail.com>', inReplyTo: '<r1@x>', subject: 'Re: whatever', text: 'Hi' }, creators), 'lori@example.com');
  assert.equal(matchRelayReply({ messageId: '<sean2@hushmail.com>', subject: 'Re: [CR-abcdef12] Lori', text: 'Hi' }, creators), 'lori@example.com');
  assert.equal(matchRelayReply({ messageId: '<sean3@hushmail.com>', subject: 'Re: [CR-00000000] Lori', text: 'Hi' }, creators), null);
  assert.equal(matchRelayReply({ messageId: '<mwaxz2tp.msnddmj1@realskincare.com>', subject: '[CR-abcdef12] Lori', text: 'Hi' }, creators), null, 'agent-minted id');
  assert.equal(matchRelayReply({ messageId: '<sean4@hushmail.com>', subject: '[CR-abcdef12] Lori', text: `${RELAY_OPENING}\nmore` }, creators), null, 'our own request');
});

test('a late reply to an older request still matches', () => {
  let rec = recordRelayRequest({ ...esc }, { token: 'aaaaaaaa', at: 'x', messageId: '<r1@x>' });
  rec.escalatedAt = 'later';
  rec = recordRelayRequest(rec, { token: 'bbbbbbbb', at: 'y', messageId: '<r2@x>' });
  assert.equal(matchRelayReply({ messageId: '<s@h>', subject: 'Re: [CR-aaaaaaaa]', text: 'Hi' }, { 'l@example.com': rec }), 'l@example.com');
});

test("Sean's words are sent verbatim, signed only if he did not sign", () => {
  const q = '\n\nOn Tue, Nov 11, 2026 at 9:00 AM Sean wrote:\n> Reply to this email';
  assert.deepEqual(interpretRelayReply({ fullText: `We don't have US demand for French content, but thank you!${q}` }, SIG),
    { action: 'send', body: `We don't have US demand for French content, but thank you!\n\n${SIG}` });
  assert.deepEqual(interpretRelayReply({ fullText: `Thanks Kaci, ideas coming soon.\n\nSean${q}` }, SIG),
    { action: 'send', body: 'Thanks Kaci, ideas coming soon.\n\nSean' });
});

test('"skip" closes without sending; an empty reply does nothing', () => {
  for (const s of ['skip', 'Skip.', 'no reply needed', 'None']) assert.deepEqual(interpretRelayReply({ fullText: s }, SIG), { action: 'close' });
  assert.deepEqual(interpretRelayReply({ fullText: '> only quoted' }, SIG), { action: 'empty' });
  assert.equal(interpretRelayReply({ fullText: 'Skip the toothpaste, film the lotion' }, SIG).action, 'send', 'skip inside a sentence is an answer');
});

test('closing clears the flag and the pending relay', () => {
  const rec = closeEscalation(recordRelayRequest({ ...esc }, { token: 'a', at: 'x', messageId: '<r@x>' }), 'now');
  assert.equal(rec.escalatedOpen, false);
  assert.equal(rec.escalationResolvedAt, 'now');
  assert.equal(rec.relay, undefined);
});
