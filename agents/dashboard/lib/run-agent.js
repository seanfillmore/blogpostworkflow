// agents/dashboard/lib/run-agent.js
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, createWriteStream, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';

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
  'agents/performance-engine/index.js',
  'agents/legacy-triage/index.js',
  'agents/technical-seo/index.js',
  'agents/theme-seo-auditor/index.js',
  'agents/image-generator/index.js',
  'agents/editor/index.js',      // "Re-run editor" on the hard-block card
  'scripts/remediate-post.js',   // "Fix blockers" (pre-publish post) on the hard-block card
  'scripts/remediate-live-post.js', // "Fix & republish" (live post, refresh blocked) on the hard-block card
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

// ── background runs (for jobs longer than the proxy's ~100s request cap) ─────────
//
// A streamed SSE /run-agent holds the HTTP connection open for the whole run, so
// any job over ~100s gets killed by Cloudflare/ngrok with a 524. Long agents
// (remediate-live-post: editor + repair loop + several Claude calls) need to be
// decoupled from the request: POST /run-agent-bg spawns the child, tees its
// output to a per-job log file, and returns a jobId IMMEDIATELY; the client then
// polls GET /run-job for incremental output until the job writes its exit marker.
// Each request is sub-second, so the proxy cap is never in play.

const JOB_ID_RE = /^[\w.-]+$/;
let jobCounter = 0;

export function createBackgroundRunHandlers(ROOT) {
  const jobsDir = join(ROOT, 'data', 'reports', 'run-jobs');
  mkdirSync(jobsDir, { recursive: true });

  // Prune job logs older than 3 days so they don't accumulate unbounded.
  try {
    const cutoff = Date.now() - 3 * 86400 * 1000;
    for (const f of readdirSync(jobsDir).filter(n => n.endsWith('.log'))) {
      try { if (statSync(join(jobsDir, f)).mtimeMs < cutoff) unlinkSync(join(jobsDir, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  function start(req, res) {
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
      const jobId = `${Date.now()}-${process.pid}-${++jobCounter}`;
      const logPath = join(jobsDir, `${jobId}.log`);
      const out = createWriteStream(logPath, { flags: 'a' });
      let child;
      try {
        child = spawn('node', [join(ROOT, script), ...args], { cwd: ROOT });
      } catch (err) {
        out.write(`[error] failed to start: ${err.message}\n__exit__:${JSON.stringify({ code: 1 })}\n`);
        out.end();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobId }));
        return;
      }
      child.stdout.on('data', d => out.write(d));
      child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => out.write(`[stderr] ${l}\n`)));
      child.on('error', err => { out.write(`\n[error] ${err.message}\n__exit__:${JSON.stringify({ code: 1 })}\n`); out.end(); });
      child.on('close', code => { out.write(`\n__exit__:${JSON.stringify({ code })}\n`); out.end(); });
      // Respond immediately — the job runs on independently of this request.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobId }));
    });
  }

  function poll(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const id = u.searchParams.get('id') || '';
    const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0', 10) || 0);
    if (!JOB_ID_RE.test(id)) { // guard against path traversal
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad id' }));
      return;
    }
    const logPath = join(jobsDir, `${id}.log`);
    if (!existsSync(logPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no such job' }));
      return;
    }
    const text = readFileSync(logPath, 'utf8');
    let done = false, code = null;
    const lines = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('__exit__:')) { done = true; try { code = JSON.parse(line.slice(9)).code; } catch { /* ignore */ } continue; }
      lines.push(line);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lines: lines.slice(offset), nextOffset: lines.length, done, code }));
  }

  return { start, poll };
}
