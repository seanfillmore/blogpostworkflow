/**
 * State, duplicate hold and AWD matching for the Culina inbound-shipment agent.
 *
 * State lives in data/amazon-inbound/state.json (gitignored, server-owned). An
 * unreadable file THROWS: treating it as empty would let every already-booked
 * message be booked a second time.
 *
 * Record: { messageId, step, receivedAt, signature, planId, shipmentIds, fbaSplit,
 *   awdShare: { lines, handoffAt, remindedAt, awdShipmentId, labelsSentAt },
 *   error, updatedAt }
 * step: claimed | plan_created | packing_confirmed | quoted | confirmed |
 *       labels_sent | held | invalid_replied | done | failed
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY = 864e5;
const CORRECTION_RE = /\b(sorry|correction|instead|actually)\b/i;
const NOT_BOOKED = new Set(['invalid_replied', 'held']);

export function loadState(path) {
  if (!existsSync(path)) return { messages: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`amazon-inbound state at ${path} is unreadable: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.messages !== 'object' || parsed.messages === null) {
    throw new Error(`amazon-inbound state at ${path} is invalid: no messages object`);
  }
  return parsed;
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path);
}

export function planName(messageId) {
  return 'culina-' + createHash('sha256').update(String(messageId)).digest('hex').slice(0, 8);
}

function bookedInWindow(state, { messageId, resendOf, receivedAt, windowDays }) {
  const now = Date.parse(receivedAt);
  return Object.values(state?.messages || {}).filter((r) => {
    if (!r || r.messageId === messageId || r.messageId === resendOf) return false;
    if (!r.signature || NOT_BOOKED.has(r.step)) return false;
    const t = Date.parse(r.receivedAt);
    if (!Number.isFinite(t) || !Number.isFinite(now)) return false;
    const age = now - t;
    return age >= 0 && age <= windowDays * DAY;
  });
}

export function duplicateCheck(state, { messageId, signature, text, receivedAt, windowDays, resendOf }) {
  if (resendOf && messageId === resendOf) return { hold: false };
  const booked = bookedInWindow(state, { messageId, resendOf, receivedAt, windowDays });
  const same = booked.find((r) => r.signature === signature);
  if (same) {
    return { hold: true, reason: `same order as message ${same.messageId} booked within ${windowDays} days` };
  }
  if (CORRECTION_RE.test(text || '') && booked.length) {
    return { hold: true, reason: `reads as a correction and message ${booked[0].messageId} was booked within ${windowDays} days` };
  }
  return { hold: false };
}

export function manualBookingCheck(lines, laterShipments, receivedAt) {
  const since = Date.parse(receivedAt);
  const sums = {};
  const covering = [];
  const wanted = new Set(lines.map((l) => l.sku));
  for (const s of laterShipments || []) {
    if (!(Date.parse(s.createdAt) >= since)) continue;
    let used = false;
    for (const [sku, n] of Object.entries(s.casesBySku || {})) {
      if (!wanted.has(sku) || !(n > 0)) continue;
      sums[sku] = (sums[sku] || 0) + n;
      used = true;
    }
    if (used) covering.push(s.id);
  }
  const all = lines.length > 0 && lines.every((l) => (sums[l.sku] || 0) >= l.cases);
  if (all) return { verdict: 'placed', covering };
  const any = lines.some((l) => (sums[l.sku] || 0) > 0);
  return { verdict: any ? 'partial' : 'none', covering: any ? covering : [] };
}

function shareMap(lines) {
  const m = {};
  for (const l of lines || []) m[l.sku] = (m[l.sku] || 0) + l.cases;
  return m;
}

function sameMap(a, b) {
  const ka = Object.keys(a).filter((k) => a[k] > 0).sort();
  const kb = Object.keys(b).filter((k) => b[k] > 0).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function matchAwdShipment(pendingShares, awdShipments) {
  const used = new Set();
  const out = [];
  const shares = [...(pendingShares || [])].sort((a, b) => Date.parse(a.handoffAt) - Date.parse(b.handoffAt));
  for (const share of shares) {
    const want = shareMap(share.lines);
    const hit = (awdShipments || []).find((s) =>
      !used.has(s.shipmentId)
      && Date.parse(s.createdAt) > Date.parse(share.handoffAt)
      && sameMap(want, s.casesBySku || {}));
    if (hit) {
      used.add(hit.shipmentId);
      out.push({ messageId: share.messageId, shipmentId: hit.shipmentId });
    }
  }
  return out;
}
