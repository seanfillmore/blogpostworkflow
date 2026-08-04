import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { capReports, PER_REPORT_CHAR_CAP, TOTAL_CHAR_CAP } from '../../agents/insight-aggregator/index.js';

// This agent was the fleet's largest LLM line item: ~370,000 input tokens per
// call, 41% of all input tokens the fleet consumed. It read every changed report
// in full with no per-report truncation and no total limit — the 150k-token check
// only printed a warning and then sent the request anyway. These tests pin the
// warning into an actual cap.

const rpt = (path, chars, mtimeMs) => ({ path, agentDir: 'editor', mtimeMs, content: 'x'.repeat(chars) });

test('capReports truncates a single oversized report rather than dropping it', () => {
  const { reports, dropped, truncated } = capReports([rpt('a.md', PER_REPORT_CHAR_CAP * 3, 100)]);

  assert.equal(reports.length, 1, 'the report survives');
  assert.ok(reports[0].content.length <= PER_REPORT_CHAR_CAP + 200, 'content is truncated to the cap');
  assert.match(reports[0].content, /truncated/i, 'the truncation is visible to the model, not silent');
  assert.equal(truncated, 1);
  assert.equal(dropped.length, 0);
});

test('capReports leaves a report under the cap byte-identical', () => {
  const original = rpt('a.md', 500, 100);
  const { reports, truncated } = capReports([original]);

  assert.equal(reports[0].content, original.content, 'short reports pass through untouched');
  assert.equal(truncated, 0);
});

test('capReports drops the oldest reports once the total budget is exhausted', () => {
  // Per-report truncation runs first, so no single report can blow the total —
  // only a pile of individually-legal reports can. Exactly fill the budget, then
  // add one more; the oldest should be the one evicted.
  const fits = Math.floor(TOTAL_CHAR_CAP / PER_REPORT_CHAR_CAP);
  const input = [
    rpt('oldest.md', PER_REPORT_CHAR_CAP, 1),
    ...Array.from({ length: fits }, (_, i) => rpt(`r${i}.md`, PER_REPORT_CHAR_CAP, 100 + i)),
  ];

  const { reports, dropped } = capReports(input);
  const kept = reports.map((r) => r.path);

  assert.ok(kept.includes(`r${fits - 1}.md`), 'the newest report is always kept');
  assert.ok(!kept.includes('oldest.md'), 'the oldest is dropped first');
  assert.deepEqual(dropped, ['oldest.md'], 'what was dropped is reported, not silently discarded');

  const total = reports.reduce((n, r) => n + r.content.length, 0);
  assert.ok(total <= TOTAL_CHAR_CAP, `total ${total} must not exceed the cap ${TOTAL_CHAR_CAP}`);
});

test('capReports preserves the caller-visible ordering of what it keeps', () => {
  const input = [rpt('a.md', 100, 1), rpt('b.md', 100, 2), rpt('c.md', 100, 3)];
  const { reports } = capReports(input);
  assert.deepEqual(reports.map((r) => r.path), ['a.md', 'b.md', 'c.md'], 'kept reports stay in input order');
});

test('capReports handles an empty set', () => {
  const { reports, dropped, truncated } = capReports([]);
  assert.deepEqual(reports, []);
  assert.deepEqual(dropped, []);
  assert.equal(truncated, 0);
});

// The agent called run() unconditionally at module scope, so importing it — as
// this test file does — executed the whole thing against live reports and the
// Anthropic API, then killed the test process via its process.exit(1) handler.
test('importing the module does not execute the agent', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const agent = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'insight-aggregator', 'index.js');

  const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(agent)}).then(() => console.log('CLEAN'))`], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /CLEAN/);
  assert.ok(!/Loaded \d+ new|Asking Claude/.test(out), `the agent must not run on import — got: ${out.slice(0, 200)}`);
});

console.log('✓ insight-aggregator tests pass');
