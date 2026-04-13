// agents/dashboard/routes/rejected-images.js
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmdirSync, createReadStream, copyFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { getMetaPath, getImagePath } from '../../../lib/posts.js';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export default [
  // Serve a rejected image file
  {
    method: 'GET',
    match: (url) => /^\/api\/rejected-images\/[^/]+\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const parts = req.url.split('/');
      const slug = parts[3];
      const filename = parts[4];
      const filePath = join(ctx.REJECTED_IMAGES_DIR, slug, filename);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filename).toLowerCase();
      const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime });
      createReadStream(filePath).pipe(res);
    },
  },

  // Accept a rejected image — use it as the post image
  {
    method: 'POST',
    match: (url) => /^\/api\/rejected-images\/[^/]+\/accept$/.test(url),
    async handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        try {
          const { filename } = JSON.parse(Buffer.concat(chunks).toString());
          const srcPath = join(ctx.REJECTED_IMAGES_DIR, slug, filename);
          if (!existsSync(srcPath)) return respondJson(res, { ok: false, error: 'Image not found' }, 404);

          // Copy to post directory
          const destPath = getImagePath(slug);
          copyFileSync(srcPath, destPath);

          // Update post metadata
          const metaPath = getMetaPath(slug);
          if (existsSync(metaPath)) {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
            meta.image_path = relative(ctx.ROOT, destPath).replace(/\\/g, '/');
            meta.image_generated_at = new Date().toISOString();
            delete meta.image_blocked;
            delete meta.image_blocked_at;
            delete meta.image_blocked_reason;
            writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          }

          // Clean up rejected directory
          const rejDir = join(ctx.REJECTED_IMAGES_DIR, slug);
          for (const f of readdirSync(rejDir)) unlinkSync(join(rejDir, f));
          try { rmdirSync(rejDir); } catch { /* ignore */ }

          ctx.invalidateDataCache();
          respondJson(res, { ok: true, slug, accepted: filename });
        } catch (err) {
          respondJson(res, { ok: false, error: err.message }, 500);
        }
      });
    },
  },

  // Retry image generation — run the image generator again
  {
    method: 'POST',
    match: (url) => /^\/api\/rejected-images\/[^/]+\/retry$/.test(url),
    handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const metaPath = getMetaPath(slug);
      if (!existsSync(metaPath)) return respondJson(res, { ok: false, error: 'Post not found' }, 404);

      // Clear the blocked flag so the generator can run
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        delete meta.image_blocked;
        delete meta.image_blocked_at;
        delete meta.image_blocked_reason;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch { /* proceed anyway */ }

      // Clean up old rejected images
      const rejDir = join(ctx.REJECTED_IMAGES_DIR, slug);
      if (existsSync(rejDir)) {
        for (const f of readdirSync(rejDir)) unlinkSync(join(rejDir, f));
        try { rmdirSync(rejDir); } catch { /* ignore */ }
      }

      // Remove existing image so the generator will run
      const imgPath = getImagePath(slug);
      if (existsSync(imgPath)) try { unlinkSync(imgPath); } catch { /* ignore */ }

      ctx.invalidateDataCache();
      respondJson(res, { ok: true, message: 'Ready for retry. Run image generator or wait for next pipeline run.' });
    },
  },
];
