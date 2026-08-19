import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInventory, triageOrphanBrief } from '../../lib/brief-triage.js';

// ── splitInventory ────────────────────────────────────────────────────────────
// content-strategist told the planner "EXISTING CONTENT (already published or
// briefed — DO NOT include these)" from one merged set. So generating a brief
// declared the topic covered, and it was excluded from every later calendar —
// never scheduled, never written. 73 briefs had orphaned that way by 2026-08-18.

test('splitInventory keeps a briefed-but-unwritten topic out of the do-not-propose list', () => {
  const { covered, prepaid } = splitInventory({
    briefSlugs: ['vegan-soap'],
    contentSlugs: [],
  });
  assert.deepEqual(covered, []);
  assert.deepEqual(prepaid, ['vegan-soap'], 'a brief is not coverage — the post still has to be written');
});

test('splitInventory counts a topic as covered once the post exists', () => {
  const { covered, prepaid } = splitInventory({
    briefSlugs: ['vegan-soap'],
    contentSlugs: ['vegan-soap'],
  });
  assert.deepEqual(covered, ['vegan-soap']);
  assert.deepEqual(prepaid, []);
});

test('splitInventory reports posts with no brief as covered', () => {
  const { covered } = splitInventory({ briefSlugs: [], contentSlugs: ['legacy-post'] });
  assert.deepEqual(covered, ['legacy-post']);
});

test('splitInventory sorts both lists so the prompt is stable run to run', () => {
  const { covered, prepaid } = splitInventory({
    briefSlugs: ['b', 'a'],
    contentSlugs: ['z', 'y'],
  });
  assert.deepEqual(prepaid, ['a', 'b']);
  assert.deepEqual(covered, ['y', 'z']);
});

// ── triageOrphanBrief ─────────────────────────────────────────────────────────
// Orphans that accumulated under the old behaviour get the same gates the
// strategist would apply today. Anything that survives goes back on the calendar
// and gets written; anything that fails is dropped rather than left in limbo.

const CTX = {
  publishedKeywords: ['natural antiperspirant'],
  rejectedKeywords: ['best deodorant for tweens'],
  brandTerms: ['real skin care'],
  inScope: (kw) => /deodorant|antiperspirant|toothpaste|lotion|soap|lip balm|coconut oil/.test(kw),
};

test('triageOrphanBrief drops a brief whose keyword is already published', () => {
  const r = triageOrphanBrief('natural antiperspirant', CTX);
  assert.equal(r.keep, false);
  assert.match(r.reason, /already covered/i);
});

test('triageOrphanBrief drops a brief on the rejected list', () => {
  const r = triageOrphanBrief('best deodorant for tweens', CTX);
  assert.equal(r.keep, false);
  assert.match(r.reason, /rejected/i);
});

test('triageOrphanBrief drops a branded keyword', () => {
  const r = triageOrphanBrief('real skin care deodorant', CTX);
  assert.equal(r.keep, false);
  assert.match(r.reason, /branded/i);
});

test('triageOrphanBrief drops an out-of-scope keyword', () => {
  const r = triageOrphanBrief('best shampoo for curly hair', CTX);
  assert.equal(r.keep, false);
  assert.match(r.reason, /scope/i);
});

test('triageOrphanBrief keeps a brief that is still worth writing', () => {
  const r = triageOrphanBrief('oatmeal soap benefits', CTX);
  assert.equal(r.keep, true);
  assert.equal(r.reason, null);
});

test('triageOrphanBrief drops a near-duplicate of a published post, not just an exact match', () => {
  const r = triageOrphanBrief('antiperspirant that is natural', {
    ...CTX, publishedKeywords: ['natural antiperspirant'],
  });
  assert.equal(r.keep, false);
  assert.match(r.reason, /already covered/i);
});
