// agents/dashboard/routes/uploads.js
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export default [
  {
    method: 'POST',
    match: '/upload/ahrefs',
    handler(req, res, ctx) {
      mkdirSync(ctx.AHREFS_DIR, { recursive: true });
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        const rawName = req.headers['x-filename'] || 'ahrefs-upload.csv';
        const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
        writeFileSync(join(ctx.AHREFS_DIR, filename), Buffer.concat(chunks));
        ctx.invalidateDataCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, filename, saved_at: new Date().toISOString() }));
      });
    },
  },
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
    match: '/upload/ahrefs-keyword-zip',
    handler(req, res, ctx) {
      const slug = (req.headers['x-slug'] || '').replace(/[^a-z0-9-]/g, '');
      if (!slug) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing or invalid X-Slug header' }));
        return;
      }
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', async () => {
        const destDir = join(ctx.AHREFS_DIR, slug);
        const tmpZip  = join(destDir, '.upload.zip');
        try {
          mkdirSync(destDir, { recursive: true });
          writeFileSync(tmpZip, Buffer.concat(chunks));
          const extract = (await import('extract-zip')).default;
          await extract(tmpZip, { dir: destDir });
          const { unlinkSync, renameSync, rmdirSync } = await import('node:fs');
          unlinkSync(tmpZip);
          // Flatten single nested subdirectory (zip may contain a folder with the same name)
          const top = readdirSync(destDir).filter(f => !f.startsWith('.'));
          if (top.length === 1) {
            const sub = join(destDir, top[0]);
            if (statSync(sub).isDirectory()) {
              for (const f of readdirSync(sub)) renameSync(join(sub, f), join(destDir, f));
              rmdirSync(sub);
            }
          }
          const files = readdirSync(destDir).filter(f => !f.startsWith('.'));
          ctx.invalidateDataCache();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, slug, files }));
        } catch (err) {
          try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    },
  },
  {
    method: 'POST',
    match: '/upload/content-gap-zip',
    handler(req, res, ctx) {
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', async () => {
        const tmpZip = join(ctx.CONTENT_GAP_DIR, '.upload.zip');
        try {
          mkdirSync(ctx.CONTENT_GAP_DIR, { recursive: true });
          writeFileSync(tmpZip, Buffer.concat(chunks));
          const extract = (await import('extract-zip')).default;
          await extract(tmpZip, { dir: ctx.CONTENT_GAP_DIR });
          const { unlinkSync } = await import('node:fs');
          unlinkSync(tmpZip);
          const files = readdirSync(ctx.CONTENT_GAP_DIR).filter(f => f.endsWith('.csv'));
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
