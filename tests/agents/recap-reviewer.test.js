import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReview, splitCommand, CUTOFF_UTC } from '../../agents/recap-reviewer/index.js';
import { makeExec } from '../../agents/recap-reviewer/exec.js';
import { emptyState } from '../../lib/recap-reviewer-state.js';

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
    killPost: log('killPost', { shopify_deleted: true, redirect_created: { target: '/products/coconut-soap' } }),
    checkRedirect: log('checkRedirect', { status: 301, location: 'https://www.realskincare.com/products/coconut-soap' }),
    // fix session
    logTail: async () => '',
    createFixCheckout: log('createFixCheckout', (name) => `/srv/recap-fix/fix-${name}`),
    runFixSession: log('runFixSession', { exitCode: 0, verdict: 'fixed', summary: 'fixed the null check' }),
    shipFix: log('shipFix', { outcome: 'deployed', pr: { number: 9001, url: 'u' }, verify: 'rerun' }),
    removeDir: log('removeDir'),
    // growth
    gatherGrowthInputs: async () => ({ missing: [] }),
    generateGrowthRecs: log('generateGrowthRecs', { recs: [{ move: 'm' }], dropped: [] }),
    // output
    writeReport: log('writeReport'),
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
  assert.equal(typeof ship.rerun, 'function', 'a job with a crontab line is re-run for real after deploy');
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
  for (const n of ['exec', 'kill', 'killPost', 'createFixCheckout', 'runFixSession', 'shipFix', 'writeBackup',
    'archiveDraft', 'rearmQueueItem', 'dismissQueueItem', 'stampPostState', 'removeDir', 'writeDone', 'notify', 'saveState']) {
    assert.equal(deps.calls.filter((c) => c[0] === n).length, 0, n);
  }
  assert.equal(deps.calls.filter((c) => c[0] === 'writeReport').length, 1);
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

test('splitCommand drops a stray fd digit and quotes', () => {
  assert.deepEqual(splitCommand('/usr/bin/node agents/x/index.js --apply 2'), ['/usr/bin/node', 'agents/x/index.js', '--apply']);
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
  const exec = makeExec();
  const r = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.env.RR_LEAK_CHECK))'], { env: { PATH: process.env.PATH } });
  delete process.env.RR_LEAK_CHECK;
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
