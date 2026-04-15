// agents/dashboard/routes/ideas.js
import { loadCalendar, upsertItem } from '../../../lib/calendar-store.js';
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
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
    async handler(req, res) {
      const slug = decodeURIComponent(req.url.split('/').pop());
      const body = await readJsonBody(req);
      const { keyword, title } = body;

      const calendar = loadCalendar();
      const item = calendar.items.find((i) => i.slug === slug);
      if (!item) return respondJson(res, { ok: false, error: 'Not found' }, 404);
      if (item.status !== 'review') return respondJson(res, { ok: false, error: 'Item is not in review status' }, 400);

      const updates = { slug };
      if (keyword !== undefined) updates.keyword = keyword.trim();
      if (title !== undefined) updates.title = title.trim();

      upsertItem({ ...item, ...updates });
      respondJson(res, { ok: true });
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

      // Add to rejected-keywords.json
      const rejectedPath = join(ctx.ROOT, 'data', 'rejected-keywords.json');
      const rejected = existsSync(rejectedPath) ? JSON.parse(readFileSync(rejectedPath, 'utf8')) : [];
      if (!rejected.find((r) => r.keyword === item.keyword)) {
        rejected.push({ keyword: item.keyword, slug: item.slug, rejected_at: new Date().toISOString() });
        writeFileSync(rejectedPath, JSON.stringify(rejected, null, 2));
      }

      // Remove from calendar
      const updatedItems = calendar.items.filter((i) => i.slug !== slug);
      const { writeCalendar } = await import('../../../lib/calendar-store.js');
      writeCalendar({ items: updatedItems, preserve_metadata: true });

      respondJson(res, { ok: true });
    },
  },
];
