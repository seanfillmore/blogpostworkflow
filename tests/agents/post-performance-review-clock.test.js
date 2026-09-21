import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewClockStart, supersedeStaleReviews, currentFlop, GSC_BASIS } from '../../agents/post-performance/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The production case: `all-natural-lotion` was reviewed in July (30d BLOCKED,
// 60d REFRESH), refreshed and republished by queue-autoapply on 2026-08-30, and
// still sat on the dashboard as "Action Required" three weeks later.
const JULY = {
  '30d': { milestone: 30, verdict: 'BLOCKED', reviewed_at: '2026-07-10T13:30:00.000Z', gsc_basis: GSC_BASIS },
  '60d': { milestone: 60, verdict: 'REFRESH', reviewed_at: '2026-07-28T13:30:00.000Z', gsc_basis: GSC_BASIS },
};

describe('reviewClockStart', () => {
  test('a body refresh restarts the clock', () => {
    assert.equal(reviewClockStart({
      published_at: '2026-04-29T15:00:06.808Z',
      last_refreshed_at: '2026-08-30T07:33:29.659Z',
    }), '2026-08-30T07:33:29.659Z');
  });

  test('legacy-rebuilder\'s refreshed_at counts too', () => {
    assert.equal(reviewClockStart({ published_at: '2026-04-01T00:00:00Z', refreshed_at: '2026-06-01T00:00:00Z' }),
      '2026-06-01T00:00:00Z');
  });

  test('never refreshed → the publish date; garbage is ignored', () => {
    assert.equal(reviewClockStart({ published_at: '2026-04-01T00:00:00Z', last_refreshed_at: 'not a date' }),
      '2026-04-01T00:00:00Z');
    assert.equal(reviewClockStart({}), null);
  });
});

describe('supersedeStaleReviews', () => {
  test('every verdict made before the refresh is superseded, and kept as history', () => {
    const { current, superseded } = supersedeStaleReviews(JULY, '2026-08-30T07:33:29.659Z');
    assert.deepEqual(current, {});
    assert.equal(superseded.length, 2);
    assert.ok(superseded.every((r) => r.superseded_by === '2026-08-30T07:33:29.659Z'));
  });

  test('a review made after the clock start stands', () => {
    const later = { '30d': { verdict: 'ON_TRACK', reviewed_at: '2026-09-29T00:00:00Z', gsc_basis: GSC_BASIS } };
    const { current, superseded } = supersedeStaleReviews({ ...JULY, ...later }, '2026-08-30T07:33:29.659Z');
    assert.deepEqual(Object.keys(current), ['30d']);
    assert.equal(superseded.length, 1);
  });

  test('no clock start supersedes nothing', () => {
    assert.equal(supersedeStaleReviews(JULY, null).superseded.length, 0);
  });

  test('a review scored before the GSC URL fix is superseded whatever its date', () => {
    // Every pre-fix review queried the myshopify host and read 0/0 — e.g.
    // antibacterial-body-soap "BLOCKED" on 0 impressions while it had 21,835.
    const old = { '30d': { verdict: 'BLOCKED', reviewed_at: '2026-09-07T13:30:03.709Z', impressions: 0 } };
    const { current, superseded } = supersedeStaleReviews(old, '2026-08-05T00:00:00Z');
    assert.deepEqual(current, {});
    assert.equal(superseded[0].superseded_by, 'gsc-measurement-fix');
  });
});

describe('currentFlop', () => {
  test('only the LATEST milestone decides — one row per post', () => {
    const flop = currentFlop(JULY);
    assert.equal(flop.milestone, 60);
    assert.equal(flop.review.verdict, 'REFRESH');
  });

  test('a later ON_TRACK clears an earlier flop', () => {
    assert.equal(currentFlop({ ...JULY, '90d': { verdict: 'ON_TRACK', reviewed_at: '2026-08-28T00:00:00Z' } }), null);
  });

  test('no reviews → no flop', () => {
    assert.equal(currentFlop({}), null);
  });
});

test('queue-apply stamps last_refreshed_at when it replaces a body', () => {
  // publishBlogRefresh needs a real post with a Shopify id, which a checkout
  // does not have (state.json is gitignored), so this is a source pin.
  const src = readFileSync(join(ROOT, 'lib/queue-apply.js'), 'utf8');
  const fn = src.slice(src.indexOf('export async function publishBlogRefresh'), src.indexOf('export class SeoCopyClaimError'));
  assert.match(fn, /last_refreshed_at/);
  assert.ok(fn.indexOf('last_refreshed_at') > fn.indexOf('updateArticle('), 'stamp only after the live write');
});
