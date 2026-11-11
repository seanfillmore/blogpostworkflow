import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReview, CUTOFF_UTC, summaryLine, writeCrashFiles } from '../../agents/recap-reviewer/index.js';
import { splitCommand } from '../../lib/recap-jobs.js';
import { makeExec } from '../../agents/recap-reviewer/exec.js';
import { emptyState } from '../../lib/recap-reviewer-state.js';
import { buildFixPrompt } from '../../lib/fix-session.js';

const AT = (hhmm) => () => new Date(`2026-11-11T${hhmm}:00.000Z`);
const MORNING = AT('11:05');

const RANK = 'agents/rank-tracker/index.js';
const OUTREACH = 'agents/creator-outreach/index.js';
const CRONTAB = [
  `0 14 * * * cd /root/seo-claude && /usr/bin/node ${RANK} >> data/logs/rank-tracker.log 2>&1`,
  `0 17 * * * cd /root/seo-claude && /usr/bin/node ${OUTREACH} --apply >> data/logs/creator-outreach.log 2>&1`,
  '30 16 * * * cd /root/seo-claude && /usr/bin/node agents/editor/index.js --all >> data/logs/editor.log 2>&1',
].join('\n');

const errRow = (over = {}) => ({
  status: 'error', category: 'seo', source: RANK, subject: 'Rank Tracker failed',
  body: 'request failed: ETIMEDOUT', ts: '2026-11-10T14:05:00.000Z', ...over,
});

function fakeDeps(over = {}) {
  const calls = [];
  const log = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret; };
  let state = emptyState();
  const inputs = { entries: [], laterRows: [], healthIssues: [], postPerformance: null, blockedPosts: [], needsDecision: [] };
  const deps = {
    calls,
    names: () => calls.map((c) => c[0]),
    inputs,
    loadState: () => state,
    saveState: (s) => { state = s; calls.push(['saveState']); },
    collectInputs: async () => inputs,
    readCrontab: async () => CRONTAB,
    heartbeat: async () => ({ verdict: { state: 'healthy' }, schedulerProcs: [], browserProcs: [] }),
    lastSchedulerLogAt: async () => null,
    kill: log('kill'),
    exec: log('exec', { code: 0, stdout: '', stderr: '' }),
    readRowsSince: async () => [],
    healthTitles: async () => [],
    isBlocked: async () => true,
    archiveDraft: log('archiveDraft', { moved_to: 'data/posts/_orphaned/x' }),
    rearmQueueItem: log('rearmQueueItem', {}),
    dismissQueueItem: log('dismissQueueItem', {}),
    stampPostState: log('stampPostState'),
    // removal
    getAllOrders: async () => [],
    getAllRedirects: async () => [],
    ctrHandles: () => new Set(),
    cannibalizationReport: () => null,
    lockStateFor: () => 'unlocked',
    loadInventory: async () => ({
      products: [{ path: '/products/coconut-soap', title: 'Coconut Soap Bar' }],
      collections: [],
      articles: [{ path: '/blogs/news/soap-guide', title: 'Natural soap guide' }],
    }),
    findArticle: log('findArticle', (h) => ({ id: 11, blogId: 22, handle: h, title: `Soap ${h}` })),
    askFast: log('askFast', '{"choice": 0, "why": "same product"}'),
    headStatus: log('headStatus', 200),
    articleBackup: log('articleBackup', (a) => ({ id: a.id, title: a.title, body_html: '<p>x</p>', tags: 'soap', metafields: [] })),
    writeBackup: log('writeBackup', '/backups/x.json'),
    killPost: log('killPost', (slug, o) => ({ shopify_deleted: true, redirect_created: { path: `/blogs/news/${slug}`, target: o.redirectTo, source: 'buy-box CTA' } })),
    checkRedirect: log('checkRedirect', { status: 301, location: 'https://www.realskincare.com/products/coconut-soap' }),
    // fix session
    logTail: async () => '',
    createFixCheckout: log('createFixCheckout', (name) => `/srv/recap-fix/fix-${name}`),
    runFixSession: log('runFixSession', { exitCode: 0, verdict: 'fixed', summary: 'fixed the null check' }),
    shipFix: log('shipFix', { outcome: 'deployed', pr: { number: 9001, url: 'u' }, verify: 'rerun' }),
    removeDir: log('removeDir'),
    reapFixUser: log('reapFixUser'),
    postArticleId: async () => null,
    listFixCheckouts: async () => [],
    // growth
    gatherGrowthInputs: async () => ({ missing: [] }),
    generateGrowthRecs: log('generateGrowthRecs', { recs: [{ move: 'm' }], dropped: [] }),
    // output
    writeReport: log('writeReport'),
    writeDryRun: log('writeDryRun'),
    writeDone: log('writeDone'),
    notify: log('notify'),
    ...over,
  };
  deps.setState = (s) => { state = s; };
  return deps;
}

const execsOf = (deps, script) => deps.calls.filter((c) => c[0] === 'exec' && (c[2] || []).includes(script));

// ── Unit A: re-runs ─────────────────────────────────────────────────────────

test('two rows with the same key -> exactly one re-run, verified by a later success row', async () => {
  const deps = fakeDeps({
    readRowsSince: async () => [{ status: 'success', category: 'seo', source: RANK, subject: 'Rank Tracker: 120 keywords tracked', ts: '2026-11-11T11:06:00.000Z' }],
  });
  deps.inputs.entries.push(errRow(), errRow({ ts: '2026-11-10T15:05:00.000Z' }));
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(execsOf(deps, RANK).length, 1);
  const call = execsOf(deps, RANK)[0];
  assert.equal(call[1], '/usr/bin/node');
  assert.equal(call[3].timeout, 20 * 60_000);
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0].action, 're-run');
});

test('two DIFFERENT keys from the same job still re-run it once', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(errRow(), errRow({ subject: 'Rank Tracker partial', category: 'other' }));
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(execsOf(deps, RANK).length, 1);
});

test('a re-run that exits 0 but writes no success row is NOT resolved', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(errRow());
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolved.length, 1);
});

test('a NEVER_RERUN source with a transient error is not re-run and waits for its next scheduled run', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(errRow({ source: OUTREACH, category: 'outreach', subject: 'Creator outreach failed', body: 'socket hang up' }));
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(execsOf(deps, OUTREACH).length, 0);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].result, /waits for next scheduled run/);
});

test('a rerunnable source with no crontab line falls back to `node <source>`', async () => {
  const deps = fakeDeps({ readCrontab: async () => '' });
  deps.inputs.entries.push(errRow());
  await runReview(deps, { apply: true, now: MORNING });
  const c = execsOf(deps, RANK)[0];
  assert.equal(c[1], 'node');
  assert.deepEqual(c[2], [RANK]);
});

test('a stale data feed re-runs its collector and is verified by the health check', async () => {
  const deps = fakeDeps({ healthTitles: async () => [] });
  deps.inputs.healthIssues.push({ title: 'Data feed "gsc" is stale', detail: '6 days old' });
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(execsOf(deps, 'agents/gsc-collector/index.js').length, 1);
  assert.equal(r.resolved[0].action, 're-run collector');
});

// ── heartbeat ───────────────────────────────────────────────────────────────

test('a stuck scheduler is killed only when its last log line is over 2 h old', async () => {
  const stuck = { verdict: { state: 'stuck' }, schedulerProcs: [{ pid: 4242, ageSec: 9 * 3600 }], browserProcs: [] };
  let n = 0;
  const deps = fakeDeps({
    heartbeat: async () => (n++ === 0 ? stuck : { verdict: { state: 'died' }, schedulerProcs: [], browserProcs: [] }),
    lastSchedulerLogAt: async () => Date.parse('2026-11-11T07:00:00Z'),
  });
  await runReview(deps, { apply: true, now: MORNING });
  assert.deepEqual(deps.calls.filter((c) => c[0] === 'kill').map((c) => c[1]), [4242]);

  const fresh = fakeDeps({ heartbeat: async () => stuck, lastSchedulerLogAt: async () => Date.parse('2026-11-11T10:30:00Z') });
  const r = await runReview(fresh, { apply: true, now: MORNING });
  assert.equal(fresh.calls.filter((c) => c[0] === 'kill').length, 0);
  assert.equal(r.unresolved.length, 1);
});

test('orphaned browsers are killed', async () => {
  let n = 0;
  const deps = fakeDeps({
    heartbeat: async () => (n++ === 0
      ? { verdict: { state: 'orphaned-browser' }, schedulerProcs: [], browserProcs: [{ pid: 7, ageSec: 99999 }, { pid: 8, ageSec: 99999 }] }
      : { verdict: { state: 'healthy' }, schedulerProcs: [], browserProcs: [] }),
  });
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.deepEqual(deps.calls.filter((c) => c[0] === 'kill').map((c) => c[1]), [7, 8]);
  assert.equal(r.resolved.length, 1);
});

// ── Unit B: removal ─────────────────────────────────────────────────────────

const flop = (slug, over = {}) => ({ slug, title: `Best soap ${slug}`, url: `https://x.myshopify.com/blogs/news/${slug}`, action: 'no-demand', milestone: 90, ...over });

test('removal skips (with a reason) when the pick is unparseable or the target is not 200; killPost never runs', async () => {
  const deps = fakeDeps({
    askFast: async (p) => (p.includes('/blogs/news/a') ? 'no idea' : '{"choice":0}'),
    headStatus: async () => 404,
  });
  deps.inputs.postPerformance = { action_required: [flop('a'), flop('b')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'killPost').length, 0);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.slug, s.reason]));
  assert.match(reasons.a, /unparseable/);
  assert.match(reasons.b, /404/);
});

test('removal skips everything when the order history read fails', async () => {
  const deps = fakeDeps({ getAllOrders: async () => { throw new Error('Shopify 500'); } });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'killPost').length, 0);
  assert.match(r.skipped[0].reason, /order history unreadable/);
});

test('the backup is written before killPost, which gets the picked target; then fix-redirect-links runs once', async () => {
  const deps = fakeDeps();
  deps.inputs.postPerformance = { action_required: [flop('a'), flop('b')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  const names = deps.names();
  const firstKill = names.indexOf('killPost');
  assert.ok(names.indexOf('writeBackup') !== -1 && names.indexOf('writeBackup') < firstKill);
  const kill = deps.calls.find((c) => c[0] === 'killPost');
  assert.equal(kill[1], 'a');
  assert.deepEqual(kill[2], { reason: 'low-demand', redirectTo: '/products/coconut-soap' });
  assert.equal(execsOf(deps, 'scripts/fix-redirect-links.mjs').length, 1);
  assert.equal(r.resolved.filter((o) => o.action === 'remove').length, 2);
});

test('removal is capped at 5', async () => {
  const deps = fakeDeps();
  deps.inputs.postPerformance = { action_required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => flop(s)) };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'killPost').length, 5);
  assert.equal(r.skipped.filter((s) => s.reason === 'cap').length, 2);
});

// ── Unit B: decisions ────────────────────────────────────────────────────────

test('a needs_decision row is routed by its stamped source', async () => {
  const deps = fakeDeps();
  deps.inputs.needsDecision.push(
    { source: 'agents/amazon-account-health/index.js', slug: 'B0X', title: 'Listing removed', label: 'appeal it' },
    { source: 'agents/queue-autoapply/index.js', slug: 'seo-opp-x', decision: 'editor-gate-exhausted', title: 'x' },
  );
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.onlyYou.length, 1);
  assert.deepEqual(deps.calls.filter((c) => c[0] === 'rearmQueueItem').map((c) => c[1]), ['seo-opp-x']);
});

// ── Unit C: fix session ─────────────────────────────────────────────────────

const codeRow = (over = {}) => errRow({ source: 'agents/editor/index.js', category: 'content', subject: 'Editor failed', body: "TypeError: Cannot read properties of undefined (reading 'x')", ...over });

test('a fix session that returns `gate` ships nothing and leaves the item unresolved with the summary', async () => {
  const deps = fakeDeps({ runFixSession: async () => ({ exitCode: 0, verdict: 'gate', summary: 'the health gate correctly refused' }) });
  deps.inputs.entries.push(codeRow());
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'shipFix').length, 0);
  assert.equal(r.fixSession.result.includes('the health gate correctly refused'), true);
  assert.ok(r.unresolved.some((o) => /correctly refused/.test(o.result)));
});

test('external verdict goes to only-you', async () => {
  const deps = fakeDeps({ runFixSession: async () => ({ exitCode: 0, verdict: 'external', summary: 'token expired' }) });
  deps.inputs.entries.push(codeRow());
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.ok(r.onlyYou.some((o) => /token expired/.test(o.result)));
});

test('fixAttempts at 3 starts no session', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow());
  const s = emptyState();
  s.fixAttempts['agents/editor/index.js|content|editor'] = 3;
  deps.setState(s);
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'createFixCheckout' || c[0] === 'runFixSession').length, 0);
  assert.equal(r.fixSession, null);
  assert.equal(r.unresolved.length, 1);
});

test('a fixed session ships, records attempts, cleans up, and runs growth only afterwards', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow(), codeRow({ ts: '2026-11-10T16:00:00.000Z' }), codeRow({ source: 'agents/other/index.js', subject: 'Other failed' }));
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'runFixSession').length, 1, 'one session per run');
  const ship = deps.calls.find((c) => c[0] === 'shipFix')[1];
  assert.equal(ship.item.source, 'agents/editor/index.js', 'the item with the most rows wins');
  assert.equal(ship.rerun, null, 'editor writes live content: never re-run, verified by its next scheduled run');
  assert.equal(r.fixSession.action, 'fix session');
  assert.ok(r.resolved.some((o) => /#9001/.test(o.result)));
  const names = deps.names();
  assert.ok(names.indexOf('generateGrowthRecs') > names.indexOf('shipFix'));
  assert.ok(deps.calls.some((c) => c[0] === 'removeDir' && c[1] === '/srv/recap-fix/fix-agents-editor-2026-11-11'));
  assert.ok(deps.calls.some((c) => c[0] === 'removeDir' && c[1] === '/root/recap-ship/agents-editor-2026-11-11'));
  assert.deepEqual(r.growth.recs, [{ move: 'm' }]);
});

test('a NEVER_RERUN job ships with rerun = null', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow({ source: OUTREACH, subject: 'Creator outreach failed' }));
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.find((c) => c[0] === 'shipFix')[1].rerun, null);
});

test('a shipFix that throws (revert failed) is unresolved with the error', async () => {
  const deps = fakeDeps({ shipFix: async () => { throw new Error('merged and NOT reverted'); } });
  deps.inputs.entries.push(codeRow());
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.ok(r.unresolved.some((o) => /NOT reverted/.test(o.evidence)));
});

test('a timed-out session keeps its checkout for tomorrow', async () => {
  const deps = fakeDeps({ runFixSession: async () => ({ exitCode: null, verdict: 'no-fix', summary: 'timed out' }) });
  deps.inputs.entries.push(codeRow());
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'removeDir').length, 0);
});

// ── the 14:30 stop ──────────────────────────────────────────────────────────

test('at 14:31 UTC nothing new starts and unstarted items read "deferred to tomorrow"', async () => {
  assert.equal(CUTOFF_UTC, '14:30');
  const deps = fakeDeps();
  deps.inputs.entries.push(errRow(), codeRow());
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: AT('14:31') });
  for (const n of ['exec', 'killPost', 'createFixCheckout', 'runFixSession', 'generateGrowthRecs', 'kill']) {
    assert.equal(deps.calls.filter((c) => c[0] === n).length, 0, n);
  }
  assert.ok(r.unresolved.length >= 3);
  for (const o of r.unresolved) assert.equal(o.result, 'deferred to tomorrow');
});

// ── dry by default ──────────────────────────────────────────────────────────

test('without apply: no side effects at all, the report is still written, done.json is not', async () => {
  const deps = fakeDeps({
    heartbeat: async () => ({ verdict: { state: 'orphaned-browser' }, schedulerProcs: [], browserProcs: [{ pid: 7, ageSec: 99999 }] }),
  });
  deps.inputs.entries.push(errRow(), codeRow());
  deps.inputs.postPerformance = { action_required: [flop('a'), flop('d', { action: 'demote' })] };
  deps.inputs.needsDecision.push({ source: 'agents/queue-autoapply/index.js', slug: 's', decision: 'health-claim' });
  deps.inputs.blockedPosts.push({ slug: 'draft-x', title: 'Draft' });
  const r = await runReview(deps, { now: MORNING });
  for (const n of ['exec', 'kill', 'killPost', 'createFixCheckout', 'runFixSession', 'shipFix', 'writeBackup', 'writeReport',
    'archiveDraft', 'rearmQueueItem', 'dismissQueueItem', 'stampPostState', 'removeDir', 'writeDone', 'notify', 'saveState']) {
    assert.equal(deps.calls.filter((c) => c[0] === n).length, 0, n);
  }
  assert.equal(deps.calls.filter((c) => c[0] === 'writeReport').length, 0, 'a dry run never touches latest.json');
  assert.equal(deps.calls.filter((c) => c[0] === 'writeDryRun').length, 1);
  assert.equal(r.apply, false);
  assert.ok(r.unresolved.every((o) => /^dry run/.test(o.result) || o.result === 'waits for next scheduled run'));
});

test('apply writes done.json and one deferred notify', async () => {
  const deps = fakeDeps();
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'writeDone').length, 1);
  const n = deps.calls.filter((c) => c[0] === 'notify');
  assert.equal(n.length, 1);
  assert.notEqual(n[0][1].immediate, true);
});

test('a crash still writes latest.json with crashed:true and notifies immediately', async () => {
  const deps = fakeDeps({ collectInputs: async () => { throw new Error('kaboom'); } });
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.crashed, true);
  assert.equal(deps.calls.find((c) => c[0] === 'writeReport')[1].crashed, true);
  const n = deps.calls.filter((c) => c[0] === 'notify');
  assert.equal(n.length, 1);
  assert.equal(n[0][1].immediate, true);
  assert.equal(n[0][1].status, 'error');
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('splitCommand strips only redirects, never a trailing digit argument', () => {
  assert.deepEqual(splitCommand('node agents/x/index.js --limit 5 >> data/logs/x.log 2>&1'), ['node', 'agents/x/index.js', '--limit', '5']);
  assert.deepEqual(splitCommand('/usr/bin/node agents/x/index.js --limit 5'), ['/usr/bin/node', 'agents/x/index.js', '--limit', '5']);
  assert.deepEqual(splitCommand('node "agents/x/index.js"'), ['node', 'agents/x/index.js']);
});

test('real exec honours opts.timeout and reports {code:null, timedOut:true}', async () => {
  const exec = makeExec({ killGraceMs: 200 });
  const r = await exec(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeout: 200 });
  assert.equal(r.code, null);
  assert.equal(r.timedOut, true);
});

test('real exec passes an explicit env exactly, without process.env', async () => {
  process.env.RR_LEAK_CHECK = 'leak';
  let r;
  try {
    const exec = makeExec();
    r = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.env.RR_LEAK_CHECK))'], { env: { PATH: process.env.PATH } });
  } finally {
    delete process.env.RR_LEAK_CHECK;
  }
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'undefined');
  assert.equal(r.timedOut, false);
});

test('a fix for a job with no command (not in crontab, not rerunnable) ships with rerun = null', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow({ source: 'agents/blocked-post-resolver/index.js', subject: 'Blocked post resolver failed' }));
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.find((c) => c[0] === 'shipFix')[1].rerun, null);
});


// ── fix round 1 ─────────────────────────────────────────────────────────────

test('removal never redirects to the "/" hub: a hub pick is skipped and killPost never runs', async () => {
  // Two specific same-cluster pages: [0] product, [1] article. Index 2 is where
  // buildChoiceList('blog') appends the "/" hub.
  const deps = fakeDeps({ askFast: async () => '{"choice": 2}' });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'killPost').length, 0);
  assert.equal(r.skipped.length, 1);
  assert.ok(!deps.calls.some((c) => c[0] === 'askFast' && /\[\d+\] \/ —/.test(c[1])), 'the hub is not offered at all');
});

test('removal with no specific same-cluster page skips with "no same-cluster target"', async () => {
  const deps = fakeDeps({ loadInventory: async () => ({ products: [], collections: [], articles: [{ path: '/blogs/news/toothpaste', title: 'Toothpaste guide' }] }) });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'askFast' || c[0] === 'killPost').length, 0);
  assert.equal(r.skipped.length, 0, 'a permanent skip is not left as a skip');
  const kept = r.resolved.find((o) => o.action === 'kept');
  assert.ok(kept, 'reported as resolved with action kept');
  assert.match(kept.result, /^kept: no same-cluster target/);
  assert.equal(r.unresolved.length, 0);
});

test('removal: a retryable skip (unparseable pick) stays a skip and is not kept', async () => {
  const deps = fakeDeps({ askFast: async () => 'no idea' });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.filter((o) => o.action === 'kept').length, 0);
  assert.match(r.skipped[0].reason, /unparseable/);
});

test('growth with no recs and no reason gets a reason', async () => {
  const deps = fakeDeps({ generateGrowthRecs: async () => ({ recs: [] }) });
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.growth.reason, 'no recommendation passed the checks');
});

test('removal: a redirect pointing somewhere other than the chosen target is unresolved', async () => {
  const deps = fakeDeps({
    killPost: async (slug) => ({ shopify_deleted: true, redirect_created: { path: `/blogs/news/${slug}`, target: '/collections/other', source: 'already existed' } }),
  });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.length, 0);
  assert.match(r.unresolved[0].evidence, /\/collections\/other/);
});

test('removal: the final target is re-checked for 200 after the delete', async () => {
  let n = 0;
  const deps = fakeDeps({ headStatus: async () => (n++ === 0 ? 200 : 404) });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.length, 0);
  assert.match(r.unresolved[0].evidence, /404/);
});

test('orphaned-browser kills only Chrome processes past the run ceiling', async () => {
  let n = 0;
  const deps = fakeDeps({
    heartbeat: async () => (n++ === 0
      ? { verdict: { state: 'orphaned-browser' }, schedulerProcs: [], browserProcs: [{ pid: 7, ageSec: 99999 }, { pid: 8, ageSec: 60 }] }
      : { verdict: { state: 'healthy' }, schedulerProcs: [], browserProcs: [] }),
  });
  await runReview(deps, { apply: true, now: MORNING });
  assert.deepEqual(deps.calls.filter((c) => c[0] === 'kill').map((c) => c[1]), [7]);
});

test('apply writes latest.json (writeReport), never the dry-run file', async () => {
  const deps = fakeDeps();
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'writeReport').length, 1);
  assert.equal(deps.calls.filter((c) => c[0] === 'writeDryRun').length, 0);
});

test('the fix session timeout is bounded by 14:30 UTC', async () => {
  const early = fakeDeps();
  early.inputs.entries.push(codeRow());
  await runReview(early, { apply: true, now: MORNING });
  assert.equal(early.calls.find((c) => c[0] === 'runFixSession')[1].timeoutMs, 45 * 60_000);

  const late = fakeDeps();
  late.inputs.entries.push(codeRow());
  await runReview(late, { apply: true, now: AT('14:00') });
  assert.equal(late.calls.find((c) => c[0] === 'runFixSession')[1].timeoutMs, 30 * 60_000);
});

test('no fix session starts with under 15 minutes to 14:30', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow());
  const r = await runReview(deps, { apply: true, now: AT('14:20') });
  assert.equal(deps.calls.filter((c) => c[0] === 'createFixCheckout' || c[0] === 'runFixSession').length, 0);
  assert.equal(r.fixSession.result, 'deferred to tomorrow');
});

test('state is saved after each unit, not only at the end', async () => {
  const deps = fakeDeps();
  await runReview(deps, { apply: true, now: MORNING });
  assert.ok(deps.calls.filter((c) => c[0] === 'saveState').length >= 4);
});

test('refresh route: refresh-runner per demoted post, capped at 5, overflow deferred', async () => {
  const deps = fakeDeps();
  deps.inputs.postPerformance = { action_required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => flop(s, { action: 'demote' })) };
  const r = await runReview(deps, { apply: true, now: MORNING });
  const runs = execsOf(deps, 'agents/refresh-runner/index.js');
  assert.equal(runs.length, 5);
  assert.deepEqual(runs[0][2], ['agents/refresh-runner/index.js', 'a']);
  assert.equal(r.resolved.filter((o) => o.action === 'refresh').length, 5);
  assert.equal(r.unresolved.filter((o) => o.result === 'deferred to tomorrow').length, 2);
});

test('remediate-draft: first sight runs content-remediator once and records the day', async () => {
  const deps = fakeDeps({ isBlocked: async () => true });
  deps.inputs.blockedPosts.push({ slug: 'draft-x', title: 'Draft X' });
  const r = await runReview(deps, { apply: true, now: MORNING });
  const runs = execsOf(deps, 'agents/content-remediator/index.js');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0][2], ['agents/content-remediator/index.js', '--slug', 'draft-x']);
  assert.match(r.unresolved[0].result, /archived tomorrow/);
  assert.equal(deps.calls.filter((c) => c[0] === 'archiveDraft').length, 0);
  assert.equal(deps.loadState().remediated['blocked-draft|draft-x'], '2026-11-11');
});

test('remediate-draft: a draft no longer blocked after remediation is resolved', async () => {
  const deps = fakeDeps({ isBlocked: async () => false });
  deps.inputs.blockedPosts.push({ slug: 'draft-x', title: 'Draft X' });
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved[0].action, 'remediate');
});

test('remediate-draft: still blocked the next morning -> archived (moved), no second remediation', async () => {
  const deps = fakeDeps();
  deps.inputs.blockedPosts.push({ slug: 'draft-x', title: 'Draft X' });
  const s = emptyState();
  s.remediated['blocked-draft|draft-x'] = '2026-11-10';
  deps.setState(s);
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(execsOf(deps, 'agents/content-remediator/index.js').length, 0);
  assert.deepEqual(deps.calls.filter((c) => c[0] === 'archiveDraft').map((c) => c[1]), ['draft-x']);
  assert.equal(r.resolved[0].action, 'archive');
});

test('an item closed on an earlier run stays visible in resolved with its original reason', async () => {
  const deps = fakeDeps();
  deps.inputs.needsDecision.push({ source: 'agents/content-strategist/index.js', slug: 'topic', decision: 'possible-duplicate', title: 'topic' });
  const s = emptyState();
  s.closed['decision|agents/content-strategist/index.js|topic'] = { on: '2026-11-01', reason: 'left withheld: X' };
  deps.setState(s);
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0].action, 'closed earlier');
  assert.match(r.resolved[0].result, /left withheld: X/);
  assert.match(r.resolved[0].result, /2026-11-01/);
});

test('real exec resolves after a timeout kill even when "close" never fires', async () => {
  const { EventEmitter } = await import('node:events');
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
    return child; // a grandchild holding stdio open: 'close' never comes
  };
  const exec = makeExec({ spawnImpl, killGraceMs: 50 });
  const r = await exec('x', [], { timeout: 20 });
  assert.equal(r.code, null);
  assert.equal(r.timedOut, true);
});

// ── final review fixes ──────────────────────────────────────────────────────

test('C1: a fix to scheduler.js or press-outreach (in crontab) ships with rerun = null; a rerunnable job gets a real re-run', async () => {
  // daily-summary's only digest row is its System health row, which is never a
  // review item, so it cannot reach a fix session; isRerunnable is pinned in recap-jobs.test.js.
  const crontab = [
    '0 15 * * * cd /root/seo-claude && /usr/bin/node scheduler.js >> data/logs/s.log 2>&1',
    '17 * * * * cd /root/seo-claude && /usr/bin/node agents/press-outreach/index.js --apply >> data/logs/p.log 2>&1',
    CRONTAB,
  ].join('\n');
  for (const source of ['scheduler.js', 'agents/press-outreach/index.js']) {
    const deps = fakeDeps({ readCrontab: async () => crontab });
    deps.inputs.entries.push(codeRow({ source, subject: `${source} failed` }));
    await runReview(deps, { apply: true, now: MORNING });
    assert.equal(deps.calls.find((c) => c[0] === 'shipFix')[1].rerun, null, source);
  }
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow({ source: RANK, category: 'seo', subject: 'Rank Tracker failed' }));
  await runReview(deps, { apply: true, now: MORNING });
  const rerun = deps.calls.find((c) => c[0] === 'shipFix')[1].rerun;
  assert.equal(typeof rerun, 'function');
  await rerun();
  const c = execsOf(deps, RANK).at(-1);
  assert.equal(c[3].timeout, 20 * 60_000);
});

for (const [name, ship, status, re] of [
  ['reverted', { outcome: 'reverted', pr: { number: 9001 }, revertPr: { number: 9002 }, problems: ['rerun failed'] }, 'info', /reverted by #9002/],
  ['not-deployed', { outcome: 'not-deployed', pr: { number: 9001 }, revertPr: { number: 9002 }, problems: ['deploy failed'], message: 'deploy never landed; main has fix + revert; HEAD unchanged at abc123' }, 'info', /HEAD unchanged at abc123/],
]) {
  test(`I3a: a ${name} ship sends an immediate ${status} notify stating production`, async () => {
    const deps = fakeDeps({ shipFix: async () => ship });
    deps.inputs.entries.push(codeRow());
    await runReview(deps, { apply: true, now: MORNING });
    const n = deps.calls.filter((c) => c[0] === 'notify' && c[1].immediate === true);
    assert.equal(n.length, 1);
    assert.equal(n[0][1].status, status);
    assert.match(`${n[0][1].subject}\n${n[0][1].body}`, re);
  });
}

test('I3a: a shipFix throw sends an immediate error notify carrying the production state', async () => {
  const deps = fakeDeps({ shipFix: async () => { throw new Error('recap fix #9001 (m) is merged to main and NOT reverted; the server has the fix deployed.'); } });
  deps.inputs.entries.push(codeRow());
  await runReview(deps, { apply: true, now: MORNING });
  const n = deps.calls.filter((c) => c[0] === 'notify' && c[1].immediate === true);
  assert.equal(n.length, 1);
  assert.equal(n[0][1].status, 'error');
  assert.match(n[0][1].body, /NOT reverted; the server has the fix deployed/);
});

test('I3a: a deployed fix sends no immediate notify', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(codeRow());
  await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'notify' && c[1].immediate === true).length, 0);
});

test('minor: every recapfix process is reaped after the fix session, whatever the verdict', async () => {
  for (const verdict of ['fixed', 'gate', 'no-fix']) {
    const deps = fakeDeps({ runFixSession: async () => ({ exitCode: 0, verdict, summary: verdict === 'no-fix' ? 'timed out' : 's' }) });
    deps.inputs.entries.push(codeRow());
    await runReview(deps, { apply: true, now: MORNING });
    const names = deps.names();
    assert.ok(names.includes('reapFixUser'), verdict);
    assert.ok(names.indexOf('reapFixUser') > names.indexOf('runFixSession'), verdict);
  }
});

test('minor: the fix prompt never calls the crontab command a dry run', () => {
  const p = buildFixPrompt({ item: { subject: 's', source: 'agents/x/index.js' }, command: 'node agents/x/index.js --apply' });
  assert.ok(!/\(dry\)/.test(p));
  assert.match(p, /node agents\/x\/index\.js --apply/);
});

test('minor: fix.js and index.js share the one RERUN_TIMEOUT_MS from lib/recap-jobs.js', async () => {
  const lib = await import('../../lib/recap-jobs.js');
  const fix = await import('../../agents/recap-reviewer/fix.js');
  const idx = await import('../../agents/recap-reviewer/index.js');
  assert.equal(fix.RERUN_TIMEOUT_MS, lib.RERUN_TIMEOUT_MS);
  assert.equal(idx.RERUN_TIMEOUT_MS, lib.RERUN_TIMEOUT_MS);
  const { readFileSync } = await import('node:fs');
  for (const f of ['agents/recap-reviewer/fix.js', 'agents/recap-reviewer/index.js']) {
    assert.ok(!/const RERUN_TIMEOUT_MS\s*=/.test(readFileSync(f, 'utf8')), f);
  }
});

test('minor: a timed-out fix checkout older than 2 days is removed at the start of Unit C; a younger one is kept', async () => {
  const now = Date.parse('2026-11-11T11:05:00Z');
  const deps = fakeDeps({
    listFixCheckouts: async () => [
      { path: '/srv/recap-fix/fix-old-2026-11-08', mtimeMs: now - 3 * 86_400_000 },
      { path: '/srv/recap-fix/fix-old-2026-11-08.bundle', mtimeMs: now - 3 * 86_400_000 },
      { path: '/srv/recap-fix/fix-new-2026-11-10', mtimeMs: now - 86_400_000 },
      { path: '/srv/other/fix-x', mtimeMs: 0 },
      { path: '/srv/recap-fix/notafix', mtimeMs: 0 },
    ],
  });
  await runReview(deps, { apply: true, now: MORNING });
  const removed = deps.calls.filter((c) => c[0] === 'removeDir').map((c) => c[1]);
  assert.deepEqual(removed, ['/srv/recap-fix/fix-old-2026-11-08', '/srv/recap-fix/fix-old-2026-11-08.bundle']);

  const dry = fakeDeps({ listFixCheckouts: async () => [{ path: '/srv/recap-fix/fix-old', mtimeMs: 0 }] });
  await runReview(dry, { now: MORNING });
  assert.equal(dry.calls.filter((c) => c[0] === 'removeDir').length, 0);
});

const HB = 'scripts/check-scheduler-heartbeat.mjs';

test('I1: a disk-full row from the heartbeat script goes to only-you with its text; it is not resolved by a healthy heartbeat', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(
    errRow({ source: HB, category: 'pipeline', subject: 'Server disk 91% full, 2.1 GB free', body: 'A full disk stops every cron job silently.' }),
    errRow({ source: HB, category: 'pipeline', subject: 'Scheduler heartbeat — died', body: 'started, never completed' }),
  );
  const r = await runReview(deps, { apply: true, now: MORNING });
  const disk = r.onlyYou.find((o) => /disk/i.test(o.subject));
  assert.ok(disk, JSON.stringify(r.onlyYou));
  assert.match(disk.result, /Server disk 91% full/);
  assert.match(disk.evidence, /full disk stops every cron job/);
  assert.ok(!r.resolved.some((o) => /disk/i.test(o.subject)));
  assert.ok(r.resolved.some((o) => /Scheduler heartbeat/.test(o.subject) && /healthy/.test(o.result)));
  assert.equal(execsOf(deps, HB).length, 0, 'the disk row is never re-run');
});

test('I4a: a warning row is reviewed like an error: re-run and verified by a later success row', async () => {
  const deps = fakeDeps({
    readRowsSince: async () => [{ status: 'success', category: 'seo', source: RANK, subject: 'Rank Tracker: ok', ts: '2026-11-11T11:06:00.000Z' }],
  });
  deps.inputs.entries.push(errRow({ status: 'warning', body: 'request failed: ETIMEDOUT' }));
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(execsOf(deps, RANK).length, 1);
  assert.equal(r.resolved.length, 1);
});

test('I4a: a warning that cannot be resolved is unresolved, never dropped; a later WARNING is not recovery', async () => {
  const deps = fakeDeps({
    readRowsSince: async () => [{ status: 'warning', category: 'seo', source: RANK, subject: 'Rank Tracker: still bad', ts: '2026-11-11T11:06:00.000Z' }],
  });
  deps.inputs.entries.push(
    errRow({ status: 'warning', body: 'ETIMEDOUT' }),
    errRow({ status: 'warning', source: OUTREACH, category: 'outreach', subject: 'Creator outreach: 1 held', body: 'socket hang up' }),
  );
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolved.length, 2);
});

test('M2: a collector re-run whose feed went from missing to stale is NOT resolved', async () => {
  const deps = fakeDeps({ healthTitles: async () => ['Data feed "gsc" is stale (3 days old)'] });
  deps.inputs.healthIssues.push({ title: 'Data feed "gsc" is missing', detail: 'no file' });
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.resolved.length, 0);
  assert.match(r.unresolved[0].result, /still flags it/);

  const ok = fakeDeps({ healthTitles: async () => ['Data feed "ga4" is stale'] });
  ok.inputs.healthIssues.push({ title: 'Data feed "gsc" is missing', detail: 'no file' });
  const r2 = await runReview(ok, { apply: true, now: MORNING });
  assert.equal(r2.resolved.length, 1);
});

test('M3: a failed link repair after removals is unresolved "link repair after removals failed"', async () => {
  const deps = fakeDeps({
    exec: async (cmd, args, o) => { deps.calls.push(['exec', cmd, args, o]); return (args || []).includes('scripts/fix-redirect-links.mjs') ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' }; },
  });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  const o = r.unresolved.find((x) => /link repair/.test(x.result));
  assert.ok(o, JSON.stringify(r.unresolved));
  assert.equal(o.result, 'link repair after removals failed');
  assert.match(o.evidence, /exited 1/);
});

test('M3: a successful link repair adds no unresolved line', async () => {
  const deps = fakeDeps();
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.ok(!r.unresolved.some((x) => /link repair/.test(x.result)));
});

test('I2: killPost never runs when the local post meta names a different Shopify article', async () => {
  const deps = fakeDeps({ postArticleId: async () => 999 });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(deps.calls.filter((c) => c[0] === 'killPost').length, 0);
  assert.equal(deps.calls.filter((c) => c[0] === 'writeBackup').length, 0);
  assert.equal(r.skipped[0].reason, 'article id mismatch');

  const same = fakeDeps({ postArticleId: async () => '11' });
  same.inputs.postPerformance = { action_required: [flop('a')] };
  await runReview(same, { apply: true, now: MORNING });
  assert.equal(same.calls.filter((c) => c[0] === 'killPost').length, 1, 'matching id (string vs number) proceeds');
});

test('minor: a post with no Shopify article is kept as "already gone from Shopify"', async () => {
  const deps = fakeDeps({ findArticle: async () => null });
  deps.inputs.postPerformance = { action_required: [flop('a')] };
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.skipped.length, 0);
  assert.equal(r.resolved[0].action, 'kept');
  assert.match(r.resolved[0].result, /already gone from Shopify/);
});

test('I3b: every outcome carries finished_at and the report starts emailed:false', async () => {
  const deps = fakeDeps();
  deps.inputs.entries.push(errRow(), codeRow());
  const r = await runReview(deps, { apply: true, now: MORNING });
  assert.equal(r.emailed, false);
  for (const o of [...r.resolved, ...r.unresolved, ...r.onlyYou]) assert.match(String(o.finished_at), /^2026-11-11T/);
});

test('minor: summaryLine counts kept separately from fixed', () => {
  const line = summaryLine({ resolved: [{ action: 're-run' }, { action: 'kept' }, { action: 'kept' }], unresolved: [], onlyYou: [], skipped: [] });
  assert.match(line, /^1 fixed, 2 kept,/);
});

test('minor: a crash before runReview writes latest.json AND done.json with crashed:true (apply only)', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rr-crash-'));
  writeCrashFiles({ dir, apply: true, error: new Error('wiring failed'), now: new Date('2026-11-11T11:05:00Z') });
  const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  const done = JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'));
  assert.equal(latest.crashed, true);
  assert.deepEqual(done, { date: '2026-11-11', generated_at: '2026-11-11T11:05:00.000Z', crashed: true });

  const dry = mkdtempSync(join(tmpdir(), 'rr-crash-'));
  writeCrashFiles({ dir: dry, apply: false, error: new Error('x'), now: new Date('2026-11-11T11:05:00Z') });
  assert.ok(existsSync(join(dry, 'dry-run.json')));
  assert.ok(!existsSync(join(dry, 'latest.json')));
  assert.ok(!existsSync(join(dry, 'done.json')));
});

test('minor: archiveDraft refuses a post that has a Shopify article id', async () => {
  const { archiveRefusal } = await import('../../agents/recap-reviewer/real-deps.js');
  assert.match(archiveRefusal({ shopify_article_id: 123 }), /Shopify article/);
  assert.match(archiveRefusal({ shopify_status: 'published' }), /live or scheduled/);
  assert.equal(archiveRefusal({ slug: 'draft-x' }), null);
  assert.equal(archiveRefusal(null), null);
});

test('minor: real reapFixUser and listFixCheckouts exist in the production wiring', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('agents/recap-reviewer/real-deps.js', 'utf8');
  assert.match(src, /async reapFixUser\(\)[\s\S]{0,120}exec\('pkill', \['-u', 'recapfix'\]/);
  assert.match(src, /async listFixCheckouts\(\)/);
  assert.match(src, /postArticleId: async \(slug\) => getPostMeta\(slug\)\?\.shopify_article_id/);
});

test('M4 + minor: CLAUDE.md states no dry re-run as recapfix, all of config/ forbidden, and every guarded file', async () => {
  const { readFileSync } = await import('node:fs');
  const { GUARD_FILES, GUARD_PREFIXES, FORBIDDEN_PATHS } = await import('../../lib/fix-diff-rules.js');
  const doc = readFileSync('CLAUDE.md', 'utf8');
  assert.ok(!doc.includes('(rebase, `npm test`, the dry re-run) runs as `recapfix`'));
  assert.match(doc, /There is no dry re-run as `recapfix`/);
  assert.ok(FORBIDDEN_PATHS.includes('config/'));
  assert.match(doc, /anything under `config\/` \(all of it, not only the facts files\)/);
  for (const f of [...GUARD_FILES, ...GUARD_PREFIXES]) assert.ok(doc.includes(`\`${f}\``), f);
});
