import { strict as assert } from 'node:assert';
import { readAllDashboardSource } from '../helpers/dashboard-source.js';

const src = readAllDashboardSource();

// Endpoint moved from monolithic dashboard/index.js to routes/dataforseo.js
// when the dashboard was refactored. The router uses pattern-matching
// (`match: '/api/reject-keyword'`) instead of `req.url === ...` equality.
assert.ok(src.includes("'/api/reject-keyword'"), 'endpoint route exists');
assert.ok(src.includes('rejected-keywords.json'), 'references rejected-keywords.json');
assert.ok(src.includes('keyword and matchType are required'), 'validates required fields');

// This route used to stamp `rejectedAt`, and this test used to pin that spelling.
// None of the nine `isRejected` implementations reads it — 36 of the 39 entries on
// the server use `rejected_at` — so every rejection this route wrote carried a date
// nothing could see. It was also the only writer with no dedupe at all
// (unconditional push). Both go through lib/rejected-keywords.js now, which
// normalizes the spelling and merges instead of clobbering.
assert.ok(!src.includes('rejectedAt:'), 'no route stamps the unread camelCase spelling');
assert.ok(
  src.includes("from '../../../lib/rejected-keywords.js'"),
  'rejection writes go through the shared merge-not-clobber writer',
);

console.log('All dashboard-reject-keyword tests passed.');
