// agents/dashboard/routes/uploads.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default [
  {
    method: 'POST',
    match: '/upload/rank-snapshot',
    handler(req, res, ctx) {
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        const rawName = req.headers['x-filename'] || 'keywords.csv';
        const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
        mkdirSync(ctx.KEYWORD_TRACKER_DIR, { recursive: true });
        writeFileSync(join(ctx.KEYWORD_TRACKER_DIR, filename), Buffer.concat(chunks));
        ctx.invalidateDataCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, filename }));
      });
    },
  },
];
