// tests/lib/business-baseline.test.js
//
// The measured business figures have the same disease the paid-spend status had: prose
// and constants cannot expire on their own. These tests are what expires them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AOV_TRAILING_90D,
  SHOPIFY_MONTHLY_REVENUE,
  SHOPIFY_MONTHLY_ORDERS,
  BASELINE_AS_OF,
  BASELINE_MAX_AGE_DAYS,
  assertBusinessBaselineFresh,
} from '../../lib/business-baseline.js';
import { DEFAULT_AOV } from '../../lib/bing-keyword-gap.js';
import { buildConstraintBlock } from '../../lib/marketing-learner.js';

// ── the figures must be re-measured, not left to rot ──────────────────────────────────
{
  // This is the whole point of the module: a figure with no expiry drifted 8.5% while
  // every tactic in the fleet was scored against it and nothing said so.
  assertBusinessBaselineFresh();

  const asOf = new Date(`${BASELINE_AS_OF}T00:00:00Z`);
  const justInside = new Date(asOf.getTime() + BASELINE_MAX_AGE_DAYS * 86400000);
  const wellPast = new Date(asOf.getTime() + (BASELINE_MAX_AGE_DAYS + 30) * 86400000);
  assert.doesNotThrow(() => assertBusinessBaselineFresh(justInside));
  assert.throws(() => assertBusinessBaselineFresh(wellPast), /past the \d+-day limit/);

  // The error has to name the command that re-measures it, or "go update it" is advice
  // nobody can act on without first rediscovering how the figure was produced.
  assert.throws(() => assertBusinessBaselineFresh(wellPast), /aov-analysis\.mjs/);
}
console.log('✓ business-baseline freshness tests pass');

// ── ONE source: a second copy is a second copy that drifts ────────────────────────────
{
  // `lib/bing-keyword-gap.js` and `lib/marketing-learner.js` each carried their own
  // hardcoded 50.46. Both were stale, independently, and neither knew about the other.
  assert.equal(DEFAULT_AOV, AOV_TRAILING_90D,
    'bing-keyword-gap must re-export the shared figure, never re-declare it');

  const block = buildConstraintBlock();
  assert.ok(block.includes(`$${AOV_TRAILING_90D.toFixed(2)}`),
    'the constraint block must interpolate the shared figure, not spell its own');
  assert.ok(block.includes(BASELINE_AS_OF),
    'the stated figures must carry the date they were measured');

  // A source scan, because the whole failure mode is somebody typing the number again.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is the point rather than a convenience. Both
  // files name the stale $50.46 in prose deliberately — they explain the drift this
  // module exists to stop — and a scan that fires on its own documentation is the
  // `PRODUCT_CATEGORY_COMPLIANCE_RULE` trap, where the rule flagged the sentence stating
  // the rule. The hazard is a hardcoded constant in CODE; a figure named in a comment is
  // a record of history and must stay readable.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // The predicate is narrow on purpose. A blanket "no decimal literals" scan fires on
  // `SHRINK_FLOOR = 0.75`, on a `share < 0.30` threshold and on the $259.20 the giveaway
  // campaign really spent — all legitimate, none an AOV. Two precise rules instead:
  const scanned = ['lib/bing-keyword-gap.js', 'lib/marketing-learner.js'];
  for (const f of scanned) {
    const code = stripComments(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));

    // 1. The specific value that drifted may not reappear anywhere in code.
    assert.ok(!code.includes('50.46'),
      `${f} still hardcodes the stale $50.46 — import AOV_TRAILING_90D`);

    // 2. No identifier naming an AOV may be assigned a bare number. This is what a
    //    future re-declaration actually looks like, whatever value it carries.
    const reDeclared = /\b(?:const|let|var)\s+\w*AOV\w*\s*=\s*\d/i.exec(code);
    assert.equal(reDeclared, null,
      `${f} re-declares an AOV constant (${reDeclared?.[0]}) — import AOV_TRAILING_90D`);
  }
}
console.log('✓ business-baseline single-source tests pass');

// ── the figures must be internally consistent ─────────────────────────────────────────
{
  // Revenue, orders and AOV are three views of one measurement. If they do not
  // reconcile, at least one of them was updated without re-running the analysis —
  // exactly the drift this module exists to stop.
  const implied = SHOPIFY_MONTHLY_REVENUE / SHOPIFY_MONTHLY_ORDERS;
  assert.ok(Math.abs(implied - AOV_TRAILING_90D) / AOV_TRAILING_90D < 0.05,
    `revenue/orders implies AOV $${implied.toFixed(2)} but AOV is `
    + `$${AOV_TRAILING_90D.toFixed(2)} — re-run the analysis, do not patch one figure`);
}
console.log('✓ business-baseline consistency tests pass');
