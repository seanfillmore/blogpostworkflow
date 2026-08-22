// agents/dashboard/routes/campaigns.js
// Per-campaign routes: get, approve, dismiss, clarify, resolve alert.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readJsonBody } from '../lib/responses.js';

function campaignsDir(ctx) {
  return join(ctx.ROOT, 'data', 'campaigns');
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

export default [
  // Order matters: more-specific (longer) patterns must come before the bare `/:id` match.
  {
    method: 'POST',
    match: (url) => /^\/api\/campaigns\/[\w-]+\/approve$/.test(url),
    async handler(req, res, ctx) {
      const id = req.url.split('/')[3];
      try {
        const { approvedBudget } = await readJsonBody(req);
        if (!approvedBudget || approvedBudget <= 0) throw new Error('approvedBudget must be a positive number');
        const file = join(campaignsDir(ctx), `${id}.json`);
        if (!existsSync(file)) return notFound(res);
        const campaign = JSON.parse(readFileSync(file, 'utf8'));
        campaign.proposal.approvedBudget = approvedBudget;
        campaign.status = 'approved';
        writeFileSync(file, JSON.stringify(campaign, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        // Never echo err.message: it can originate from readFileSync/JSON.parse and
        // carry an absolute filesystem path. Same pattern as router.js's failRoute —
        // fixed generic body, real detail to stderr for PM2. Status code unchanged.
        console.error(`[campaigns] error in ${req.method} ${req.url}:`, err?.stack || err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid request' }));
      }
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/campaigns\/[\w-]+\/dismiss$/.test(url),
    handler(req, res, ctx) {
      const id = req.url.split('/')[3];
      const file = join(campaignsDir(ctx), `${id}.json`);
      if (!existsSync(file)) return notFound(res);
      const campaign = JSON.parse(readFileSync(file, 'utf8'));
      campaign.status = 'dismissed';
      writeFileSync(file, JSON.stringify(campaign, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/campaigns\/[\w-]+\/clarify$/.test(url),
    async handler(req, res, ctx) {
      const id = req.url.split('/')[3];
      try {
        const { clarificationResponse } = await readJsonBody(req);
        if (typeof clarificationResponse !== 'string' || !clarificationResponse.trim()) throw new Error('clarificationResponse must be a non-empty string');
        const file = join(campaignsDir(ctx), `${id}.json`);
        if (!existsSync(file)) return notFound(res);
        const campaign = JSON.parse(readFileSync(file, 'utf8'));
        campaign.clarificationResponse = clarificationResponse.trim();
        writeFileSync(file, JSON.stringify(campaign, null, 2));
        spawn('node', [join(ctx.ROOT, 'agents/campaign-analyzer/index.js'), '--campaign', id], { cwd: ctx.ROOT, detached: true, stdio: 'ignore' }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        // Same as the /approve catch above: fixed generic body, real detail to stderr.
        console.error(`[campaigns] error in ${req.method} ${req.url}:`, err?.stack || err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid request' }));
      }
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/campaigns\/[\w-]+\/alerts\/[\w_]+\/resolve$/.test(url),
    handler(req, res, ctx) {
      const parts = req.url.split('/');
      const id = parts[3];
      const alertType = parts[5];
      const file = join(campaignsDir(ctx), `${id}.json`);
      if (!existsSync(file)) return notFound(res);
      const campaign = JSON.parse(readFileSync(file, 'utf8'));
      const alert = campaign.alerts.find((a) => a.type === alertType && !a.resolved);
      if (alert) { alert.resolved = true; writeFileSync(file, JSON.stringify(campaign, null, 2)); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  },
  {
    method: 'GET',
    match: (url) => /^\/api\/campaigns\/[\w-]+$/.test(url),
    handler(req, res, ctx) {
      const id = req.url.split('/')[3];
      const file = join(campaignsDir(ctx), `${id}.json`);
      if (!existsSync(file)) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readFileSync(file, 'utf8'));
    },
  },
];
