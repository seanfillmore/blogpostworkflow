// agents/dashboard/routes/misc.js
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default [
  {
    method: 'GET',
    match: (url) => url.startsWith('/screenshot?'),
    handler(req, res, ctx) {
      const urlObj = new URL(req.url, 'http://localhost');
      const imgPath = urlObj.searchParams.get('path');
      const resolved = join(ctx.ROOT, imgPath || '');
      if (!resolved.startsWith(ctx.COMP_SCREENSHOTS_DIR) || !existsSync(resolved)) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(readFileSync(resolved));
    },
  },
  {
    method: 'GET',
    match: (url) => url.startsWith('/images/'),
    handler(req, res, ctx) {
      const slug = req.url.slice('/images/'.length).split('?')[0];
      if (!/^[a-z0-9-]+$/.test(slug)) { res.writeHead(400); res.end('Bad request'); return; }
      const webp = join(ctx.IMAGES_DIR, `${slug}.webp`);
      const png  = join(ctx.IMAGES_DIR, `${slug}.png`);
      const imgPath = existsSync(webp) ? webp : existsSync(png) ? png : null;
      if (!imgPath) { res.writeHead(404); res.end('Not found'); return; }
      const ct = imgPath.endsWith('.webp') ? 'image/webp' : 'image/png';
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
      createReadStream(imgPath).on('error', () => { res.end(); }).pipe(res);
    },
  },
];
