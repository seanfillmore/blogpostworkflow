// agents/dashboard/lib/run-agent.js
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const RUN_AGENT_ALLOWLIST = new Set([
  'agents/rank-tracker/index.js',
  'agents/content-gap/index.js',
  'agents/gsc-query-miner/index.js',
  'agents/sitemap-indexer/index.js',
  'agents/insight-aggregator/index.js',
  'agents/meta-ab-tracker/index.js',
  'agents/cro-analyzer/index.js',
  'agents/competitor-intelligence/index.js',
  'agents/ads-optimizer/index.js',
  'scripts/create-meta-test.js',
  'scripts/ads-weekly-recap.js',
  'agents/campaign-creator/index.js',
  'agents/campaign-analyzer/index.js',
  'agents/campaign-monitor/index.js',
  'agents/cro-deep-dive-content/index.js',
  'agents/cro-deep-dive-seo/index.js',
  'agents/cro-deep-dive-trust/index.js',
  'agents/content-researcher/index.js',
  'agents/content-strategist/index.js',
  'agents/pipeline-scheduler/index.js',
  'agents/cro-cta-injector/index.js',
  'agents/refresh-runner/index.js',
  'agents/quick-win-targeter/index.js',
  'agents/post-performance/index.js',
  'agents/gsc-opportunity/index.js',
  'agents/competitor-watcher/index.js',
  'agents/unmapped-query-promoter/index.js',
  'agents/indexing-checker/index.js',
  'agents/indexing-fixer/index.js',
]);

/**
 * Factory that returns a handler bound to the given ROOT path.
 * Usage: const runAgent = createRunAgentHandler(ROOT); then call runAgent(req, res)
 * from a route handler.
 */
export function createRunAgentHandler(ROOT) {
  return function runAgentHandler(req, res) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let script, args = [];
      try { ({ script, args = [] } = JSON.parse(body)); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      if (!RUN_AGENT_ALLOWLIST.has(script)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Script not in allowlist' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const child = spawn('node', [join(ROOT, script), ...args], { cwd: ROOT });
      const send = line => res.write(`data: ${line}\n\n`);
      child.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(send));
      child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => send(`[stderr] ${l}`)));
      child.on('close', code => { res.write(`data: __exit__:${JSON.stringify({ code })}\n\n`); res.end(); });
    });
  };
}
