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

import { isTrybeSampleOrder, shipmentState } from './trybe-samples.js';

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

/**
 * Hold each message until that creator's sample has been DELIVERED for at least
 * `afterDays` days. A review request that lands the day a parcel does asks
 * about a product nobody has used yet, so a broadcast can wait for the parcel
 * and run daily until everyone on it is ready. Joined on the order EMAIL, the
 * address the creator-outreach state is keyed by (the order note can name a
 * different person when a creator ships through a forwarder).
 *
 * @param {Array<{email: string}>} messages
 * @param {object[]} orders  Shopify sample orders (lib/trybe-sample-orders.js)
 * @returns {{ready: Array, waiting: Array<{email: string, reason: string}>}}
 */
export function holdUntilDelivered(messages, orders, { now = Date.now(), afterDays = 0 } = {}) {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const deliveredAt = new Map();
  for (const o of (orders || []).filter(isTrybeSampleOrder)) {
    const email = String(o.email || '').trim().toLowerCase();
    const ship = shipmentState(o);
    if (!email || ship.state !== 'delivered' || !ship.deliveredAt) continue;
    const prev = deliveredAt.get(email);
    if (!prev || ship.deliveredAt > prev) deliveredAt.set(email, ship.deliveredAt);
  }
  const ready = [];
  const waiting = [];
  for (const m of messages) {
    const email = String(m.email || '').trim().toLowerCase();
    const at = deliveredAt.get(email);
    if (!at) { waiting.push({ email, reason: 'sample not delivered yet' }); continue; }
    const days = Math.floor((nowMs - Date.parse(at)) / 86_400_000);
    if (days < afterDays) { waiting.push({ email, reason: `delivered ${at.slice(0, 10)}, waiting until ${afterDays} days` }); continue; }
    ready.push(m);
  }
  return { ready, waiting };
}

/** True once `expires` (YYYY-MM-DD, inclusive) has passed. A daily broadcast must stop on its own. */
export function isExpired(expires, now = Date.now()) {
  if (!expires) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error(`--expires must be YYYY-MM-DD, got "${expires}"`);
  const nowMs = typeof now === 'number' ? now : now.getTime();
  return nowMs >= Date.parse(`${expires}T00:00:00Z`) + 86_400_000;
}
