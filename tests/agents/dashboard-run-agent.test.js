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
