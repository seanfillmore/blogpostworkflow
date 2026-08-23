// agents/dashboard/routes/ideas.js
import { loadCalendar, upsertItem } from '../../../lib/calendar-store.js';
import { join } from 'node:path';
// The SHARED helper, not a local copy. This module used to carry its own byte-identical
// clone, which meant it also carried the `JSON.parse('null')` process-kill fixed in
// lib/responses.js on 2026-08-17 — a central fix that two route modules opt out of by
// re-implementing is not a central fix. See that function's docstring.
import { readJsonBody } from '../lib/responses.js';
import { appendRejection } from '../../../lib/rejected-keywords.js';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getReviewItems() {
  return loadCalendar().items.filter((i) => i.status === 'review');
}

export default [
  // GET /api/ideas — all items pending human review
  {
    method: 'GET',
    match: (url) => url === '/api/ideas',
    handler(req, res) {
      respondJson(res, { ok: true, items: getReviewItems() });
    },
  },

  // PATCH /api/ideas/:slug — edit keyword and/or title before approving
  {
    method: 'PATCH',
    match: (url) => /^\/api\/ideas\/[^/]+$/.test(url),
    // lib/router.js's dispatch() guards the promise this handler returns (a rejection gets
    // a fixed 500) and lib/fatal-reporter.js backstops anything that still escapes as an
    // unhandledRejection/uncaughtException, so an unguarded throw here would no longer take
    // down the shared seo-dashboard PM2 process — but it would still fail this request with
    // the router's generic, non-specific error. This handler had three ways to throw: an
    // unguarded `await readJsonBody` (malformed JSON), a destructure of a `null` body, and
    // `keyword.trim()` on a non-string. Guarded the same "whole handler body" way
    // routes/ad-brief.js documents, so each failure mode gets its own status and message.
    async handler(req, res) {
      try {
        const slug = decodeURIComponent(req.url.split('/').pop());
        let body;
        try { body = await readJsonBody(req); } catch { return respondJson(res, { ok: false, error: 'bad JSON body' }, 400); }
        const { keyword, title } = body;

        const calendar = loadCalendar();
        const item = calendar.items.find((i) => i.slug === slug);
        if (!item) return respondJson(res, { ok: false, error: 'Not found' }, 404);
        if (item.status !== 'review') return respondJson(res, { ok: false, error: 'Item is not in review status' }, 400);

        const updates = { slug };
        // String() before trim(): a JSON body may legally send a number or an object here.
        if (keyword !== undefined) updates.keyword = String(keyword).trim();
        if (title !== undefined) updates.title = String(title).trim();

        upsertItem({ ...item, ...updates });
        respondJson(res, { ok: true });
      } catch {
        respondJson(res, { ok: false, error: 'could not update that idea' }, 500);
      }
    },
  },

  // POST /api/ideas/:slug/approve — move item into the writing pipeline
  {
    method: 'POST',
    match: (url) => /^\/api\/ideas\/[^/]+\/approve$/.test(url),
    async handler(req, res) {
      const slug = decodeURIComponent(req.url.split('/').slice(-2, -1)[0]);

      const calendar = loadCalendar();
      const item = calendar.items.find((i) => i.slug === slug);
      if (!item) return respondJson(res, { ok: false, error: 'Not found' }, 404);

      upsertItem({ ...item, status: null });
      respondJson(res, { ok: true });
    },
  },

  // POST /api/ideas/:slug/reject — remove from calendar, add to rejected list
  {
    method: 'POST',
    match: (url) => /^\/api\/ideas\/[^/]+\/reject$/.test(url),
    async handler(req, res, ctx) {
      const slug = decodeURIComponent(req.url.split('/').slice(-2, -1)[0]);

      const calendar = loadCalendar();
      const item = calendar.items.find((i) => i.slug === slug);
      if (!item) return respondJson(res, { ok: false, error: 'Not found' }, 404);

      // Add to rejected-keywords.json — through the shared writer, which
      // re-reads and merges before writing. This route runs inside the
      // long-lived PM2 process while agents/content-strategist writes the same
      // file from the 15:00 UTC cron; the old local read → push → write lost
      // whichever finished second. Its dedupe was also case-SENSITIVE, so
      // "Real Soap" and "real soap" both landed.
      appendRejection({
        keyword: item.keyword,
        slug: item.slug,
        rejected_at: new Date().toISOString(),
        source: 'dashboard:ideas-reject',
      }, { path: join(ctx.ROOT, 'data', 'rejected-keywords.json') });

      // Remove from calendar
      const updatedItems = calendar.items.filter((i) => i.slug !== slug);
      const { writeCalendar } = await import('../../../lib/calendar-store.js');
      writeCalendar({ items: updatedItems, preserve_metadata: true });

      respondJson(res, { ok: true });
    },
  },
];
