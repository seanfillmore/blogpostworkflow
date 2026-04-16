// agents/dashboard/routes/uploads.js
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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
  {
    method: 'POST',
    match: '/upload/tech-seo-zip',
    handler(req, res, ctx) {
      const CSV_DIR = join(ctx.ROOT, 'data', 'technical_seo');
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', async () => {
        const tmpZip = join(CSV_DIR, '.upload.zip');
        try {
          mkdirSync(CSV_DIR, { recursive: true });
          writeFileSync(tmpZip, Buffer.concat(chunks));
          const extract = (await import('extract-zip')).default;
          await extract(tmpZip, { dir: CSV_DIR });
          const { unlinkSync, renameSync, rmdirSync } = await import('node:fs');
          unlinkSync(tmpZip);
          // Flatten single nested subdirectory
          const top = readdirSync(CSV_DIR).filter(f => !f.startsWith('.'));
          if (top.length === 1) {
            const sub = join(CSV_DIR, top[0]);
            if (statSync(sub).isDirectory()) {
              for (const f of readdirSync(sub)) renameSync(join(sub, f), join(CSV_DIR, f));
              rmdirSync(sub);
            }
          }
          const files = readdirSync(CSV_DIR).filter(f => f.endsWith('.csv'));
          ctx.invalidateDataCache();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, files }));
        } catch (err) {
          try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    },
  },
];
