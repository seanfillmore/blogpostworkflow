/**
 * One-off broadcasts to Trybe creators through the creator-outreach mail path:
 * a hand-written email (usually approved by Sean) sent to a named list, with
 * the same guards the scheduled agent applies. Pure: no I/O here, so every
 * skip rule is something a test constructs.
 *
 * A creator is SKIPPED, never sent to, when:
 *   - their thread has an open escalation (Sean's rule: while flagged, only
 *     Sean writes to them, so a template must not cut across his reply);
 *   - the creator-outreach state does not know them (replies would arrive
 *     from an address the agent has never seen);
 *   - this broadcast id was already sent to them (re-running is safe).
 */

/**
 * @param {Array<{email: string, subject: string, body: string}>} messages
 * @param {object} state  creator-outreach state.json
 * @param {string} id     broadcast id, recorded per creator
 * @returns {{send: Array<{email: string, message: {to, subject, text}}>, skipped: Array<{email: string, reason: string}>}}
 *   `message` is exactly what lib/hushmail.js sendMail takes.
 */
export function planBroadcast(messages, state, id) {
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('broadcast id must be lower-case letters, digits and dashes');
  const creators = state?.creators || {};
  const send = [];
  const skipped = [];
  const seen = new Set();
  for (const m of messages) {
    const email = String(m.email || '').trim().toLowerCase();
    if (!email || !m.subject || !m.body) throw new Error(`message for "${m.email}" needs email, subject and body`);
    if (seen.has(email)) { skipped.push({ email, reason: 'duplicate in the message list' }); continue; }
    seen.add(email);
    const rec = creators[email];
    if (!rec) { skipped.push({ email, reason: 'not in creator-outreach state' }); continue; }
    if (rec.escalatedOpen) { skipped.push({ email, reason: 'open escalation, waiting on Sean' }); continue; }
    if (rec.broadcasts?.[id]) { skipped.push({ email, reason: `already sent ${rec.broadcasts[id].at}` }); continue; }
    send.push({ email, message: { to: email, subject: m.subject, text: m.body } });
  }
  return { send, skipped };
}

/** What a successful send records on the creator, so re-runs skip them and scheduled mail keeps its gap. */
export function recordBroadcast(rec, id, { at, messageId, subject, attachments = [] }) {
  rec.broadcasts = { ...(rec.broadcasts || {}), [id]: { at, messageId, subject, attachments } };
  rec.lastScheduledAt = at;
  return rec;
}
