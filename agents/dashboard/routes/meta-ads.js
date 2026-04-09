// agents/dashboard/routes/meta-ads.js
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export default [
  {
    method: 'GET',
    match: '/api/meta-ads-insights',
    handler(req, res, ctx) {
      if (!existsSync(ctx.META_ADS_INSIGHTS_DIR)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
      const files = readdirSync(ctx.META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
      if (!files.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
      try {
        const data = readFileSync(join(ctx.META_ADS_INSIGHTS_DIR, files[0]), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch { res.writeHead(500); res.end('{}'); }
    },
  },
];
