import { strict as assert } from 'node:assert';
import { FORMATS, selectFormats, formatByKey } from '../../agents/ad-studio/formats.js';

// Nine formats, each with the fields the downstream stages read. Six v1 plus three added
// 2026-08-15 from reference creatives that are actually running (Bonafide, Magic Spoon /
// MUD\WTR, a kids' supplement before/after).
assert.equal(FORMATS.length, 9);
const keys = FORMATS.map(f => f.key);
assert.deepEqual(
  [...keys].sort(),
  [
    'ingredient-callout', 'manifesto', 'offer-focused', 'problem-aware', 'stat-stack',
    'state-contrast', 'testimonial', 'top-x-review', 'us-vs-them',
  ]
);
assert.equal(new Set(keys).size, 9, 'format keys must be unique');

// A format is DATA — nothing downstream branches on a format key, and no zone name is
// hard-coded anywhere. These three were added without touching a line of logic, which is
// the property formats.js's header claims and the only thing that keeps it cheap to add
// the tenth.
for (const key of ['testimonial', 'stat-stack', 'state-contrast']) {
  const f = formatByKey(key);
  assert.ok(f, `${key} must resolve`);
  assert.deepEqual(selectFormats([key]).map(x => x.key), [key], `${key} must be selectable`);
}

// state-contrast is a COMPLIANCE-shaped format. Meta prohibits before-and-after imagery in
// health and beauty — problem-aware's own layoutBrief already encodes that rule for this
// catalogue, and the reference ad only gets away with the shape because its two states are
// cartoons rather than photographs of a body. So the contrast is illustrated and about the
// EXPERIENCE, and the brief has to say so in terms nobody can misread.
{
  const sc = formatByKey('state-contrast').layoutBrief;
  assert.ok(/NEVER a photograph of skin, a body, a face/i.test(sc), 'must forbid photographic before/after');
  assert.ok(/depiction of a skin condition/i.test(sc), 'must forbid depicting a condition');
  assert.ok(/prohibited in health and beauty/i.test(sc), 'must say why, so nobody relaxes it');
}

// A testimonial quote is the one zone that CANNOT be written — it has to be a real review.
// claims.js already owns enforcement (sourceId `reviews`); this just makes sure the copy
// stage is told, because an invented quote is the worst thing this pipeline could emit.
assert.ok(
  /MUST BE A REAL CUSTOMER REVIEW/i.test(formatByKey('testimonial').layoutBrief),
  'the testimonial brief must demand a verbatim review quote',
);

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
assert.equal(selectFormats().length, 9, 'no args returns the full rotation');
assert.equal(selectFormats([]).length, 9, 'empty array returns the full rotation');
assert.deepEqual(selectFormats(['manifesto']).map(f => f.key), ['manifesto']);
assert.deepEqual(
  selectFormats(['manifesto', 'us-vs-them']).map(f => f.key),
  ['manifesto', 'us-vs-them'],
  'order follows the requested keys'
);
assert.throws(() => selectFormats(['nope']), /unknown format: nope/i);

assert.equal(formatByKey('nope'), undefined);

// ── manifesto was rebuilt because it was not an effective ad (2026-08-16) ────────────
//
// Sean, on the first live comp: "way too cluttered and is not an effective ad." The
// layoutBrief was the cause — a small label LEFT paired with a large phrase RIGHT, four
// times, plus a headline, plus a subhead, plus a boxed closer. Seven competing text
// blocks, about a dozen lines, one red at one weight; the left labels (WATER / FILM /
// ABSORB / SIX) carried no meaning alone, and the product ended up physically overlapped
// by the middle rows.
{
  const m = formatByKey('manifesto');

  // Three text blocks, not seven. The subhead and the boxed closer are gone.
  assert.deepEqual(m.zones, ['headline', 'rows', 'bottomBar']);
  assert.ok(!m.zones.includes('subhead'), 'the subhead was a competing block');
  assert.ok(!m.zones.includes('closer'), 'the boxed closer was a competing block');

  // The real constraint was never the row COUNT, it was words per row — "MOSTLY WATER,
  // MINERAL OIL, AND A THICKENER" wrapped to three lines on its own.
  assert.equal(m.zoneCapacity.rows, 3);
  assert.ok(/no more than five or six words/i.test(m.layoutBrief), 'the brief must cap phrase length');
  assert.ok(/fits on ONE line/i.test(m.layoutBrief));

  // No label column — that is what made it read as a spec sheet.
  assert.ok(/no label or category word beside them/i.test(m.layoutBrief));

  // The product must be clear of the type, which it was not — and clearance is achieved
  // by MOVING it laterally, not by asking. Decluttering alone left it centred and the comp
  // put the bottle straight through "A film that sits on top"; lateral placement is the
  // only positional instruction this model reliably honours.
  assert.ok(/completely clear of the type/i.test(m.layoutBrief));
  assert.ok(/BOTTOM RIGHT/.test(m.layoutBrief), 'the product must be moved out of the text column');
  assert.ok(/no line, rule or word crosses it/i.test(m.layoutBrief));
  assert.ok(/BOTTOM RIGHT/.test(m.plateBrief), 'and the plate must put it there to begin with');

  // Enlarging the product on the plate must NOT flip productProminent — that flag is
  // permission for the gate to demand the label back, and turning it on buys retries.
  assert.equal(m.productProminent, false);
}
