import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderRebuildSummary } from '../../agents/legacy-rebuilder/index.js';

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

console.log('✓ legacy-rebuilder tests pass');
