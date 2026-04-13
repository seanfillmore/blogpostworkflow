// agents/dashboard/routes/ahrefs.js
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBacklinksSummary, getRankedKeywords } from '../../../lib/dataforseo.js';

export default [
  // Auto-fetch SEO authority data from DataForSEO
  {
    method: 'POST',
    match: '/api/seo-authority/refresh',
    async handler(req, res, ctx) {
      try {
        const config = JSON.parse(readFileSync(join(ctx.ROOT, 'config', 'site.json'), 'utf8'));
        const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

        // Fetch backlinks (may return null if subscription not active)
        const backlinks = await getBacklinksSummary(domain);

        // Estimate traffic value from ranked keywords
        const keywords = await getRankedKeywords(domain, { limit: 200 });
        const trafficValue = Math.round(keywords.reduce((sum, kw) => sum + (kw.traffic * (kw.cpc || 0)), 0) * 100);

        const data = {
          domainRating: backlinks?.rank ?? '',
          backlinks: backlinks?.backlinks ?? '',
          referringDomains: backlinks?.referringDomains ?? '',
          organicTrafficValue: trafficValue,
        };

        // Save as CSV in the same format the existing loader reads
        const csv = 'Domain Rating,Backlinks,Referring Domains,Organic Traffic Value\n' +
          [data.domainRating, data.backlinks, data.referringDomains, data.organicTrafficValue].join(',') + '\n';
        const date = new Date().toISOString().slice(0, 10);
        mkdirSync(ctx.AHREFS_DIR, { recursive: true });
        writeFileSync(join(ctx.AHREFS_DIR, `overview-${date}.csv`), csv);
        ctx.invalidateDataCache();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    },
  },
  // Legacy manual save (kept for backward compat)
  {
    method: 'POST',
    match: '/api/ahrefs-overview',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        const { domainRating, backlinks, referringDomains, trafficValue } = payload;
        const csv = 'Domain Rating,Backlinks,Referring Domains,Organic Traffic Value\n' +
          [domainRating || '', backlinks || '', referringDomains || '', trafficValue || ''].join(',') + '\n';
        const date = new Date().toISOString().slice(0, 10);
        const filename = `overview-${date}.csv`;
        mkdirSync(ctx.AHREFS_DIR, { recursive: true });
        writeFileSync(join(ctx.AHREFS_DIR, filename), csv);
        ctx.invalidateDataCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, filename }));
      });
    },
  },
  {
    method: 'POST',
    match: '/api/reject-keyword',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        const { keyword, matchType, reason } = payload;
        if (!keyword || !matchType) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'keyword and matchType are required' }));
          return;
        }
        try {
          const filePath = join(ctx.ROOT, 'data', 'rejected-keywords.json');
          const existing = existsSync(filePath)
            ? JSON.parse(readFileSync(filePath, 'utf8'))
            : [];
          existing.push({ keyword, matchType, reason: reason || null, rejectedAt: new Date().toISOString() });
          writeFileSync(filePath, JSON.stringify(existing, null, 2));
          ctx.invalidateDataCache();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    },
  },
];
