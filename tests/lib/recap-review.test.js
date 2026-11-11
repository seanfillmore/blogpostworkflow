import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemKey, classifyFailure, buildReviewItems, classifyRows, isReviewedProblem } from '../../lib/recap-review.js';

const row = (o) => ({ ts: '2026-11-10T04:00:00Z', subject: 'X failed', body: '', status: 'error', category: 'c', source: 'agents/x/index.js', ...o });

test('classifyFailure external, even with a stack trace', () => {
  assert.equal(classifyFailure(row({ body: '403 access denied\n at TypeError: x is not a function' })), 'external');
  for (const b of ['invalid_api_key', 'token expired', 'missing scope write_x', 'Unauthorized', 'refresh token revoked', 'LWA failure']) {
    assert.equal(classifyFailure(row({ body: b })), 'external', b);
  }
});
test('classifyFailure code', () => {
  for (const b of ['TypeError: x', 'ReferenceError: y', 'foo is not a function', 'Cannot read properties of undefined', 'z is not defined']) {
    assert.equal(classifyFailure(row({ body: b })), 'code', b);
  }
});
test('classifyFailure transient', () => {
  for (const b of ['ETIMEDOUT', 'ECONNRESET', 'socket hang up', 'request timed out', '429 too many', 'rate limit', '503', 'SIGKILL', 'out of memory']) {
    assert.equal(classifyFailure(row({ body: b })), 'transient', b);
  }
});
test('unmatched is transient once, code after 2+ distinct days', () => {
  assert.equal(classifyFailure(row({ body: 'weird' })), 'transient');
  assert.equal(classifyFailure(row({ body: 'weird' }), { priorDays: [row({ ts: '2026-11-09T01:00:00Z' })] }), 'transient');
  assert.equal(classifyFailure(row({ body: 'weird' }), { priorDays: [row({ ts: '2026-11-09T01:00:00Z' }), row({ ts: '2026-11-08T09:00:00Z' }), row({ ts: '2026-11-08T10:00:00Z' })] }), 'code');
  assert.equal(classifyFailure(row({ body: 'weird' }), { priorDays: [row({ ts: '2026-11-09T01:00:00Z' }), row({ ts: '2026-11-09T05:00:00Z' })] }), 'transient');
});
test('itemKey format', () => {
  assert.equal(itemKey(row({ subject: 'Creator outreach failed: boom' })), 'agents/x/index.js|c|creator outreach');
  assert.equal(itemKey({ subject: 'A' }), '||a');
});
test('duplicates collapse to one item', () => {
  const items = buildReviewItems({ errorRows: [row({ subject: 'Creator outreach failed', body: 'ETIMEDOUT' }), row({ subject: 'Creator outreach failed', body: 'ETIMEDOUT', ts: '2026-11-10T06:00:00Z' })] });
  assert.equal(items.length, 1);
  assert.equal(items[0].route, 'rerun');
  assert.equal(items[0].kind, 'failure');
});
test('sourceless rows are routed, never dropped', () => {
  const [a, b] = buildReviewItems({ errorRows: [
    row({ source: undefined, subject: 'Old agent failed', body: 'TypeError: q' }),
    row({ source: undefined, subject: 'Other agent failed', body: 'ETIMEDOUT' }),
  ] });
  assert.equal(a.route, 'fix-session');
  assert.equal(b.route, 'rerun');
  assert.equal(b.source, '');
});
test('external failure routes to only-you', () => {
  assert.equal(buildReviewItems({ errorRows: [row({ body: '401' })] })[0].route, 'only-you');
});
test('flop routes', () => {
  const m = { 'auto-refresh': 'count-only', locked: 'count-only', 'not-indexed': 'count-only', demote: 'refresh', 'no-demand': 'remove' };
  for (const [action, route] of Object.entries(m)) {
    assert.equal(buildReviewItems({ flops: [{ slug: `s-${action}`, action }] })[0].route, route, action);
  }
});
test('decision routes by source', () => {
  const items = buildReviewItems({ needsDecision: [
    { source: 'amazon-account-health', title: 'Geranium' },
    { source: 'queue-autoapply', title: 'Q' },
    { source: 'indexing-fixer', title: 'I' },
    { source: 'content-strategist', title: 'C' },
  ] });
  assert.deepEqual(items.map((i) => i.route), ['only-you', 'regenerate', 'regenerate', 'regenerate']);
  assert.ok(items.every((i) => i.kind === 'decision'));
});
test('health routes by title', () => {
  const items = buildReviewItems({ healthIssues: [
    { title: 'Data feed "gsc" is stale', detail: 'd' },
    { title: 'Analysis report "seo-impact report" is missing', detail: 'd' },
    { title: '2 leftover git stashes on the server', detail: 'd' },
    { title: 'Edit freeze ended on "x" (2026-11-01): follow-up due', detail: 'd' },
  ] });
  assert.deepEqual(items.map((i) => i.route), ['collector-rerun', 'collector-rerun', 'stash-residual', 'only-you']);
});
test('blocked drafts route to remediate-draft', () => {
  const [i] = buildReviewItems({ blockedDrafts: [{ slug: 'foo', reason: 'claims' }] });
  assert.equal(i.route, 'remediate-draft');
  assert.equal(i.kind, 'blocked-draft');
});

// ── final-review fixes ──────────────────────────────────────────────────────

test('I5: "always" and "halfway" are not LWA; a capitalised LWA still is external', () => {
  assert.equal(classifyFailure(row({ body: 'TypeError: we always fail halfway through' })), 'code');
  assert.equal(classifyFailure(row({ body: 'ETIMEDOUT, always' })), 'transient');
  assert.equal(classifyFailure(row({ body: 'LWA token exchange returned invalid_grant' })), 'external');
  assert.equal(classifyFailure(row({ body: 'lwa' })), 'transient');
});

test('I5: a key is classified across ALL its rows, external > code > transient', () => {
  const t = row({ body: 'ETIMEDOUT', ts: '2026-11-10T01:00:00Z' });
  const c = row({ body: "TypeError: Cannot read properties of undefined", ts: '2026-11-10T02:00:00Z' });
  const x = row({ body: '401 Unauthorized', ts: '2026-11-10T03:00:00Z' });
  assert.equal(buildReviewItems({ errorRows: [t, c] })[0].route, 'fix-session');
  assert.equal(buildReviewItems({ errorRows: [t, c, x] })[0].route, 'only-you');
  assert.equal(buildReviewItems({ errorRows: [c, t] })[0].route, 'fix-session');
  assert.equal(classifyRows([t]), 'transient');
});

test('minor: daily-summary\'s own System health row is never a review item', () => {
  const items = buildReviewItems({ errorRows: [row({ source: 'agents/daily-summary/index.js', category: 'ops', subject: '⚠️ System health: 2 issues' })] });
  assert.deepEqual(items, []);
});

test('I4: warnings are reviewed problems; info, success and daily-summary rows are not', () => {
  assert.equal(isReviewedProblem(row({ status: 'warning' })), true);
  assert.equal(isReviewedProblem(row({ status: 'error' })), true);
  assert.equal(isReviewedProblem(row({ status: 'info' })), false);
  assert.equal(isReviewedProblem(row({ status: 'error', source: 'agents/daily-summary/index.js' })), false);
});
