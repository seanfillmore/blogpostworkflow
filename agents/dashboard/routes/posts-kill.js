// agents/dashboard/routes/posts-kill.js
//
// POST /api/posts/:slug/kill — kill an article end-to-end. Delegates to
// lib/post-kill.js so the same logic powers the CLI script.

import { killPost } from '../../../lib/post-kill.js';
import { readJsonBody } from '../lib/responses.js';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/posts\/[^/]+\/kill$/.test(url),
    async handler(req, res, ctx) {
      const slug = decodeURIComponent(req.url.split('/')[3]);
      try {
        const body = await readJsonBody(req);
        const reason = body.reason || 'killed via dashboard';
        const result = await killPost(slug, { reason });
        ctx.invalidateDataCache();
        respondJson(res, { ok: true, slug, ...result });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 500);
      }
    },
  },
];
