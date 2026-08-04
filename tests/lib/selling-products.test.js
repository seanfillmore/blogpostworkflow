import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  productRevenueByTerm, sellingScopeTerms, isKeywordSelling, optimizationScopeTerms,
} from '../../lib/selling-products.js';

function snapshotDir(days) {
  const dir = mkdtempSync(join(tmpdir(), 'shopify-snaps-'));
  mkdirSync(dir, { recursive: true });
  for (const [date, topProducts] of Object.entries(days)) {
    writeFileSync(join(dir, `${date}.json`), JSON.stringify({ date, topProducts }));
  }
  return dir;
}

test('productRevenueByTerm sums revenue per product-scope term', () => {
  const dir = snapshotDir({
    '2026-08-01': [{ title: 'Non-Toxic Body Lotion', revenue: 60, orders: 2 }],
    '2026-08-02': [
      { title: 'Coconut Oil Deodorant | 2oz', revenue: 15, orders: 1 },
      { title: 'Non-Toxic Body Lotion', revenue: 30, orders: 1 },
    ],
  });

  const rev = productRevenueByTerm({ snapshotsDir: dir });
  assert.equal(rev.get('lotion'), 90, 'revenue accumulates across days');
  assert.equal(rev.get('deodorant'), 15);
  // One product can carry several terms — the deodorant is also a coconut-oil product.
  assert.equal(rev.get('coconut oil'), 15);
  assert.equal(rev.get('toothpaste'), undefined, 'a term that never sold is absent');
});

test('sellingScopeTerms keeps anything with revenue and drops the rest', () => {
  const dir = snapshotDir({
    '2026-08-01': [
      { title: 'Non-Toxic Body Lotion', revenue: 1801, orders: 40 },
      { title: 'Fluoride-Free Toothpaste', revenue: 143, orders: 8 },
    ],
  });

  const terms = sellingScopeTerms({ snapshotsDir: dir });
  assert.ok(terms.has('lotion'));
  // $143 over the window is small but it is not zero — the rule is "products that
  // sell", not "products that sell a lot". Tightening is the threshold's job.
  assert.ok(terms.has('toothpaste'), 'a low-revenue product still counts as selling');
  assert.ok(!terms.has('cream'), 'a product with no recorded revenue does not');
});

test('sellingScopeTerms honours a revenue threshold', () => {
  const dir = snapshotDir({
    '2026-08-01': [
      { title: 'Non-Toxic Body Lotion', revenue: 1801, orders: 40 },
      { title: 'Fluoride-Free Toothpaste', revenue: 143, orders: 8 },
    ],
  });

  const terms = sellingScopeTerms({ snapshotsDir: dir, minRevenue: 500 });
  assert.ok(terms.has('lotion'));
  assert.ok(!terms.has('toothpaste'), 'below the threshold is filtered out');
});

// The safety property. Snapshots are gitignored and written by cron on the server,
// so a local checkout has none — and the server can have a collector outage. If a
// missing feed meant "nothing sells", this filter would silently stop every refresh
// in the fleet and look like the pipeline had simply gone quiet.
test('sellingScopeTerms fails OPEN when there is no revenue data', () => {
  const empty = mkdtempSync(join(tmpdir(), 'shopify-empty-'));
  const terms = sellingScopeTerms({ snapshotsDir: empty });
  assert.equal(terms, null, 'no data yields null, meaning "do not filter"');

  const missing = sellingScopeTerms({ snapshotsDir: join(empty, 'does-not-exist') });
  assert.equal(missing, null, 'a missing directory also fails open');
});

test('isKeywordSelling matches a keyword against the selling set', () => {
  const terms = new Set(['lotion', 'deodorant']);
  assert.equal(isKeywordSelling('best natural body lotion', terms), true);
  assert.equal(isKeywordSelling('fluoride free toothpaste', terms), false);
  assert.equal(isKeywordSelling('', terms), false);

  // A null set is the fail-open signal: everything passes.
  assert.equal(isKeywordSelling('fluoride free toothpaste', null), true);
});

// A keyword tied to no product at all ("natural skincare routine") corresponds to
// no product that sells, so it is out of scope under the same rule.
test('isKeywordSelling rejects a keyword that maps to no product category', () => {
  assert.equal(isKeywordSelling('natural skincare routine tips', new Set(['lotion'])), false);
});

// ── optimizationScopeTerms: the operator's explicit narrowing ────────────────
// Narrowed to lotion on 2026-08-03 (62% of trailing-90d product revenue), with a
// 60-day review. An explicit allowlist rather than a revenue threshold, because a
// threshold silently re-admits a category the moment its revenue drifts across the
// line — the decision to widen should be a decision, not a side effect.

test('optimizationScopeTerms uses the configured allowlist when present', () => {
  const dir = snapshotDir({
    '2026-08-01': [
      { title: 'Non-Toxic Body Lotion', revenue: 1801, orders: 40 },
      { title: 'Fluoride-Free Toothpaste', revenue: 143, orders: 8 },
    ],
  });

  const { terms } = optimizationScopeTerms({ snapshotsDir: dir, config: { terms: ['lotion'] } });
  assert.deepEqual([...terms], ['lotion'], 'only the allowlisted term is in scope');
  assert.equal(isKeywordSelling('best natural body lotion', terms), true);
  assert.equal(isKeywordSelling('fluoride free toothpaste', terms), false);
});

test('optimizationScopeTerms warns when an allowlisted term has no revenue', () => {
  const dir = snapshotDir({ '2026-08-01': [{ title: 'Non-Toxic Body Lotion', revenue: 1801, orders: 40 }] });

  const { terms, unsold } = optimizationScopeTerms({
    snapshotsDir: dir,
    config: { terms: ['lotion', 'body butter'] },
  });

  // The allowlist is the operator's call, so the term stays in scope — but a term
  // that stopped selling is surfaced rather than quietly honoured forever.
  assert.ok(terms.has('body butter'), 'the allowlist is not silently overridden');
  assert.deepEqual(unsold, ['body butter'], 'the unsold term is reported for review');
});

test('optimizationScopeTerms falls back to all selling terms when unconfigured', () => {
  const dir = snapshotDir({
    '2026-08-01': [
      { title: 'Non-Toxic Body Lotion', revenue: 1801, orders: 40 },
      { title: 'Fluoride-Free Toothpaste', revenue: 143, orders: 8 },
    ],
  });

  const { terms } = optimizationScopeTerms({ snapshotsDir: dir, config: { terms: null } });
  assert.ok(terms.has('lotion') && terms.has('toothpaste'), 'both selling categories are in scope');
});

test('optimizationScopeTerms fails open with no revenue data', () => {
  const empty = mkdtempSync(join(tmpdir(), 'shopify-empty-2-'));
  const { terms } = optimizationScopeTerms({ snapshotsDir: empty, config: { terms: ['lotion'] } });
  assert.equal(terms, null, 'no data means do not filter, even with an allowlist');
});

console.log('✓ selling-products tests pass');
