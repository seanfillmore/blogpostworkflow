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

// Demand Gen text fields are single-line. A zone value may carry a newline for the
// two-line IMAGE headline (that's legitimate and must not change) — the text-field
// projection must collapse it to one line, not pass it straight through. Live run
// wrote "Six Ingredients.\nNothing To Hide." straight into a headline field.
{
  const multiline = buildDemandGenAssets({ headline: 'Six Ingredients.\nNothing To Hide.' });
  assert.deepEqual(multiline.headlines, ['Six Ingredients. Nothing To Hide.'], 'newline collapses to a single space');
}

// No \n, \r or \t survives into any emitted field, across all three buckets.
{
  const messy = buildDemandGenAssets({
    a: 'Short\nHeadline',
    b: 'A'.repeat(30) + '\r\n' + 'B'.repeat(30), // lands in longHeadlines once collapsed
    c: 'C'.repeat(30) + '\t\t' + 'D'.repeat(30),
  });
  const all = [...messy.headlines, ...messy.longHeadlines, ...messy.descriptions];
  assert.ok(all.length > 0, 'sanity: something was emitted');
  for (const s of all) {
    assert.doesNotMatch(s, /[\n\r\t]/, `emitted asset must be single-line: ${JSON.stringify(s)}`);
  }
}

// Length checks run against the NORMALIZED string. A headline whose raw length
// exceeds HEADLINE_MAX only because of a newline (1 char) must still be bucketed by
// its collapsed length once the newline becomes a space — collapsing never shortens
// length here (newline -> space is 1-for-1), so this pins that the check reads the
// same string that gets emitted, not the original.
{
  const raw = 'A'.repeat(39) + '\n' + 'B'; // 41 raw chars, but a \n -> ' ' collapse keeps it at 41 normalized too
  const short = 'A'.repeat(19) + '\n' + 'B'.repeat(19); // 39 raw chars including \n; normalized also 39
  const result = buildDemandGenAssets({ raw, short });
  // "short" (39 normalized chars) fits the 40-char headline field.
  assert.ok(result.headlines.includes('A'.repeat(19) + ' ' + 'B'.repeat(19)));
  // "raw" (41 normalized chars) does not fit headlines but does fit longHeadlines.
  assert.ok(!result.headlines.some(h => h.startsWith('A'.repeat(39))));
  assert.ok(result.longHeadlines.some(h => h.startsWith('A'.repeat(39))));
}

// Two inputs differing only by a line break de-duplicate to a single asset once
// normalized — otherwise the same copy with cosmetically different whitespace would
// ship as two near-identical Demand Gen assets.
{
  const collapsedDupes = buildDemandGenAssets({
    a: 'Only Six Ingredients',
    b: 'Only Six\nIngredients'.replace('\n', ' '), // same normalized value, different literal source
  });
  // Use a real \n on one side to match the addendum's exact scenario.
  const realDupes = buildDemandGenAssets({
    x: 'Clean Ingredients Only',
    y: 'Clean Ingredients\nOnly',
  });
  assert.equal(collapsedDupes.headlines.filter(h => h === 'Only Six Ingredients').length, 1);
  assert.deepEqual(realDupes.headlines, ['Clean Ingredients Only'], 'newline-only difference must de-duplicate to one asset');
}
