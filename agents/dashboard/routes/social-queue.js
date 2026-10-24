// agents/dashboard/routes/social-queue.js
//
// The Social tab's API: Sean reviews the ad images the ingest queued
// (scripts/social-queue-ingest.mjs), edits their captions, and approves or rejects
// them. agents/social-poster posts only status "approved", to Instagram AND the
// Facebook Page, so every approval re-runs the caption gate (lib/social-queue.js):
// a caption that fails it can be EDITED and saved but never approved.
//
// POST /api/social/ingest is how the ingest, which runs on the Mac where the ad
// batches live, delivers new PENDING items to this server. It is behind the same
// basic auth as every other dashboard route, creates only pending items, and is
// idempotent: an id or a source already in the queue is skipped, never replaced.
//
// The directory is read through ctx.ROOT (tests point it at a temp dir) and ids are
// validated against a strict slug pattern before any file access.

import { join } from 'node:path';
import { readJsonBody, respondJson } from '../lib/responses.js';
import {
  ITEMS_DIR, ID_RE, loadItems, readItem, saveItem, newItem, editCaption, approveItem,
  unapproveItem, rejectItem, captionProblems, postingOrder,
} from '../../../lib/social-queue.js';

const MAX_BODY = 64 * 1024;
const MAX_INGEST_BODY = 512 * 1024;
const MAX_IDS = 200;
const MAX_INGEST = 100;

const dirOf = (ctx) => join(ctx.ROOT, ITEMS_DIR);
const withGate = (i) => ({ ...i, gate: { problems: captionProblems(i.caption), ok: captionProblems(i.caption).length === 0 } });
const FAIL = { ok: false, error: 'internal error' };

function idFromUrl(url, index) {
  const parts = url.split('?')[0].split('/');
  try { return decodeURIComponent(parts[index]); } catch { return ''; }
}

async function body(req, res, maxBytes = MAX_BODY) {
  try { return await readJsonBody(req, { maxBytes }); } catch (err) {
    respondJson(res, { ok: false, error: err?.code === 'BODY_TOO_LARGE' ? 'body too large' : 'bad JSON body' }, err?.code === 'BODY_TOO_LARGE' ? 413 : 400);
    return null;
  }
}

/** Run `fn` on one item; returns { status, body } so the single and bulk routes share it. */
function act(id, ctx, fn) {
  if (!ID_RE.test(id)) return { status: 400, body: { ok: false, error: 'bad item id' } };
  const item = readItem(dirOf(ctx), id);
  if (!item) return { status: 404, body: { ok: false, error: 'item not found' } };
  let next;
  try { next = fn(item); } catch (err) {
    if (err.problems) return { status: 422, body: { ok: false, problems: err.problems } };
    return { status: 409, body: { ok: false, error: err.message } };
  }
  saveItem(dirOf(ctx), next);
  return { status: 200, body: { ok: true, item: withGate(next) } };
}

export default [
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/social/items',
    handler(req, res, ctx) {
      try {
        const items = loadItems(dirOf(ctx));
        const posted = (i) => !!(i.instagram?.posted_at || i.facebook?.posted_at);
        const pending = items.filter((i) => i.status === 'pending')
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
        const approved = postingOrder(items).filter((i) => !(i.instagram?.posted_at && i.facebook?.posted_at));
        const done = items.filter((i) => i.status === 'approved' && posted(i))
          .sort((a, b) => String(b.instagram?.posted_at || b.facebook?.posted_at).localeCompare(String(a.instagram?.posted_at || a.facebook?.posted_at)));
        respondJson(res, {
          ok: true,
          pending: pending.map(withGate),
          approved: approved.map(withGate),
          posted: done.map(withGate),
          rejected: items.filter((i) => i.status === 'rejected').length,
          // The ingest asks for these to skip what is already queued before it uploads.
          known: { ids: items.map((i) => i.id), sources: items.map((i) => i.source).filter(Boolean) },
        });
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/social/ingest',
    async handler(req, res, ctx) {
      try {
        const b = await body(req, res, MAX_INGEST_BODY);
        if (!b) return;
        if (!Array.isArray(b.items) || !b.items.length || b.items.length > MAX_INGEST) {
          return respondJson(res, { ok: false, error: `items must be a list of 1 to ${MAX_INGEST}` }, 400);
        }
        const existing = loadItems(dirOf(ctx));
        const ids = new Set(existing.map((i) => i.id));
        const sources = new Set(existing.map((i) => i.source).filter(Boolean));
        const created = [];
        const skipped = [];
        const invalid = [];
        for (const raw of b.items) {
          const id = String(raw?.id || '');
          if (ids.has(id)) { skipped.push({ id, reason: 'id already queued' }); continue; }
          if (raw?.source && sources.has(raw.source)) { skipped.push({ id, reason: 'source already queued' }); continue; }
          let item;
          try { item = newItem(raw); } catch (err) { invalid.push({ id, error: err.message }); continue; }
          saveItem(dirOf(ctx), item);
          ids.add(item.id);
          if (item.source) sources.add(item.source);
          created.push(item.id);
        }
        respondJson(res, { ok: invalid.length === 0, created, skipped, invalid }, invalid.length && !created.length ? 400 : 200);
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/social/items/approve',
    async handler(req, res, ctx) {
      try {
        const b = await body(req, res);
        if (!b) return;
        if (!Array.isArray(b.ids) || b.ids.length > MAX_IDS) return respondJson(res, { ok: false, error: 'ids must be a list' }, 400);
        const results = {};
        for (const id of b.ids) {
          const key = String(id);
          const r = act(key, ctx, (i) => approveItem(i));
          results[key] = { ok: r.body.ok, status: r.status, ...(r.body.problems ? { problems: r.body.problems } : {}), ...(r.body.error ? { error: r.body.error } : {}) };
        }
        respondJson(res, { ok: true, results });
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  ...[
    ['approve', (i) => approveItem(i)],
    ['unapprove', (i) => unapproveItem(i)],
  ].map(([verb, fn]) => ({
    method: 'POST',
    match: (url) => new RegExp(`^/api/social/items/[^/]+/${verb}(\\?.*)?$`).test(url),
    async handler(req, res, ctx) {
      try {
        const b = await body(req, res);
        if (!b) return;
        const r = act(idFromUrl(req.url, 4), ctx, fn);
        respondJson(res, r.body, r.status);
      } catch { respondJson(res, FAIL, 500); }
    },
  })),

  {
    method: 'POST',
    match: (url) => /^\/api\/social\/items\/[^/]+\/reject(\?.*)?$/.test(url),
    async handler(req, res, ctx) {
      try {
        const b = await body(req, res);
        if (!b) return;
        const reason = typeof b.reason === 'string' ? b.reason : '';
        const r = act(idFromUrl(req.url, 4), ctx, (i) => rejectItem(i, { reason }));
        respondJson(res, r.body, r.status);
      } catch { respondJson(res, FAIL, 500); }
    },
  },

  {
    method: 'PATCH',
    match: (url) => /^\/api\/social\/items\/[^/]+(\?.*)?$/.test(url),
    async handler(req, res, ctx) {
      try {
        const id = idFromUrl(req.url, 4);
        if (!ID_RE.test(id)) return respondJson(res, { ok: false, error: 'bad item id' }, 400);
        const b = await body(req, res);
        if (!b) return;
        if (typeof b.caption !== 'string' || !b.caption.trim()) return respondJson(res, { ok: false, error: 'caption must be non-empty text' }, 400);
        const r = act(id, ctx, (i) => editCaption(i, b.caption));
        // The edit is saved either way; a 422 tells the tab it no longer passes.
        if (r.status === 200 && !r.body.item.gate.ok) return respondJson(res, { ok: false, saved: true, item: r.body.item, problems: r.body.item.gate.problems }, 422);
        respondJson(res, r.body, r.status);
      } catch { respondJson(res, FAIL, 500); }
    },
  },
];
