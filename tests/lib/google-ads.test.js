import { strict as assert } from 'assert';
import { buildHeaders, parseCustomerId, yesterdayPT } from '../../lib/google-ads.js';

// buildHeaders returns required headers
const headers = buildHeaders('fake-access-token', 'fake-dev-token');
assert.equal(headers['Authorization'], 'Bearer fake-access-token');
assert.equal(headers['developer-token'], 'fake-dev-token');
assert.equal(headers['Content-Type'], 'application/json');

// parseCustomerId strips dashes
assert.equal(parseCustomerId('123-456-7890'), '1234567890');
assert.equal(parseCustomerId('1234567890'), '1234567890');

// yesterdayPT returns YYYY-MM-DD format
const y = yesterdayPT();
assert.match(y, /^\d{4}-\d{2}-\d{2}$/);

console.log('✓ google-ads lib unit tests pass');
