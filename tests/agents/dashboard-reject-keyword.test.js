import { strict as assert } from 'node:assert';
import { readAllDashboardSource } from '../helpers/dashboard-source.js';

const src = readAllDashboardSource();

// Endpoint moved from monolithic dashboard/index.js to routes/dataforseo.js
// when the dashboard was refactored. The router uses pattern-matching
// (`match: '/api/reject-keyword'`) instead of `req.url === ...` equality.
assert.ok(src.includes("'/api/reject-keyword'"), 'endpoint route exists');
assert.ok(src.includes('rejected-keywords.json'), 'references rejected-keywords.json');
assert.ok(src.includes('rejectedAt'), 'writes rejectedAt timestamp');
assert.ok(src.includes('keyword and matchType are required'), 'validates required fields');

console.log('All dashboard-reject-keyword tests passed.');
