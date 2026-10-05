// agents/dashboard/routes/press-outreach.js
//
// The Outreach tab's API: Sean reviews, edits, approves and rejects the pitch drafts
// agents/press-outreach writes. The sender only ever sends status "approved", so every
// approval path here re-runs the outgoing-copy gate: a draft that fails it can be EDITED
// and saved but never approved.
//
// Drafts hold a writer's address, so the directory is read through ctx.ROOT (tests point
// it at a temp dir) and ids are validated against a strict pattern before any file access.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readJsonBody, respondJson } from '../lib/responses.js';
import { DRAFTS_DIR, loadDrafts, saveDraft, approveDraft, rejectDraft } from '../../../lib/press-drafts.js';
import { checkOutgoingCopy, stripDashes } from '../../../lib/press-outreach.js';

export const ID_RE = /^[0-9]{8}-[a-z0-9-]+-(pitch|bump|followup[12])$/;
const MAX_BODY = 64 * 1024;
const MAX_IDS = 200;

const dirOf = (ctx) => join(ctx.ROOT, DRAFTS_DIR);

function postalAddress(ctx) {
  try {
    const a = JSON.parse(readFileSync(join(ctx.ROOT, 'data/brand/brand-kit.json'), 'utf8')).postal_address;
    return typeof a === 'string' && a.trim() ? a : undefined;
  } catch { return undefined; }
}

const gateOf = (d, ctx) => checkOutgoingCopy({ subject: d.subject, text: d.text, kind: d.kind, postalAddress: postalAddress(ctx) });

function findDraft(id, ctx) {
  return loadDrafts(dirOf(ctx)).find((d) => d.id === id) || null;
}

function idFromUrl(url, index) {
  const parts = url.split('?')[0].split('/');
  try { return decodeURIComponent(parts[index]); } catch { return ''; }
}

/** Approve one draft by id. Returns { status, body } so the single and bulk routes share it. */
function approveOne(id, ctx) {
  if (!ID_RE.test(id)) return { status: 400, body: { ok: false, error: 'bad draft id' } };
  const d = findDraft(id, ctx);
  if (!d) return { status: 404, body: { ok: false, error: 'draft not found' } };
  if (d.status !== 'pending') return { status: 409, body: { ok: false, error: `draft is ${d.status}, not pending` } };
  const gate = gateOf(d, ctx);
  if (!gate.ok) return { status: 422, body: { ok: false, problems: gate.problems } };
  saveDraft(dirOf(ctx), approveDraft(d));
  return { status: 200, body: { ok: true } };
}

async function body(req, res) {
  try { return await readJsonBody(req, { maxBytes: MAX_BODY }); } catch {
    respondJson(res, { ok: false, error: 'bad JSON body' }, 400);
    return null;
  }
}

const FAIL = { ok: false, error: 'internal error' };

export default [
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/press/drafts',
    handler(req, res, ctx) {
      try {
        const drafts = loadDrafts(dirOf(ctx))
          .filter((d) => d.status === 'pending' || d.status === 'approved')
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
          .map((d) => ({ ...d, gate: gateOf(d, ctx) }));
        respondJson(res, { ok: true, drafts });
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/press/drafts/approve',
    async handler(req, res, ctx) {
      try {
        const b = await body(req, res);
        if (!b) return;
        if (!Array.isArray(b.ids) || b.ids.length > MAX_IDS) return respondJson(res, { ok: false, error: 'ids must be a list' }, 400);
        const results = {};
        for (const id of b.ids) {
          const key = String(id);
          const r = approveOne(key, ctx);
          results[key] = { ...r.body, status: r.status };
        }
        respondJson(res, { ok: true, results });
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'POST',
    match: (url) => /^\/api\/press\/drafts\/[^/]+\/approve(\?.*)?$/.test(url),
    async handler(req, res, ctx) {
      try {
        const b = await body(req, res);
        if (!b) return;
        const r = approveOne(idFromUrl(req.url, 4), ctx);
        respondJson(res, r.body, r.status);
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'POST',
    match: (url) => /^\/api\/press\/drafts\/[^/]+\/reject(\?.*)?$/.test(url),
    async handler(req, res, ctx) {
      try {
        const id = idFromUrl(req.url, 4);
        if (!ID_RE.test(id)) return respondJson(res, { ok: false, error: 'bad draft id' }, 400);
        const b = await body(req, res);
        if (!b) return;
        if (typeof b.reason !== 'string' || !b.reason.trim()) return respondJson(res, { ok: false, error: 'a rejection needs a reason' }, 400);
        const d = findDraft(id, ctx);
        if (!d) return respondJson(res, { ok: false, error: 'draft not found' }, 404);
        if (d.status !== 'pending' && d.status !== 'approved') return respondJson(res, { ok: false, error: `draft is ${d.status}` }, 409);
        saveDraft(dirOf(ctx), rejectDraft(d, { reason: b.reason }));
        respondJson(res, { ok: true });
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'PATCH',
    match: (url) => /^\/api\/press\/drafts\/[^/]+(\?.*)?$/.test(url),
    async handler(req, res, ctx) {
      try {
        const id = idFromUrl(req.url, 4);
        if (!ID_RE.test(id)) return respondJson(res, { ok: false, error: 'bad draft id' }, 400);
        const b = await body(req, res);
        if (!b) return;
        const d = findDraft(id, ctx);
        if (!d) return respondJson(res, { ok: false, error: 'draft not found' }, 404);
        if (d.status !== 'pending' && d.status !== 'approved') return respondJson(res, { ok: false, error: `draft is ${d.status}` }, 409);
        const next = { ...d };
        for (const k of ['subject', 'text']) {
          if (b[k] !== undefined) {
            if (typeof b[k] !== 'string' || !b[k].trim()) return respondJson(res, { ok: false, error: `${k} must be non-empty text` }, 400);
            next[k] = stripDashes(b[k]);
          }
        }
        next.edited = true;
        const gate = gateOf(next, ctx);
        // An edit that fails the gate is still saved, but an approved draft that no longer
        // passes goes back to pending so the sender cannot pick it up.
        if (!gate.ok && next.status === 'approved') { next.status = 'pending'; delete next.approved_at; }
        saveDraft(dirOf(ctx), next);
        if (!gate.ok) return respondJson(res, { ok: false, problems: gate.problems }, 422);
        respondJson(res, { ok: true, draft: { ...next, gate } });
      } catch { respondJson(res, FAIL, 500); }
    },
  },
];
