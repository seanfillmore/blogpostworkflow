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
  // Auto-resolve all HIGH confidence blog-vs-blog conflicts
  {
    method: 'POST',
    match: (url) => /^\/api\/cannibalization\/auto-resolve$/.test(url),
    async handler(req, res, ctx) {
      try {
        const loaded = loadReport(ctx);
        if (!loaded) return respondJson(res, { ok: true, resolved: 0 });

        const { path, report } = loaded;
        const high = report.conflicts.filter((c) =>
          !c.auto_applied &&
          c.confidence === 'HIGH' &&
          c.conflict_type === 'blog-vs-blog' &&
          c.winner && c.losers?.length > 0
        );

        let resolved = 0;
        let failed = 0;
        for (const conflict of high) {
          for (const loser of conflict.losers) {
            if (loser.action === 'MONITOR') continue;
            try {
              const winnerPath = toPath(conflict.urls.find((u) => u.url.includes(conflict.winner))?.url || conflict.winner);
              const loserUrl = conflict.urls.find((u) => u.url.includes(loser.path));
              if (!loserUrl) continue;
              await createRedirect(toPath(loserUrl.url), winnerPath);
              markResolved(report, conflict.query, 'REDIRECT');
              resolved++;
            } catch (err) {
              // Redirect may already exist — still mark as resolved
              if (err.message.includes('422') || err.message.includes('already')) {
                markResolved(report, conflict.query, 'REDIRECT');
                resolved++;
              } else {
                failed++;
              }
            }
          }
        }

        recountAndSave(path, report);
        respondJson(res, { ok: true, resolved, failed });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 502);
      }
    },
  },
];
