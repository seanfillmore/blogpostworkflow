// agents/dashboard/routes/agents.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readJsonBody } from '../lib/responses.js';

export default [
  {
    method: 'POST',
    match: '/run-agent',
    // MUST return the call: ctx.runAgent is async (readJsonBody), and dispatch() in
    // lib/router.js only guards a rejection it can see on the value THIS handler
    // returns. Calling without returning would let a body-read rejection become an
    // unhandled rejection outside the guard's reach.
    handler(req, res, ctx) {
      return ctx.runAgent(req, res);
    },
  },
  {
    // Start a long-running agent decoupled from the request (returns a jobId);
    // poll /run-job for output. Avoids the proxy's ~100s 524 on SSE runs.
    method: 'POST',
    match: '/run-agent-bg',
    // MUST return — same reason as /run-agent above.
    handler(req, res, ctx) {
      return ctx.bgRunStart(req, res);
    },
  },
  {
    method: 'GET',
    match: (url) => url.startsWith('/run-job'),
    handler(req, res, ctx) {
      ctx.bgRunPoll(req, res);
    },
  },
  {
    method: 'POST',
    match: (url) => url.startsWith('/brief/'),
    async handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'brief', slug, 'change', id]
      const slug = parts[2], id = parts[4];
      if (!slug || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing slug or id' })); return; }
      let status;
      try { ({ status } = await readJsonBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      if (!['approved', 'rejected'].includes(status)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'status must be approved or rejected' })); return; }
      const briefPath = join(ctx.COMP_BRIEFS_DIR, `${slug}.json`);
      if (!existsSync(briefPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Brief not found' })); return; }
      const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
      const change = brief.proposed_changes?.find(c => c.id === id);
      if (!change) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Change not found' })); return; }
      change.status = status;
      writeFileSync(briefPath, JSON.stringify(brief, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, change }));
    },
  },
  {
    method: 'POST',
    match: (url) => url.startsWith('/apply/'),
    handler(req, res, ctx) {
      const slug = req.url.slice('/apply/'.length);
      const briefPath = join(ctx.COMP_BRIEFS_DIR, `${slug}.json`);
      if (!existsSync(briefPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Brief not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const child = spawn('node', [join(ctx.ROOT, 'agents', 'apply-optimization', 'index.js'), slug], { cwd: ctx.ROOT });
      child.stdout.on('data', d => {
        for (const line of String(d).split('\n').filter(Boolean)) {
          if (line.startsWith('DONE ')) {
            try { res.write(`event: done\ndata: ${JSON.stringify(JSON.parse(line.slice(5)))}\n\n`); }
            catch { res.write(`event: done\ndata: {}\n\n`); }
          } else {
            res.write(`data: ${line}\n\n`);
          }
        }
      });
      child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => res.write(`data: [err] ${l}\n\n`)));
      child.on('close', () => res.end());
    },
  },
  {
    method: 'POST',
    match: '/dismiss-alert',
    handler(req, res, ctx) {
      mkdirSync(ctx.RANK_ALERTS_DIR, { recursive: true });
      writeFileSync(ctx.ALERTS_VIEWED, new Date().toISOString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  },
];
