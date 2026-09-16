import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// getAllOrders() interpolates its arguments straight into created_at_min/max,
// and a BARE date end is read as midnight — so a window's whole final day of
// orders is silently dropped. Verified against the live API on 2026-09-16:
// getAllOrders('2026-09-12', '2026-09-12') returned 0 orders while #2352 was
// created that morning. scripts/commercial-page-cvr.mjs shipped with exactly
// that call in PR #888, so every CVR it printed was missing a day of orders.
//
// A source scan rather than a behavioural test: the script's main() runs on
// import and needs live GA4 and Shopify credentials.
// ─────────────────────────────────────────────────────────────────────────────

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'commercial-page-cvr.mjs'),
  'utf8',
);

test('commercial-page-cvr bounds the order fetch with Pacific day bounds', () => {
  assert.match(src, /import \{ ptDayBounds \} from '\.\.\/agents\/shopify-collector\/index\.js'/);
  assert.match(src, /getAllOrders\(ptDayBounds\(start\)\.dayStart, ptDayBounds\(end\)\.dayEnd\)/);
});

test('commercial-page-cvr never hands getAllOrders a bare date pair', () => {
  assert.doesNotMatch(src, /getAllOrders\(\s*start\s*,\s*end\s*\)/);
});
