// agents/dashboard/routes/cannibalization.js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRedirect } from '../../../lib/shopify.js';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/cannibalization\/resolve$/.test(url),
    async handler(req, res, ctx) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        try {
          const { query, winner, loser, action } = JSON.parse(body);
          if (!query || !winner || !loser || !action) {
            return respondJson(res, { ok: false, error: 'Missing required fields: query, winner, loser, action' }, 400);
          }

          if (action === 'REDIRECT') {
            // Extract paths from full URLs
            const winnerPath = winner.startsWith('http') ? new URL(winner).pathname : winner;
            const loserPath = loser.startsWith('http') ? new URL(loser).pathname : loser;
            await createRedirect(loserPath, winnerPath);
          } else if (action === 'DISMISS') {
            // No Shopify action — just mark as resolved
          } else {
            return respondJson(res, { ok: false, error: `Unknown action: ${action}` }, 400);
          }

          // Mark conflict as resolved in latest.json
          const latestPath = join(ctx.ROOT, 'data', 'reports', 'cannibalization', 'latest.json');
          if (existsSync(latestPath)) {
            const report = JSON.parse(readFileSync(latestPath, 'utf8'));
            const conflict = report.conflicts.find((c) => c.query === query);
            if (conflict) {
              conflict.auto_applied = true;
              conflict.resolved_action = action;
              conflict.resolved_at = new Date().toISOString();
              report.auto_resolved = report.conflicts.filter((c) => c.auto_applied).length;
              report.recommended = report.conflicts.filter((c) => !c.auto_applied).length;
              writeFileSync(latestPath, JSON.stringify(report, null, 2));
            }
          }

          respondJson(res, { ok: true, action });
        } catch (err) {
          respondJson(res, { ok: false, error: err.message }, 502);
        }
      });
    },
  },
];
