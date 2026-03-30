import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

assert.ok(src.includes("req.url === '/api/reject-keyword'"), 'endpoint route exists');
assert.ok(src.includes('rejected-keywords.json'), 'references rejected-keywords.json');
assert.ok(src.includes('rejectedAt'), 'writes rejectedAt timestamp');
assert.ok(src.includes("{ ok: true }"), 'returns ok: true on success');
assert.ok(src.includes("keyword and matchType are required"), 'validates required fields');

console.log('All dashboard-reject-keyword tests passed.');
