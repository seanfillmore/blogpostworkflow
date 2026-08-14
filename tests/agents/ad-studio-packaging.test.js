import { strict as assert } from 'node:assert';
import {
  PLATFORM_TARGETS,
  variationDir,
  artifactName,
  buildDemandGenAssets,
} from '../../agents/ad-studio/packaging.js';

// Meta bakes text; Demand Gen takes a text-free plate.
const meta = PLATFORM_TARGETS.filter(t => t.platform === 'meta');
const dg = PLATFORM_TARGETS.filter(t => t.platform === 'demand-gen');
assert.deepEqual(meta.map(t => t.ratio).sort(), ['1:1', '4:5', '9:16']);
assert.deepEqual(dg.map(t => t.ratio).sort(), ['1.91:1', '1:1', '4:5']);
assert.ok(meta.every(t => t.mode === 'finished'), 'meta artifacts are baked');
assert.ok(dg.every(t => t.mode === 'plate'), 'demand gen artifacts are text-free plates');

// Paths and names.
assert.equal(
  variationDir('/root', 'run-1', 'six-ingredients', 2),
  '/root/data/creatives/ad-studio/run-1/six-ingredients/v2'
);
assert.equal(artifactName('meta', '4:5', 'finished'), 'finished-4x5.png');
assert.equal(artifactName('demand-gen', '1.91:1', 'plate'), 'plate-1_91x1.png');
assert.equal(artifactName('meta', '1:1', 'finished'), 'finished-1x1.png');

// Demand Gen text assets, bucketed by Google's field limits.
const assets = buildDemandGenAssets({
  headline: 'SIX INGREDIENTS.',
  subhead: "THAT'S THE WHOLE LIST.",
  listItems: ['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL'],
  bottomBar: 'NO MINERAL OIL, NO PETROLATUM, NO DIMETHICONE, AND ABSOLUTELY NO SYNTHETIC FRAGRANCE EITHER',
});
assert.ok(assets.headlines.every(h => h.length <= 40), 'headlines fit the 40-char field');
assert.ok(assets.longHeadlines.every(h => h.length <= 90), 'long headlines fit the 90-char field');
assert.ok(assets.descriptions.every(d => d.length <= 90), 'descriptions fit the 90-char field');
assert.ok(assets.headlines.includes('SIX INGREDIENTS.'));
assert.ok(assets.headlines.includes('ORGANIC JOJOBA'));

// Anything too long for every field is reported, never silently dropped.
assert.equal(assets.dropped.length, 1);
assert.ok(assets.dropped[0].text.startsWith('NO MINERAL OIL'));
assert.equal(assets.dropped[0].limit, 90);

// De-duplicated, and empties ignored.
const dupes = buildDemandGenAssets({ a: 'SAME', b: 'SAME', c: '', d: '   ' });
assert.deepEqual(dupes.headlines, ['SAME']);
assert.deepEqual(buildDemandGenAssets({}).headlines, []);
