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

// ── ingestConversionEvents: the zero-event early return must match the real contract ──
//
// Regression, 2026-09-01. The early return for an empty event list handed back
// { accepted, errors, response } while the success path returns
// { submitted, requestId, fieldWarnings, validateOnly, response }. Callers iterate
// result.fieldWarnings, so a run with nothing to upload crashed with
// "result.fieldWarnings is not iterable" — which is exactly the state the account
// has been in since 2026-08-13 (no order carrying a Google click id). It killed
// agents/ads-conversion-uploader on 5 consecutive nights.
//
// The 'accepted' key was also a leftover of the pre-PR-#447 vocabulary that was
// removed precisely because it fabricated an acceptance count Google never gives us.
const { ingestConversionEvents } = await import('../../lib/google-ads.js');

for (const body of [{ events: [] }, {}, { events: undefined }]) {
  const empty = await ingestConversionEvents(body);
  assert.ok(Array.isArray(empty.fieldWarnings),
    'zero-event return must expose an iterable fieldWarnings — callers loop over it');
  assert.equal(empty.fieldWarnings.length, 0);
  assert.equal(empty.submitted, 0, 'zero-event return must report submitted: 0');
  assert.equal(empty.requestId, null, 'nothing was submitted, so there is no requestId');
  assert.ok(!('accepted' in empty),
    'must not resurrect the fabricated "accepted" count removed in PR #447');
}

// It must not have made a network call to learn any of that.
assert.equal((await ingestConversionEvents({ events: [] })).response, null);

console.log('✓ ingestConversionEvents zero-event contract tests pass');
