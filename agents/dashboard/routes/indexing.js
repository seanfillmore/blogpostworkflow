// agents/dashboard/routes/indexing.js
// Indexing queue approval routes — wraps agents/indexing-fixer --approve <slug>.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseSlug(url, prefix) {
  return url.slice(prefix.length).split('/')[0];
}

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/indexing-queue\/[^/]+\/approve$/.test(url),
    handler(req, res, ctx) {
      const slug = parseSlug(req.url, '/api/indexing-queue/');
      // Run the fixer with --approve <slug>. Stream stdout/stderr to the client.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const child = spawn(
        'node',
        [join(ctx.ROOT, 'agents/indexing-fixer/index.js'), '--approve', slug],
        { cwd: ctx.ROOT },
      );
      const send = (line) => res.write(`data: ${line}\n\n`);
      child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(send));
      child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => send(`[stderr] ${l}`)));
      child.on('close', (code) => {
        res.write(`data: __exit__:${JSON.stringify({ code })}\n\n`);
        res.end();
        ctx.invalidateDataCache?.();
      });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/indexing-queue\/[^/]+\/dismiss$/.test(url),
    handler(req, res, ctx) {
      const slug = parseSlug(req.url, '/api/indexing-queue/');
      const file = join(ctx.ROOT, 'data', 'performance-queue', 'indexing-submissions.json');
      if (!existsSync(file)) return respondJson(res, { ok: false, error: 'queue empty' }, 404);
      try {
        const q = JSON.parse(readFileSync(file, 'utf8'));
        const item = q.items.find((x) => x.slug === slug);
        if (!item) return respondJson(res, { ok: false, error: 'not found' }, 404);
        item.status = 'dismissed';
        item.updated_at = new Date().toISOString();
        // inline write — no need for a shared helper for one call
        import('node:fs').then(({ writeFileSync }) => {
          writeFileSync(file, JSON.stringify(q, null, 2));
          ctx.invalidateDataCache?.();
          respondJson(res, { ok: true });
        }).catch((err) => respondJson(res, { ok: false, error: err.message }, 500));
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 500);
      }
    },
  },
  // Resubmit a URL to Google's Indexing API
  {
    method: 'POST',
    match: (url) => /^\/api\/indexing\/resubmit$/.test(url),
    async handler(req, res, ctx) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        try {
          const { url: pageUrl } = JSON.parse(body);
          if (!pageUrl) return respondJson(res, { ok: false, error: 'Missing url' }, 400);
          const { submitUrlForIndexing } = await import('../../../lib/gsc-indexing.js');
          const result = await submitUrlForIndexing(pageUrl);
          ctx.invalidateDataCache?.();
          respondJson(res, { ok: true, result });
        } catch (err) {
          respondJson(res, { ok: false, error: err.message }, 502);
        }
      });
    },
  },
];
