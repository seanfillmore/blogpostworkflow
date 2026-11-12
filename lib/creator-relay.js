/**
 * Escalation relay for agents/creator-outreach. Pure: no I/O.
 *
 * Sean, 2026-11-11: "Instead of just flagging the email, if I don't respond in
 * a day or two, send me an email with what they are asking and I can respond to
 * you and you can send the response."
 *
 * Until then an escalated creator waited for Sean to open Hushmail, find the
 * thread and answer it there; the digest only listed the flag. Six creators sat
 * flagged at once on 2026-11-10, two of them for nearly four weeks, and four
 * needed no answer at all (an Instagram handle, a thank-you).
 *
 * Flow:
 *   1. A creator's message is escalated (unchanged: nothing goes to them).
 *   2. RELAY_AFTER_HOURS later, if Sean has not answered them himself, the agent
 *      emails Sean's own address (the founder-notes pattern) with what they
 *      wrote, tagged `[CR-<token>]` in the subject.
 *   3. Sean replies to that email. His words go to the creator VERBATIM, in
 *      their thread, with the signature added if he did not sign. A reply of
 *      just "skip" (or "no reply needed") closes the flag and sends nothing.
 *   4. Answering the creator directly still works and closes the request.
 *
 * Sean's words are not run through the reply gate: the gate exists to stop a
 * MODEL promising money or product on his behalf, and here he is the author.
 */

import { createHash } from 'node:crypto';
import { isAgentMessageId, stripQuoted } from './hushmail.js';

/** "A day or two": long enough for Sean to answer on his own first. */
export const RELAY_AFTER_HOURS = 36;
/** Opening line of the email to Sean; also how his inbox copy of it is told apart from his reply. */
export const RELAY_OPENING = 'Reply to this email with your answer and I will send it to them.';
const MAX_TOKENS_KEPT = 5;
const SKIP_PATTERN = /^(skip|no reply|no reply needed|no response needed|none|nothing to send|close it|close)$/i;

/** Short, stable id for one escalation of one creator. */
export function relayToken(email, escalatedAt) {
  return createHash('sha256').update(`${email}|${escalatedAt}`).digest('hex').slice(0, 8);
}

/**
 * Is a relay request due for this creator? Only for an open escalation, past
 * the wait, not already requested for this same escalation.
 */
export function relayDue(rec = {}, now = Date.now(), afterHours = RELAY_AFTER_HOURS) {
  if (!rec.escalatedOpen || !rec.escalatedAt || rec.optedOut) return false;
  if (rec.relay?.escalatedAt === rec.escalatedAt) return false;
  return now - Date.parse(rec.escalatedAt) >= afterHours * 3_600_000;
}

/** The email to Sean: who, why, what they wrote, and how to answer. */
export function relayRequestEmail({ name, email, rec, token }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'them';
  const lines = [
    RELAY_OPENING,
    '',
    `It goes to ${first} exactly as you write it, in their thread, signed "Sean / Real Skin Care / realskincare.com" unless you sign it yourself.`,
    'Reply "skip" if they need no answer; that clears the flag and sends nothing.',
    'Answering them directly in Hushmail also works and closes this.',
    '',
    `Waiting since ${String(rec.escalatedAt).slice(0, 10)}${rec.escalationReasons?.length ? ` (${rec.escalationReasons.join('; ')})` : ''}.`,
    '',
    `${name} <${email}> wrote${rec.escalationSubject ? ` (subject: ${rec.escalationSubject})` : ''}:`,
    '',
    String(rec.thread?.text || '(message text not on file)').trim(),
  ];
  if (rec.escalationSuggestion) {
    lines.push('', 'A draft the model wrote and was not allowed to send (for reference):', rec.escalationSuggestion);
  }
  return {
    subject: `[CR-${token}] ${name} is waiting on you${rec.escalationSubject ? `: ${rec.escalationSubject}` : ''}`,
    text: lines.join('\n'),
  };
}

/** Record a sent request on the creator. Older tokens stay valid for a late reply. */
export function recordRelayRequest(rec, { token, at, messageId }) {
  const tokens = [...(rec.relay?.tokens || []), token].slice(-MAX_TOKENS_KEPT);
  const ids = [...(rec.relay?.messageIds || []), messageId].filter(Boolean).slice(-MAX_TOKENS_KEPT);
  rec.relay = { token, tokens, messageIds: ids, escalatedAt: rec.escalatedAt, requestedAt: at };
  return rec;
}

/**
 * Which creator, if any, is this message from Sean answering? Matches the
 * thread headers first, then the subject tag. The agent's own copy of the
 * request (same mailbox) is never a reply.
 * @param {object} msg  a fetched message from Sean's own address
 * @param {object} creators  state.creators
 * @returns {string|null} creator email
 */
export function matchRelayReply(msg, creators = {}) {
  if (!msg || isAgentMessageId(msg.messageId)) return null;
  if (stripQuoted(msg.fullText ?? msg.text ?? '').trim().startsWith(RELAY_OPENING)) return null;
  const refs = new Set([msg.inReplyTo, ...(msg.references || [])].filter(Boolean));
  const tag = String(msg.subject || '').match(/\[CR-([0-9a-f]{8})\]/)?.[1];
  for (const [email, rec] of Object.entries(creators)) {
    const r = rec?.relay;
    if (!r) continue;
    if ((r.messageIds || []).some((id) => refs.has(id))) return email;
    if (tag && (r.tokens || []).includes(tag)) return email;
  }
  return null;
}

/**
 * What to do with Sean's reply: send his words (signed), close silently, or
 * ignore an empty body.
 * @returns {{action: 'send', body: string} | {action: 'close'} | {action: 'empty'}}
 */
export function interpretRelayReply(msg, signature) {
  const body = stripQuoted(msg.fullText ?? msg.text ?? '').trim();
  if (!body) return { action: 'empty' };
  if (SKIP_PATTERN.test(body.replace(/[.!\s]+$/g, '').trim())) return { action: 'close' };
  const tail = body.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join('\n');
  const signed = /^\s*-*\s*sean\b/im.test(tail) || /real skin care/i.test(tail);
  return { action: 'send', body: signed ? body : `${body}\n\n${signature}` };
}

/** Clear a creator's escalation and any pending relay. */
export function closeEscalation(rec, at) {
  rec.escalatedOpen = false;
  rec.escalationResolvedAt = at;
  delete rec.relay;
  return rec;
}
