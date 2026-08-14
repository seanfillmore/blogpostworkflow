import { strict as assert } from 'node:assert';
import { FORMATS, selectFormats, formatByKey } from '../../agents/ad-studio/formats.js';

// Six v1 formats, each with the fields the downstream stages read.
assert.equal(FORMATS.length, 6);
const keys = FORMATS.map(f => f.key);
assert.deepEqual(
  [...keys].sort(),
  ['ingredient-callout', 'manifesto', 'offer-focused', 'problem-aware', 'top-x-review', 'us-vs-them']
);
assert.equal(new Set(keys).size, 6, 'format keys must be unique');

for (const f of FORMATS) {
  assert.ok(f.name, `${f.key} needs a name`);
  assert.ok(['problem', 'solution', 'product'].includes(f.awareness), `${f.key} needs an awareness level`);
  assert.equal(typeof f.pairsImagesWithLabels, 'boolean', `${f.key} must declare image/label pairing`);
  assert.ok(Array.isArray(f.zones) && f.zones.length > 0, `${f.key} needs zones`);
  assert.ok(f.zones.includes('headline'), `${f.key} must have a headline zone`);
  assert.ok(f.layoutBrief.length > 100, `${f.key} needs a real layout brief`);
  assert.ok(!/#C1DF6D/i.test(f.layoutBrief), `${f.key} must not use the retired green`);
}

// The two formats whose layouts pair pictures with words drive the pairing check.
assert.equal(formatByKey('ingredient-callout').pairsImagesWithLabels, true);
assert.equal(formatByKey('us-vs-them').pairsImagesWithLabels, true);
assert.equal(formatByKey('manifesto').pairsImagesWithLabels, false);

// selectFormats
assert.equal(selectFormats().length, 6, 'no args returns the full rotation');
assert.equal(selectFormats([]).length, 6, 'empty array returns the full rotation');
assert.deepEqual(selectFormats(['manifesto']).map(f => f.key), ['manifesto']);
assert.deepEqual(
  selectFormats(['manifesto', 'us-vs-them']).map(f => f.key),
  ['manifesto', 'us-vs-them'],
  'order follows the requested keys'
);
assert.throws(() => selectFormats(['nope']), /unknown format: nope/i);

assert.equal(formatByKey('nope'), undefined);
