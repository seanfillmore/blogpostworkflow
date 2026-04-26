import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { readAllDashboardSource } from '../helpers/dashboard-source.js';

// The /run-agent endpoint moved from the monolithic dashboard/index.js
// to agents/dashboard/routes/agents.js + lib/run-agent.js when the
// dashboard was refactored. This test asserts the post-refactor surface.

const src = readAllDashboardSource();
const runAgentLib = readFileSync('agents/dashboard/lib/run-agent.js', 'utf8');

// Server side: /run-agent route registered + emits the __exit__ SSE signal.
// The negative check (no `event: done`) is scoped to the run-agent handler
// itself — other routes (e.g. /apply-ads in routes/ads.js) legitimately
// use `event: done`, so a global check would false-positive.
assert.ok(src.includes("'/run-agent'"), 'must register /run-agent route');
assert.ok(runAgentLib.includes('data: __exit__:'), 'lib/run-agent.js must emit data: __exit__: signal');
assert.ok(!runAgentLib.includes('event: done'), 'lib/run-agent.js must not use SSE event: done format');

// Banner CSS classes
assert.ok(/\.run-banner\b/.test(src), 'must have .run-banner CSS');
assert.ok(src.includes('.run-banner-success'), 'must have .run-banner-success CSS');
assert.ok(src.includes('.run-banner-error'), 'must have .run-banner-error CSS');
assert.ok(src.includes('.run-banner-dismiss'), 'must have .run-banner-dismiss CSS');

// Browser-side helpers
assert.ok(src.includes('function showRunBanner('), 'must have showRunBanner function');
assert.ok(src.includes("logEl.style.display = 'none'"), 'must hide log on completion');
assert.ok(src.includes('if (onDone) onDone(); else loadData();'), 'must call loadData when no onDone');

console.log('✓ dashboard run-agent + banner assertions pass');
