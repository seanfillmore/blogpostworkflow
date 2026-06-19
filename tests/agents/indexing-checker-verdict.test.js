import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict } from '../../agents/indexing-checker/index.js';

// GSC's `not_found` reflects its last crawl, which can be weeks stale. The
// verdict must reconcile against the live HTTP status before escalating.
test('not_found + live 200 → auto re-index nudge, not a manual critical', () => {
  const v = computeVerdict('not_found', 98, 200);
  assert.equal(v.severity, 'warning');
  assert.equal(v.action, 'submit_indexing_api'); // Tier 2 auto, no manual flag
});

test('not_found + live 301/302 → nothing to fix (intentional redirect)', () => {
  for (const code of [301, 302, 308]) {
    const v = computeVerdict('not_found', 30, code);
    assert.equal(v.severity, 'ok', `live ${code}`);
    assert.equal(v.action, null, `live ${code}`);
  }
});

test('not_found + live 404 → genuine critical', () => {
  const v = computeVerdict('not_found', 30, 404);
  assert.equal(v.severity, 'critical');
  assert.equal(v.action, 'fix_page_fetch');
});

test('not_found + unreachable (0) → genuine critical (fail closed)', () => {
  const v = computeVerdict('not_found', 30, 0);
  assert.equal(v.severity, 'critical');
  assert.equal(v.action, 'fix_page_fetch');
});

test('not_found with no live status (null) → genuine critical (fail closed)', () => {
  const v = computeVerdict('not_found', 30, null);
  assert.equal(v.severity, 'critical');
  assert.equal(v.action, 'fix_page_fetch');
});

test('unrelated states are unaffected by the live-status arg', () => {
  assert.equal(computeVerdict('indexed', 10, 200).severity, 'ok');
  assert.equal(computeVerdict('excluded_noindex', 10, 200).action, 'fix_noindex_tag');
});
