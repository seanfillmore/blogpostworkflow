// tests/agents/ad-concepts-concepts.test.js
//
// The pure gates concepts.js still carries after the invented-concept stage was retired:
// competitor names, verbatim claim sourcing, and the variant gate.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as concepts from '../../agents/ad-concepts/concepts.js';
import { checkClaimsSourced, mentionsCompetitor, namedCompetitors, variantConflicts } from '../../agents/ad-concepts/concepts.js';

const sourceIndex = { pdp: 'One fat: organic virgin coconut oil, cold-pressed and unrefined, turned into soap.' };

test('only the shared gates remain exported', () => {
  assert.deepEqual(Object.keys(concepts).sort(), ['checkClaimsSourced', 'describesScent', 'mentionsCompetitor', 'namedCompetitors', 'variantConflicts']);
});

test('checkClaimsSourced is directly usable', () => {
  assert.deepEqual(checkClaimsSourced([{ text: 'one fat', sourceId: 'pdp' }], sourceIndex), { ok: true, reasons: [] });
  const bad = checkClaimsSourced([{ text: 'made on the moon', sourceId: 'pdp' }], sourceIndex);
  assert.equal(bad.ok, false);
  assert.match(bad.reasons[0], /unsourced claim/);
});

test('mentionsCompetitor is case-sensitive and spares "native" as an ordinary or format word', () => {
  assert.equal(mentionsCompetitor('Better than Weleda', 'Weleda'), true);
  assert.equal(mentionsCompetitor('better than weleda', 'Weleda'), false);
  assert.equal(mentionsCompetitor('a native-screenshot', 'Native'), false);
  assert.equal(mentionsCompetitor('a Native feed post', 'Native'), false);
  assert.equal(mentionsCompetitor('A Native deodorant stick', 'Native'), true);
  assert.equal(mentionsCompetitor('anything', ''), false);
});

test('namedCompetitors lists every competitor the text names', () => {
  assert.deepEqual(namedCompetitors('Gentler than Native and Weleda.', ['Native', 'Weleda', 'Acme']), ['Native', 'Weleda']);
  assert.deepEqual(namedCompetitors('', ['Native']), []);
});

const SIBS = ['calming-lavender', 'refreshing-lemongrass', 'pure-unscented'];

test('variantConflicts: a sibling scent fails, our own scent passes', () => {
  const r = variantConflicts('Tasting notes: lavender.', { variant: 'nourishing-tea-tree', siblingVariants: SIBS });
  assert.equal(r.length, 1);
  assert.match(r[0], /variant conflict: names "lavender" \(a different variant\)/);
  assert.deepEqual(variantConflicts('Tasting notes: tea tree.', { variant: 'nourishing-tea-tree', siblingVariants: SIBS }), []);
  assert.match(variantConflicts('A bright LEMONGRASS morning', { variant: 'nourishing-tea-tree', siblingVariants: SIBS }).join(' '), /"lemongrass"/);
  assert.match(variantConflicts('Totally unscented.', { variant: 'nourishing-tea-tree', siblingVariants: SIBS }).join(' '), /"unscented"/);
  assert.deepEqual(variantConflicts('lavenders', { variant: 'nourishing-tea-tree', siblingVariants: SIBS }), [], 'word boundary');
});

test('variantConflicts: "Nothing added." fails for a scented variant, passes for an unscented one', () => {
  assert.equal(variantConflicts('Nothing added.', { variant: 'nourishing-tea-tree', siblingVariants: SIBS }).length, 1);
  assert.deepEqual(variantConflicts('Nothing added.', { variant: 'pure-unscented', siblingVariants: ['calming-lavender', 'refreshing-lemongrass', 'nourishing-tea-tree'] }), []);
});

test('variantConflicts: a sibling term inside our own scent term is never flagged', () => {
  assert.deepEqual(variantConflicts('Pure lavender calm', { variant: 'deep-lavender', siblingVariants: ['calming-lavender'] }), []);
});

test('variantConflicts: no variant, no conflicts', () => {
  assert.deepEqual(variantConflicts('Tasting notes: lavender. Nothing added.', { variant: null, siblingVariants: SIBS }), []);
  assert.deepEqual(variantConflicts('Tasting notes: lavender.', { variant: 'nourishing-tea-tree' }), []);
});
