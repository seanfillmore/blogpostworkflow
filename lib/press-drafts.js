// lib/press-drafts.js
//
// The approval queue for press-outreach. A FIRST pitch (kind "pitch") and a
// model-written follow-up (kind "followup", n 1 or 2) never send without
// Sean's approval; the sender reads only status "approved". Kind "bump" (the
// old fixed-template re-open of a September thread) stays readable for drafts
// already on disk; nothing creates one any more.
//
// Drafts hold a writer's address, so they live under data/press/ (gitignored,
// in the `press` offsite backup) exactly like the contact book. Never commit one.
//
// Expiry runs from CREATION, not approval: a draft opens with "your piece last
// week", and approving it late does not make that sentence true again.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export const DRAFTS_DIR = 'data/press/drafts';
export const DRAFT_KINDS = Object.freeze(['pitch', 'followup', 'bump']);
export const FOLLOWUP_NS = Object.freeze([1, 2]);
export const DRAFT_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'sent']);
export const DEFAULT_EXPIRY_DAYS = 14;
const EDITABLE = ['subject', 'text'];

const iso = (ms) => new Date(ms).toISOString();

export function newDraft({ kind, contactId, to, subject, text, inReplyTo = null, references = [], source = 'manual', targetUrl = null, openerQuote = null, products = [], concept, n = null, now = Date.now() }) {
  if (!DRAFT_KINDS.includes(kind)) throw new Error(`draft kind must be ${DRAFT_KINDS.join('/')}`);
  if (kind === 'followup' && !FOLLOWUP_NS.includes(n)) throw new Error('a followup draft needs n of 1 or 2');
  for (const [k, v] of Object.entries({ contactId, to, subject, text, concept })) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`draft needs ${k}`);
  }
  return {
    // One id per contact, kind (and follow-up number) and day.
    id: `${iso(now).slice(0, 10).replace(/-/g, '')}-${contactId}-${kind}${kind === 'followup' ? n : ''}`,
    kind, ...(kind === 'followup' ? { n } : {}), contact_id: contactId, to: to.toLowerCase(), subject, text,
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
  const result = { ...d, ...patch, edited: Object.keys(patch).length > 0 || d.edited === true, status: 'approved', approved_at: iso(now) };
  // Drop rejected metadata when changing mind (approving a rejected draft)
  delete result.rejected_at;
  delete result.rejected_reason;
  return result;
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

/**
 * Every draft in `dir`. A file that cannot be read or parsed is SKIPPED, never
 * thrown: one half-written file must not stop every run and the dashboard tab.
 * `onError(name, err)` hears about each one (default: a console warning).
 */
export function loadDrafts(dir = DRAFTS_DIR, fsImpl = nodeFs, { onError = (name, err) => console.warn(`press-drafts: skipped unreadable ${name}: ${err.message}`) } = {}) {
  let names = [];
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try { out.push(JSON.parse(fsImpl.readFileSync(join(dir, n), 'utf8'))); } catch (err) {
      try { onError(n, err); } catch { /* reporting must not throw either */ }
    }
  }
  return out;
}

export function saveDraft(dir = DRAFTS_DIR, d, fsImpl = nodeFs) {
  fsImpl.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${d.id}.json`);

  // Two guards against clobbering a draft already on disk:
  // - a SENT draft is only ever rewritten by another 'sent' write;
  // - an APPROVED draft is only ever rewritten by the SAME draft (same
  //   created_at): its edit, rejection, expiry or 'sent' transition. A fresh
  //   draft that happens to share the id (a second drafting run the same day
  //   for the same contact) must never replace what Sean approved.
  let existing = null;
  try {
    const data = fsImpl.readFileSync(path, 'utf8');
    // Handle both real fs (throws) and fake fs (returns undefined)
    if (data) existing = JSON.parse(data);
  } catch (e) {
    // ENOENT: the file does not exist yet (expected)
    if (e.code !== 'ENOENT') throw e;
  }
  if (existing) {
    if (existing.status === 'sent' && d.status !== 'sent') throw new Error(`cannot overwrite sent draft ${d.id}`);
    if (existing.status === 'approved' && existing.created_at !== d.created_at) {
      throw new Error(`cannot overwrite approved draft ${d.id} with a different draft`);
    }
  }

  const tmp = `${path}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fsImpl.renameSync(tmp, path);
}
