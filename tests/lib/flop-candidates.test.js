import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  refreshableFlops, renderFlopSkipLines, flopAction, countByAction, FLOP_ACTIONS,
} from '../../lib/flop-candidates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCKED = new Set(['cocoa-butter-lotion', 'goat-milk-lotion']);
const mayRewriteBody = (slug) => (LOCKED.has(slug)
  ? { allowed: false, reason: 'legacy winner (locked)' }
  : { allowed: true });

describe('refreshableFlops', () => {
  test('the 2026-09-21 jam: two locked winners at the head no longer eat the cap', () => {
    // Production order that morning: the same three rows led every run, two of
    // them locked, so a cap of 3 refreshed at most one post a day — and that one
    // failed on a slug mismatch, so the run queued nothing.
    const rows = [
      { slug: 'cocoa-butter-lotion', verdict: 'REFRESH' },
      { slug: 'goat-milk-lotion', verdict: 'REFRESH' },
      { slug: 'what-is-organic-coconut-oil-uses-benefits-types', verdict: 'REFRESH' },
      { slug: 'coconut-lotion-benefits', verdict: 'REFRESH' },
      { slug: 'best-unscented-lotion', verdict: 'REFRESH' },
    ];
    const { kept, skipped } = refreshableFlops(rows, { mayRewriteBody });
    assert.deepEqual(kept.map((r) => r.slug).slice(0, 3), [
      'what-is-organic-coconut-oil-uses-benefits-types', 'coconut-lotion-benefits', 'best-unscented-lotion',
    ]);
    assert.deepEqual(skipped.map((s) => [s.slug, s.why]), [
      ['cocoa-butter-lotion', 'locked'], ['goat-milk-lotion', 'locked'],
    ]);
  });

  test('only REFRESH is refreshable — a rewrite cannot fix zero demand, indexing or a demote', () => {
    const rows = ['BLOCKED', 'NOT_INDEXED', 'DEMOTE', 'REFRESH'].map((verdict, i) => ({ slug: `p${i}`, verdict }));
    const { kept, skipped } = refreshableFlops(rows, { mayRewriteBody });
    assert.deepEqual(kept.map((r) => r.slug), ['p3']);
    assert.equal(skipped.length, 3);
    assert.ok(skipped.every((s) => s.why === 'not-refreshable'));
  });

  test('one row per post, even if the report carries duplicates', () => {
    const rows = [
      { slug: 'a', verdict: 'REFRESH', milestone: 60 },
      { slug: 'a', verdict: 'BLOCKED', milestone: 30 },
    ];
    const { kept, skipped } = refreshableFlops(rows, { mayRewriteBody });
    assert.equal(kept.length, 1);
    assert.equal(skipped.length, 0);
  });

  test('skips are reported, never silent', () => {
    const { skipped } = refreshableFlops([
      { slug: 'cocoa-butter-lotion', verdict: 'REFRESH' },
      { slug: 'x', verdict: 'BLOCKED' },
    ], { mayRewriteBody });
    const [line] = renderFlopSkipLines(skipped);
    assert.match(line, /1 locked winner \(cocoa-butter-lotion\)/);
    assert.match(line, /1 BLOCKED\/NOT_INDEXED\/LOW_DEMAND\/DEMOTE/);
    assert.deepEqual(renderFlopSkipLines([]), []);
  });
});

describe('flopAction', () => {
  test('maps every verdict to what happens next', () => {
    assert.equal(flopAction({ slug: 'a', verdict: 'REFRESH' }, { mayRewriteBody }), 'auto-refresh');
    assert.equal(flopAction({ slug: 'cocoa-butter-lotion', verdict: 'REFRESH' }, { mayRewriteBody }), 'locked');
    assert.equal(flopAction({ slug: 'a', verdict: 'NOT_INDEXED' }, { mayRewriteBody }), 'not-indexed');
    assert.equal(flopAction({ slug: 'a', verdict: 'BLOCKED' }, { mayRewriteBody }), 'no-demand');
    assert.equal(flopAction({ slug: 'a', verdict: 'DEMOTE' }, { mayRewriteBody }), 'demote');
  });

  test('agrees with refreshableFlops about what is refreshable', () => {
    for (const verdict of ['REFRESH', 'BLOCKED', 'NOT_INDEXED', 'DEMOTE']) {
      for (const slug of ['free', 'cocoa-butter-lotion']) {
        const row = { slug, verdict };
        const auto = flopAction(row, { mayRewriteBody }) === 'auto-refresh';
        const kept = refreshableFlops([row], { mayRewriteBody }).kept.length === 1;
        assert.equal(auto, kept, `${verdict}/${slug}`);
      }
    }
  });

  test('only the two human-decision actions are un-automated', () => {
    const manual = Object.entries(FLOP_ACTIONS).filter(([, v]) => !v.automated).map(([k]) => k);
    assert.deepEqual(manual.sort(), ['demote', 'no-demand']);
  });

  test('countByAction covers every action, zeros included', () => {
    const c = countByAction([{ action: 'demote' }, { action: 'demote' }, { action: 'locked' }]);
    assert.deepEqual(Object.keys(c), Object.keys(FLOP_ACTIONS));
    assert.equal(c.demote, 2);
    assert.equal(c['auto-refresh'], 0);
  });
});

// The agents cannot be imported without running them, so the wiring is pinned
// by source scan: both consumers of post-performance's list must filter through
// the shared rule, never re-hand-roll `verdict === 'REFRESH' || 'BLOCKED'`.
describe('consumers use the shared filter', () => {
  for (const file of ['agents/performance-engine/index.js', 'agents/refresh-runner/index.js']) {
    test(file, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      assert.match(src, /refreshableFlops\(/);
      assert.doesNotMatch(src, /verdict === 'REFRESH' \|\| f\.verdict === 'BLOCKED'/);
    });
  }
});

test('LOW_DEMAND is a human decision, never refreshed', () => {
  assert.equal(flopAction({ slug: 'a', verdict: 'LOW_DEMAND' }, { mayRewriteBody }), 'no-demand');
  assert.equal(refreshableFlops([{ slug: 'a', verdict: 'LOW_DEMAND' }], { mayRewriteBody }).kept.length, 0);
});
