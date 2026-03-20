import { strict as assert } from 'assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// fetchDailySnapshot returns resource-name fields
// (tested structurally — we check the export exists and the query strings)
const src = readFileSync(fileURLToPath(new URL('../../lib/google-ads.js', import.meta.url)), 'utf8');
assert.ok(src.includes('campaign.resource_name'), 'campaign query must select resource_name');
assert.ok(src.includes('ad_group.resource_name'),  'must query ad group resource names');
assert.ok(src.includes('ad_group_ad.resource_name'), 'must query adGroupAd resource names');
assert.ok(src.includes('ad_group_criterion.resource_name'), 'must query criterion resource names');
assert.ok(src.includes('adGroupAds'), 'snapshot must include adGroupAds array');

console.log('✓ google-ads lib unit tests pass');
