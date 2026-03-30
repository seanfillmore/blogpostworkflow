import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

// Extract the /run-agent endpoint handler
const runAgentMatch = src.match(/if \(req\.method === 'POST' && req\.url === '\/run-agent'\) \{[\s\S]*?\n  \}/);
assert.ok(runAgentMatch, 'Could not find /run-agent endpoint');

const runAgentHandler = runAgentMatch[0];

// Server must emit __exit__ signal in the /run-agent endpoint
assert.ok(
  runAgentHandler.includes('data: __exit__:'),
  'run-agent endpoint must emit data: __exit__: signal'
);

// Server must NOT use SSE event: done format in /run-agent endpoint
assert.ok(
  !runAgentHandler.includes('event: done'),
  'run-agent endpoint must not use SSE event: done format'
);

console.log('✓ run-agent server emits __exit__ signal');

// Banner CSS must be present
assert.ok(src.includes('.run-banner {'), 'must have .run-banner CSS');
assert.ok(src.includes('.run-banner-success {'), 'must have .run-banner-success CSS');
assert.ok(src.includes('.run-banner-error {'), 'must have .run-banner-error CSS');
assert.ok(src.includes('.run-banner-dismiss {'), 'must have .run-banner-dismiss CSS');

// showRunBanner function must exist
assert.ok(src.includes('function showRunBanner('), 'must have showRunBanner function');

// runAgent must parse __exit__ and hide log on done
assert.ok(src.includes('data: __exit__:'), 'runAgent must reference __exit__ signal');
assert.ok(src.includes("logEl.style.display = 'none'"), 'runAgent must hide log on completion');

// runAgent must default to loadData when onDone is null
assert.ok(src.includes('if (onDone) onDone(); else loadData();'), 'runAgent must call loadData when no onDone');

console.log('✓ dashboard run banner source assertions pass');
