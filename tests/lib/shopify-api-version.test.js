import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, checkServedApiVersion } from '../../lib/shopify-api-version.js';

// ── The pin itself ────────────────────────────────────────────────────────────
// These are not decoration. The whole class of bug this module exists for is a
// version constant that quietly stops matching reality, so the constant's SHAPE
// is asserted: a Shopify quarterly release is YYYY-MM with MM in {01,04,07,10}.
// A typo'd month would fall-forward silently on the live API and be invisible.

test('API_VERSION is a well-formed Shopify quarterly release', () => {
  assert.match(API_VERSION, /^\d{4}-(01|04|07|10)$/);
});

test('API_VERSION is the target stable release 2026-07', () => {
  assert.equal(API_VERSION, '2026-07');
});

// ── Drift detection ───────────────────────────────────────────────────────────

test('checkServedApiVersion: no drift when served matches requested', () => {
  const r = checkServedApiVersion({ 'x-shopify-api-version': '2026-07' }, { requested: '2026-07' });
  assert.equal(r.drifted, false);
  assert.equal(r.message, null);
  assert.equal(r.served, '2026-07');
});

test('checkServedApiVersion: detects the real fall-forward (asked 2025-01, served 2025-10)', () => {
  const r = checkServedApiVersion(
    { 'x-shopify-api-version': '2025-10', 'x-shopify-api-version-warning': 'https://shopify.dev/concepts/about-apis/versioning' },
    { requested: '2025-01' },
  );
  assert.equal(r.drifted, true);
  assert.equal(r.served, '2025-10');
  assert.equal(r.requested, '2025-01');
  assert.match(r.message, /requested 2025-01/);
  assert.match(r.message, /SERVED 2025-10/);
  assert.match(r.message, /versioning/); // the warning header is carried into the message
});

// A missing header is NOT drift. Inventing a failure from an absent header would
// fire on every response that omits it and train everyone to ignore the warning.
test('checkServedApiVersion: absent version header is not drift', () => {
  const r = checkServedApiVersion({}, { requested: '2026-07' });
  assert.equal(r.drifted, false);
  assert.equal(r.served, null);
  assert.equal(r.message, null);
});

test('checkServedApiVersion: null/undefined headers are not drift', () => {
  assert.equal(checkServedApiVersion(null).drifted, false);
  assert.equal(checkServedApiVersion(undefined).drifted, false);
});

test('checkServedApiVersion: defaults requested to API_VERSION', () => {
  assert.equal(checkServedApiVersion({ 'x-shopify-api-version': API_VERSION }).drifted, false);
  assert.equal(checkServedApiVersion({ 'x-shopify-api-version': '2025-10' }).drifted, true);
});

// ── Header access ─────────────────────────────────────────────────────────────
// The production call sites pass a real `Headers` instance from fetch(); the
// tests pass plain objects. Both must work or the guard is dead in production
// while its tests stay green.

test('checkServedApiVersion: reads a real fetch Headers instance', () => {
  const h = new Headers({ 'X-Shopify-API-Version': '2025-10' });
  const r = checkServedApiVersion(h, { requested: '2026-07' });
  assert.equal(r.drifted, true);
  assert.equal(r.served, '2025-10');
});

test('checkServedApiVersion: plain-object header lookup is case-insensitive', () => {
  const r = checkServedApiVersion({ 'X-Shopify-API-Version': '2025-10' }, { requested: '2026-07' });
  assert.equal(r.drifted, true);
  assert.equal(r.served, '2025-10');
});

// ── Deprecation passthrough ───────────────────────────────────────────────────
// Live probe 2026-08-19: REST /products.json and /products/count.json return
// `x-shopify-api-deprecated-reason` on BOTH 2026-07 and 2026-10 while still
// serving 200 with an unchanged payload. That is a separate signal from drift
// and must not be conflated with it.

test('checkServedApiVersion: surfaces the deprecation reason without calling it drift', () => {
  const r = checkServedApiVersion({
    'x-shopify-api-version': '2026-07',
    'x-shopify-api-deprecated-reason': 'https://shopify.dev/api/admin-rest/latest/resources/product',
  }, { requested: '2026-07' });
  assert.equal(r.drifted, false);
  assert.equal(r.deprecated, 'https://shopify.dev/api/admin-rest/latest/resources/product');
});
