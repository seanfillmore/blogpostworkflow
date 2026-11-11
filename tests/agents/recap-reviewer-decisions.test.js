import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDecision, executeDecision, DECISION_SOURCES } from '../../agents/recap-reviewer/decisions.js';

const TODAY = '2026-11-11';
const Q = DECISION_SOURCES.queue;
const IDX = DECISION_SOURCES.indexing;
const DUP = DECISION_SOURCES.duplicate;

function fakeDeps() {
  const calls = [];
  return {
    calls,
    rearmQueueItem: async (slug) => { calls.push(['rearm', slug]); return { gate_attempts: 2 }; },
    dismissQueueItem: async (slug, reason) => { calls.push(['dismiss', slug, reason]); return { status: 'dismissed' }; },
    stampPostState: async (slug, fields) => { calls.push(['stamp', slug, fields]); },
    exec: async (cmd, args, opts) => { calls.push(['exec', cmd, args, opts]); return { code: 0, stdout: '', stderr: '' }; },
  };
}

// ── queue-autoapply ─────────────────────────────────────────────────────────

test('queue editor-gate-exhausted: first sight re-arms one gate attempt', async () => {
  const row = { source: Q, slug: 'seo-opp-x', decision: 'editor-gate-exhausted' };
  const plan = planDecision(row, { today: TODAY });
  assert.equal(plan.action, 'retry');
  const deps = fakeDeps();
  await executeDecision(plan, row, deps);
  assert.deepEqual(deps.calls, [['rearm', 'seo-opp-x']]);
});

test('queue editor-gate-exhausted: after a retry on an earlier day it is dismissed, never deleted', async () => {
  const row = { source: Q, slug: 'seo-opp-x', decision: 'editor-gate-exhausted' };
  const plan = planDecision(row, { today: TODAY, retriedOn: '2026-11-10' });
  assert.equal(plan.action, 'close');
  const deps = fakeDeps();
  await executeDecision(plan, row, deps);
  assert.equal(deps.calls[0][0], 'dismiss');
  assert.match(deps.calls[0][2], /editor gate/);
});

test('queue editor-gate-exhausted retried today waits', () => {
  const plan = planDecision({ source: Q, slug: 'a', decision: 'editor-gate-exhausted' }, { today: TODAY, retriedOn: TODAY });
  assert.equal(plan.action, 'wait');
});

test('queue health-claim and not-auto-appliable close at once (dismiss lets the producer re-file)', () => {
  for (const decision of ['health-claim', 'not-auto-appliable']) {
    const plan = planDecision({ source: Q, slug: 'a', decision }, { today: TODAY });
    assert.equal(plan.action, 'close', decision);
    assert.equal(plan.how, 'dismiss-queue');
  }
});

test('queue create-page is a business choice: only you, with the producer text', () => {
  const plan = planDecision({ source: Q, slug: 'c', decision: 'create-page', label: 'creating a commercial page is your call' }, { today: TODAY });
  assert.equal(plan.action, 'only-you');
  assert.match(plan.reason, /your call/);
});

// ── indexing-fixer / lib/indexing-escalation.js ──────────────────────────────

test('indexing escalation: first sight runs one content refresh of that post', async () => {
  const row = { source: IDX, slug: 'p', decision: 'indexing-api-exhausted' };
  const plan = planDecision(row, { today: TODAY });
  assert.equal(plan.action, 'retry');
  const deps = fakeDeps();
  await executeDecision(plan, row, deps);
  assert.equal(deps.calls[0][0], 'exec');
  assert.deepEqual(deps.calls[0][2], ['agents/refresh-runner/index.js', 'p']);
  assert.ok(deps.calls[0][3].timeout > 0);
});

test('indexing escalation: next day it is closed out on the post state, nothing published', async () => {
  const row = { source: IDX, slug: 'p', decision: 'indexing-api-exhausted' };
  const plan = planDecision(row, { today: TODAY, retriedOn: '2026-11-09' });
  assert.equal(plan.action, 'close');
  const deps = fakeDeps();
  await executeDecision(plan, row, deps, { now: '2026-11-11T11:05:00Z' });
  assert.equal(deps.calls.length, 1);
  const [kind, slug, fields] = deps.calls[0];
  assert.equal(kind, 'stamp');
  assert.equal(slug, 'p');
  assert.equal(fields.indexing_escalation_closed.closed_by, 'recap-reviewer');
  assert.ok(fields.indexing_escalation_closed.reason);
});

test('a refresh that exits non-zero is reported as a failed retry', async () => {
  const row = { source: IDX, slug: 'p', decision: 'indexing-api-exhausted' };
  const deps = fakeDeps();
  deps.exec = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(executeDecision(planDecision(row, { today: TODAY }), row, deps), /boom/);
});

// ── content-strategist / lib/duplicate-flag.js ──────────────────────────────

test('possible-duplicate: closed as "left withheld" with no side effect at all', async () => {
  const row = { source: DUP, slug: 'topic', decision: 'possible-duplicate' };
  const plan = planDecision(row, { today: TODAY });
  assert.equal(plan.action, 'close');
  assert.equal(plan.how, 'record-only');
  const deps = fakeDeps();
  await executeDecision(plan, row, deps);
  assert.deepEqual(deps.calls, []);
});

// ── shared ──────────────────────────────────────────────────────────────────

test('an item closed on an earlier run is only counted', () => {
  const plan = planDecision({ source: IDX, slug: 'p', decision: 'indexing-api-exhausted' }, { today: TODAY, closedOn: '2026-11-01' });
  assert.equal(plan.action, 'already-closed');
});

test('an unknown producer or decision goes to only-you with its own label', () => {
  assert.equal(planDecision({ source: 'agents/other/index.js', label: 'x' }, { today: TODAY }).action, 'only-you');
  const p = planDecision({ source: Q, decision: 'brand-new', label: 'do the thing' }, { today: TODAY });
  assert.equal(p.action, 'only-you');
  assert.match(p.reason, /do the thing/);
});

test('a row with no slug is never acted on', () => {
  assert.equal(planDecision({ source: Q, decision: 'health-claim' }, { today: TODAY }).action, 'only-you');
});

test('a close-out record stored as {on, reason} is recognised as closed', () => {
  const plan = planDecision({ source: DUP, slug: 't', decision: 'possible-duplicate' }, { today: TODAY, closedOn: '2026-11-01' });
  assert.equal(plan.action, 'already-closed');
});
