// agents/dashboard/routes/cannibalization.js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRedirect } from '../../../lib/shopify.js';

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function loadReport(ctx) {
  const p = join(ctx.ROOT, 'data', 'reports', 'cannibalization', 'latest.json');
  if (!existsSync(p)) return null;
  return { path: p, report: JSON.parse(readFileSync(p, 'utf8')) };
}

function markResolved(report, query, action) {
  const conflict = report.conflicts.find((c) => c.query === query);
  if (conflict) {
    conflict.auto_applied = true;
    conflict.resolved_action = action;
    conflict.resolved_at = new Date().toISOString();
  }
}

function recountAndSave(path, report) {
  report.auto_resolved = report.conflicts.filter((c) => c.auto_applied).length;
  report.recommended = report.conflicts.filter((c) => !c.auto_applied).length;
  writeFileSync(path, JSON.stringify(report, null, 2));
}

function toPath(url) {
  return url.startsWith('http') ? new URL(url).pathname : url;
}

export default [
  // Resolve a single conflict
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
            try {
              await createRedirect(toPath(loser), toPath(winner));
            } catch (err) {
              // 422 = redirect already exists for this path — treat as success
              if (!err.message.includes('422')) throw err;
            }
          } else if (action !== 'DISMISS') {
            return respondJson(res, { ok: false, error: `Unknown action: ${action}` }, 400);
          }

          const loaded = loadReport(ctx);
          if (loaded) {
            markResolved(loaded.report, query, action);
            recountAndSave(loaded.path, loaded.report);
          }

          respondJson(res, { ok: true, action });
        } catch (err) {
          respondJson(res, { ok: false, error: err.message }, 502);
        }
      });
    },
  },
  // Auto-resolve all unresolved conflicts by redirecting losers to the suggested winner
  {
    method: 'POST',
    match: (url) => /^\/api\/cannibalization\/auto-resolve$/.test(url),
    async handler(req, res, ctx) {
      try {
        const loaded = loadReport(ctx);
        if (!loaded) return respondJson(res, { ok: true, resolved: 0 });

        const { path, report } = loaded;
        const unresolved = report.conflicts.filter((c) => !c.auto_applied);

        let resolved = 0;
        let failed = 0;
        for (const conflict of unresolved) {
          // Determine winner: from AI decision, or highest impressions
          let winnerUrl = null;
          if (conflict.winner) {
            winnerUrl = conflict.urls.find((u) => u.url.includes(conflict.winner));
          }
          if (!winnerUrl) {
            winnerUrl = conflict.urls.reduce((best, u) => u.impressions > best.impressions ? u : best, conflict.urls[0]);
          }
          const losers = conflict.urls.filter((u) => u !== winnerUrl);
          if (losers.length === 0) { markResolved(report, conflict.query, 'DISMISS'); resolved++; continue; }

          let allOk = true;
          for (const loser of losers) {
            try {
              await createRedirect(toPath(loser.url), toPath(winnerUrl.url));
            } catch (err) {
              if (!err.message.includes('422')) { allOk = false; failed++; }
            }
          }
          if (allOk) { markResolved(report, conflict.query, 'REDIRECT'); resolved++; }
        }

        recountAndSave(path, report);
        respondJson(res, { ok: true, resolved, failed });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 502);
      }
    },
  },
];
