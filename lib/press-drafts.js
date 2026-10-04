// lib/press-drafts.js
//
// The approval queue for press-outreach. A FIRST pitch (kind "pitch") and a
// late re-open of an old thread (kind "bump") never send without Sean's
// approval; the sender reads only status "approved".
//
// Drafts hold a writer's address, so they live under data/press/ (gitignored,
// in the `press` offsite backup) exactly like the contact book. Never commit one.
//
// Expiry runs from CREATION, not approval: a draft opens with "your piece last
// week", and approving it late does not make that sentence true again.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export const DRAFTS_DIR = 'data/press/drafts';
export const DRAFT_KINDS = Object.freeze(['pitch', 'bump']);
export const DRAFT_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'sent']);
export const DEFAULT_EXPIRY_DAYS = 14;
const EDITABLE = ['subject', 'text'];

const iso = (ms) => new Date(ms).toISOString();

export function newDraft({ kind, contactId, to, subject, text, inReplyTo = null, references = [], source = 'manual', targetUrl = null, openerQuote = null, products = [], concept, now = Date.now() }) {
  if (!DRAFT_KINDS.includes(kind)) throw new Error(`draft kind must be ${DRAFT_KINDS.join('/')}`);
  for (const [k, v] of Object.entries({ contactId, to, subject, text, concept })) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`draft needs ${k}`);
  }
  return {
    id: `${iso(now).slice(0, 10).replace(/-/g, '')}-${contactId}-${kind}`,
    kind, contact_id: contactId, to: to.toLowerCase(), subject, text,
    in_reply_to: inReplyTo, references, source, target_url: targetUrl, opener_quote: openerQuote,
    products, concept, status: 'pending', created_at: iso(now),
  };
}

function editable(d, verb) {
  if (d.status === 'sent') throw new Error(`cannot ${verb} a draft that was already sent`);
  if (d.status === 'expired') throw new Error(`cannot ${verb} an expired draft`);
}

export function approveDraft(d, { now = Date.now(), edits = {} } = {}) {
  editable(d, 'approve');
  const patch = {};
  for (const k of EDITABLE) if (typeof edits[k] === 'string' && edits[k].trim()) patch[k] = edits[k];
  return { ...d, ...patch, edited: Object.keys(patch).length > 0 || d.edited === true, status: 'approved', approved_at: iso(now) };
}

export function rejectDraft(d, { now = Date.now(), reason } = {}) {
  editable(d, 'reject');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('a rejection needs a reason');
  return { ...d, status: 'rejected', rejected_at: iso(now), rejected_reason: reason.trim() };
}

export function markSent(d, { now = Date.now(), messageId, resendId = null }) {
  if (d.status !== 'approved') throw new Error('only an approved draft can be sent');
  return { ...d, status: 'sent', sent_at: iso(now), message_id: messageId, resend_id: resendId };
}

export function expireDrafts(drafts, nowMs, days = DEFAULT_EXPIRY_DAYS) {
  const expired = [];
  const out = drafts.map((d) => {
    if (!['pending', 'approved'].includes(d.status)) return d;
    if (nowMs - Date.parse(d.created_at) <= days * 86_400_000) return d;
    const e = { ...d, status: 'expired', expired_at: iso(nowMs) };
    expired.push(e);
    return e;
  });
  return { drafts: out, expired };
}

export function sendOrder(drafts) {
  return drafts.filter((d) => d.status === 'approved')
    .sort((a, b) => a.approved_at.localeCompare(b.approved_at) || a.id.localeCompare(b.id));
}

export function loadDrafts(dir = DRAFTS_DIR, fsImpl = nodeFs) {
  let names = [];
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fsImpl.readFileSync(join(dir, n), 'utf8')));
}

export function saveDraft(dir = DRAFTS_DIR, d, fsImpl = nodeFs) {
  fsImpl.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${d.id}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fsImpl.renameSync(tmp, path);
}
