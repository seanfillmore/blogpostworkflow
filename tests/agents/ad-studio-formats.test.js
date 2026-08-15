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
  assert.equal(typeof f.productProminent, 'boolean', `${f.key} must declare whether its product label is legible`);
  assert.ok(Array.isArray(f.zones) && f.zones.length > 0, `${f.key} needs zones`);
  assert.ok(f.zones.includes('headline'), `${f.key} must have a headline zone`);
  assert.ok(f.layoutBrief.length > 100, `${f.key} needs a real layout brief`);
  assert.ok(!/#C1DF6D/i.test(f.layoutBrief), `${f.key} must not use the retired green`);

  // The plate is the artifact that ships, so its brief is as mandatory as the layout's.
  // A format with no plateBrief used to fall back to layoutBrief and render the finished
  // ad's props onto the base — see formats.js's note on the 2026-08-15 incident.
  assert.ok(f.plateBrief && f.plateBrief.length > 100, `${f.key} needs a real plate brief`);
  assert.notEqual(f.plateBrief, f.layoutBrief, `${f.key}'s plate brief must not just be the layout brief`);
  assert.ok(!/#C1DF6D/i.test(f.plateBrief), `${f.key} must not use the retired green`);

  // Every format must DECIDE its setting. No default: 'studio' would silently strip the
  // setting off a format that wants one, and 'scene' would silently license props on one
  // that does not.
  assert.ok(['studio', 'scene'].includes(f.plateSetting), `${f.key} needs a plateSetting`);

  // A plateBrief may never name FINISHED-AD FURNITURE — the columns, rules, pills, bars,
  // badges, icons and checklists the operator sets by hand — in either setting.
  assert.ok(
    !/\b(column|badge|headline|icon|checklist|pictogram|cut-?out)\b/i.test(f.plateBrief),
    `${f.key}'s plate brief names finished-ad furniture`
  );

  // Nor INGREDIENT OR BOTANICAL STYLING, in either setting. That is the specific thing
  // that went wrong on 2026-08-15 — a coconut, a wood slice and greenery, all of which
  // came from ingredient-callout's layoutBrief asking for ingredient cut-outs. A scene is
  // a PLACE, not ingredient styling: `problem-aware` may have a bathroom counter and still
  // may not have a coconut on it.
  assert.ok(
    !/\b(ingredients?|coconuts?|fruits?|nuts?|seeds?|sprigs?|greenery|botanicals?|wood slices?)\b/i.test(f.plateBrief),
    `${f.key}'s plate brief names ingredient or botanical styling`
  );

  // A STUDIO plate must positively say nothing else is in frame — that instruction cannot
  // be left to render.js's negations alone, which is exactly what lost last time. A scene
  // plate says the opposite by design and is exempt.
  if (f.plateSetting === 'studio') {
    assert.ok(/nothing else appears/i.test(f.plateBrief), `${f.key}'s studio plate must exclude everything else`);
  }

  // ...but it must NOT state a unit count. That is per-product (product.unitCount), not
  // per-format: baking "a single unit" in here would reject every correct render of the
  // foam soap bundle, the lip balm four-pack and both starter sets.
  assert.ok(
    !/\b(single|one|two|three|four)\s+(unit|bottle|tube|jar|item|piece)/i.test(f.plateBrief),
    `${f.key}'s plate brief must not fix a unit count — that is product.unitCount's job`
  );
}

// Which formats keep a setting, and why: these two are the ones whose whole value IS the
// context — an everyday moment and an editorial still life. The other four are studio
// shots as finished ads too, so a setting there would be invention, not fidelity.
assert.deepEqual(
  FORMATS.filter(f => f.plateSetting === 'scene').map(f => f.key).sort(),
  ['problem-aware', 'top-x-review'],
);
// A scene plate still has to leave clear space for the type the operator sets by hand —
// otherwise "keep the scene" quietly becomes "there is nowhere to put the headline".
for (const key of ['problem-aware', 'top-x-review']) {
  assert.ok(/clear|quiet|negative space/i.test(formatByKey(key).plateBrief),
    `${key}'s scene must still leave room for copy`);
}

// The two formats whose layouts pair pictures with words drive the pairing check.
assert.equal(formatByKey('ingredient-callout').pairsImagesWithLabels, true);
assert.equal(formatByKey('us-vs-them').pairsImagesWithLabels, true);
assert.equal(formatByKey('manifesto').pairsImagesWithLabels, false);

// productProminent is a LEGIBILITY declaration: it decides whether the verify gate may
// demand the product's printed label back out of the render. The two layouts that put
// the product on screen deliberately tiny must stay false — "small and understated at
// the bottom center" (manifesto) and "present but not dominant" (problem-aware) cannot
// carry a readable 6pt volume marking, and requiring one fails every attempt and burns
// the retries. Flipping either to true is a ~$7 mistake per run, so pin all six.
assert.equal(formatByKey('manifesto').productProminent, false);
assert.equal(formatByKey('problem-aware').productProminent, false);
assert.equal(formatByKey('us-vs-them').productProminent, true);
assert.equal(formatByKey('ingredient-callout').productProminent, true);
assert.equal(formatByKey('top-x-review').productProminent, true);
assert.equal(formatByKey('offer-focused').productProminent, true);

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
