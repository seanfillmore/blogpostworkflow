import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, overrideProblems, linkedRule } from '../../scripts/sync-shopping-title-overrides.mjs';

test('the configured overrides pass every check and none says Fresh Mint for another flavor', () => {
  const c = loadConfig();
  assert.deepEqual(overrideProblems(c), []);
  for (const o of c.overrides) {
    const flavor = o.title.match(/Fresh Mint|All Natural|Cinnamon Spice/)?.[0];
    assert.ok(flavor, `${o.offerId} names its flavor`);
    assert.equal((o.title.match(/Fresh Mint|All Natural|Cinnamon Spice/g) || []).length, 1, `${o.offerId} names exactly one flavor`);
  }
});

test('overrideProblems refuses dashes, long titles, claims and duplicates', () => {
  const p = overrideProblems({ overrides: [
    { offerId: 'a', title: 'Toothpaste – whitening' },
    { offerId: 'a', title: 'x'.repeat(151) },
    { offerId: 'b c', title: 'Cures gum disease toothpaste' },
  ] }).join('\n');
  assert.match(p, /dash/); assert.match(p, /forbidden/); assert.match(p, /duplicate/); assert.match(p, /length 151/); assert.match(p, /bad offerId/); assert.match(p, /claim gate/);
});

test('linkedRule puts the supplemental first, is idempotent, and unlinks back to self', () => {
  const S = 'accounts/1/dataSources/9';
  const once = linkedRule([{ self: true }], S);
  assert.deepEqual(once, [{ supplementalDataSourceName: S }, { self: true }]);
  assert.deepEqual(linkedRule(once, S), once);
  assert.deepEqual(linkedRule(once, S, { unlink: true }), [{ self: true }]);
  assert.deepEqual(linkedRule([], S, { unlink: true }), [{ self: true }]);
});
