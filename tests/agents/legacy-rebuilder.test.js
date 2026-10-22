import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderRebuildSummary, clearNeedsRebuild } from '../../agents/legacy-rebuilder/index.js';

// The digest said "Legacy Rebuilder: 4 rebuilt, 1 failed" and nothing else — no
// slug, no reason. The detail existed but only reached console.error, and the
// `rebuildPost() returned false` path recorded nothing at all. A failure you
// cannot name is a failure you cannot act on.

test('renderRebuildSummary names each failure and its reason', () => {
  const body = renderRebuildSummary({
    succeeded: 4,
    failures: [{ slug: 'best-soap-for-tattoos', reason: 'editor gate: needs_rebuild still set' }],
    remaining: 75,
  });

  assert.match(body, /4 post/, 'the success count survives');
  assert.match(body, /best-soap-for-tattoos/, 'the failing slug is named');
  assert.match(body, /editor gate/, 'the reason is included');
  assert.match(body, /75 legacy posts remain/);
});

test('renderRebuildSummary handles a clean run', () => {
  const body = renderRebuildSummary({ succeeded: 5, failures: [], remaining: 70 });
  assert.ok(!/failed/i.test(body), 'no failure section when nothing failed');
  assert.match(body, /5 post/);
});

test('renderRebuildSummary reports a failure with no captured reason', () => {
  const body = renderRebuildSummary({
    succeeded: 0,
    failures: [{ slug: 'mystery-post', reason: null }],
    remaining: 76,
  });
  // The false-return path has no error object. Say so explicitly rather than
  // emitting a bare slug that looks like the reason was omitted by accident.
  assert.match(body, /mystery-post/);
  assert.match(body, /no reason captured/i);
});

test('renderRebuildSummary lists every failure, not just the first', () => {
  const body = renderRebuildSummary({
    succeeded: 1,
    failures: [
      { slug: 'a', reason: 'boom' },
      { slug: 'b', reason: 'bang' },
    ],
    remaining: 10,
  });
  assert.match(body, /a/);
  assert.match(body, /b/);
});

// ── the `broken` bucket used to be immortal ─────────────────────────────────
// rebuildPost() returned true for a broken-bucket post WITHOUT clearing
// needs_rebuild, so the same post re-entered findLegacyPosts() every single day
// and re-surfaced in the digest forever. The `winner` branch had always cleared
// it; `broken` never did.

test('clearNeedsRebuild drops the flag and records the acknowledgement', () => {
  const meta = { slug: 'x', needs_rebuild: { flagged_at: '2026-08-16T00:00:00Z' }, legacy_bucket: 'broken' };
  const { meta: out, cleared } = clearNeedsRebuild(meta, { ackField: 'legacy_broken_ack_at', at: '2026-08-22T00:00:00Z' });
  assert.equal(cleared, true);
  assert.equal(out.needs_rebuild, undefined);
  assert.equal(out.legacy_broken_ack_at, '2026-08-22T00:00:00Z');
  assert.equal(out.legacy_bucket, 'broken', 'the bucket survives — the post still needs a manual technical fix');
});

test('clearNeedsRebuild is a no-op when the flag was never set', () => {
  const meta = { slug: 'x', legacy_bucket: 'broken' };
  const { meta: out, cleared } = clearNeedsRebuild(meta, { ackField: 'legacy_broken_ack_at', at: 'T' });
  assert.equal(cleared, false);
  assert.equal(out.legacy_broken_ack_at, undefined, 'no stamp when nothing was cleared');
  assert.deepEqual(out, meta);
});

test('clearNeedsRebuild tolerates a null meta', () => {
  const { meta: out, cleared } = clearNeedsRebuild(null, { ackField: 'a', at: 'T' });
  assert.equal(cleared, false);
  assert.deepEqual(out, {});
});

console.log('✓ legacy-rebuilder tests pass');

// ── 2026-10-21: the light refresh locked 29 blocked posts out of every fix ────
// It stamped a 28-day `rewrite` on pages whose intro it never rewrote (0 of 29
// answer-first runs applied anything), then cleared needs_rebuild whatever the
// editor said. blocked-post-resolver could not touch any of them.
import { readFileSync } from 'node:fs';
import { isLegacyCandidate } from '../../agents/legacy-rebuilder/index.js';

const SRC = readFileSync(new URL('../../agents/legacy-rebuilder/index.js', import.meta.url), 'utf8');
const lightRefreshBody = SRC.slice(SRC.indexOf('async function lightRefresh'), SRC.indexOf('async function rebuildPost'));

test('the light refresh records no material edit of its own', () => {
  // answer-first-rewriter stamps `rewrite` itself when it actually rewrites;
  // buy box, schema and year fixes are enhance/repair and start no clock.
  assert.ok(lightRefreshBody.length > 100, 'lightRefresh not found');
  assert.doesNotMatch(lightRefreshBody, /recordMaterialEdit\(/);
});

test('the light refresh clears needs_rebuild only when the editor report passes', () => {
  assert.match(lightRefreshBody, /isPassing\(/);
});

test('a schema-carrying rising post with needs_rebuild is left to blocked-post-resolver', () => {
  // A light refresh never touches body copy, so it cannot fix a content blocker.
  assert.equal(isLegacyCandidate({ legacy: false, meta: { legacy_bucket: 'rising', needs_rebuild: { reasons: ['x'] } } }), false);
});

test('legacy (schema-less) posts and flagged non-rising posts are still candidates', () => {
  assert.equal(isLegacyCandidate({ legacy: true, meta: { legacy_bucket: 'rising' } }), true);
  assert.equal(isLegacyCandidate({ legacy: false, meta: { legacy_bucket: 'flop', needs_rebuild: { reasons: ['x'] } } }), true);
  assert.equal(isLegacyCandidate({ legacy: false, meta: { needs_rebuild: { reasons: ['x'] } } }), true);
  assert.equal(isLegacyCandidate({ legacy: false, meta: { legacy_bucket: 'flop' } }), false);
});
