// agents/dashboard/routes/dataforseo.js
//
// DataForSEO-backed routes for the dashboard. The authority panel is
// refreshed on demand via /api/seo-authority/refresh and cached as JSON
// at data/reports/seo-authority/latest.json.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBacklinksSummary, getRankedKeywords } from '../../../lib/dataforseo.js';

export default [
  // Fetch SEO authority data from DataForSEO and cache as JSON.
  {
    method: 'POST',
    match: '/api/seo-authority/refresh',
    async handler(req, res, ctx) {
      try {
        const config = JSON.parse(readFileSync(join(ctx.ROOT, 'config', 'site.json'), 'utf8'));
        const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

        // Fetch backlinks (may return null if subscription not active)
        const backlinks = await getBacklinksSummary(domain);

        // Estimate traffic value (USD cents) from ranked keywords
        const keywords = await getRankedKeywords(domain, { limit: 200 });
        const trafficValueCents = Math.round(
          keywords.reduce((sum, kw) => sum + (kw.traffic * (kw.cpc || 0)), 0) * 100
        );

        const data = {
          domainRating: backlinks?.rank ?? null,
          backlinks: backlinks?.backlinks ?? null,
          referringDomains: backlinks?.referringDomains ?? null,
          organicTrafficValue: trafficValueCents,
          refreshedAt: new Date().toISOString(),
        };

        mkdirSync(ctx.SEO_AUTHORITY_DIR, { recursive: true });
        writeFileSync(join(ctx.SEO_AUTHORITY_DIR, 'latest.json'), JSON.stringify(data, null, 2));
        ctx.invalidateDataCache();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
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
