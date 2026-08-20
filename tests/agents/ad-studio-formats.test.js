import { strict as assert } from 'node:assert';
import { FORMATS, selectFormats, formatByKey, visibleFormats, formatForVariation } from '../../agents/ad-studio/formats.js';

// Fourteen formats, each with the fields the downstream stages read. Six v1, three added
// 2026-08-15 from reference creatives that are actually running (Bonafide, Magic Spoon /
// MUD\WTR, a kids' supplement before/after), `giveaway-entry` added 2026-08-18,
// `fact-hook` / `spec-panel` the same day to close the unaware / most-aware gap, and
// `in-use-handwash` / `shower-shelf` on 2026-08-19 — the first plates with people in them.
assert.equal(FORMATS.length, 14);
const keys = FORMATS.map(f => f.key);
assert.deepEqual(
  [...keys].sort(),
  [
    'fact-hook', 'giveaway-entry', 'in-use-handwash', 'ingredient-callout', 'manifesto',
    'offer-focused', 'problem-aware', 'shower-shelf', 'spec-panel', 'stat-stack',
    'state-contrast', 'testimonial', 'top-x-review', 'us-vs-them',
  ]
);
assert.equal(new Set(keys).size, 14, 'format keys must be unique');

// ── giveaway-entry is INVISIBLE unless a giveaway is actually running ────────────────
//
// It is the one format whose copy cannot be written without a live Entry Period to cite:
// every factual line it asks for resolves against the `giveaway` source, which
// lib/giveaway-claim-source.js only produces while entries are open. Offering it outside
// that window would spend an Opus copy call on an ad the claim gate is certain to reject.
{
  const g = formatByKey('giveaway-entry');
  assert.equal(g.requiresGiveaway, true, 'the giveaway format must declare its dependency');
  assert.deepEqual(
    visibleFormats().map(f => f.key).filter(k => k === 'giveaway-entry'),
    [],
    'with no giveaway live the format is not in the rotation at all'
  );
  assert.ok(
    visibleFormats({ giveawayLive: true }).map(f => f.key).includes('giveaway-entry'),
    'with a giveaway live it joins the rotation'
  );
  // Every OTHER format is unconditional — requiresGiveaway must not spread by accident.
  assert.deepEqual(
    FORMATS.filter(f => f.requiresGiveaway).map(f => f.key),
    ['giveaway-entry'],
  );
  // 11 since 2026-08-18 (fact-hook, spec-panel). The point of this assertion is unchanged:
  // requiresGiveaway must gate exactly one format, so the rotation with no giveaway live is
  // every format except giveaway-entry.
  assert.equal(visibleFormats().length, FORMATS.length - 1, 'the no-giveaway rotation is everything but the giveaway format');
  assert.equal(visibleFormats().length, 13, 'and that is 13 formats today');

  // Declaration order is what makes it the PROPOSED product-aware format while live, and
  // leaves offer-focused proposed otherwise (formatsForAngle takes the first match).
  assert.ok(
    keys.indexOf('giveaway-entry') < keys.indexOf('offer-focused'),
    'the giveaway format must precede offer-focused, or it can never be proposed'
  );

  // Identical zone shape to offer-focused, ON PURPOSE: lib/ad-brief.js's selectableFormats
  // only allows an operator to switch a brief between formats of the same zone shape, so
  // this is what makes "entry ad <-> sales ad" a one-click switch instead of a regenerate.
  assert.deepEqual(g.zones, formatByKey('offer-focused').zones);

  // The ask is an ENTRY. A giveaway ad that quotes a price is the failure this format
  // exists to prevent, and "no purchase necessary" is a legal requirement, not styling.
  assert.match(g.layoutBrief, /asks for an ENTRY, never a purchase/);
  assert.match(g.layoutBrief, /NO PURCHASE NECESSARY/);
  assert.match(g.layoutBrief, /no price/i);
}

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
  // 'unaware' and 'most-aware' joined 2026-08-18 with fact-hook and spec-panel. This list
  // is the whitelist AND the contract with lib/ad-brief-plan.js's join — a format tagged
  // with anything outside it is unreachable from any angle, silently.
  assert.ok(
    ['unaware', 'problem', 'solution', 'product', 'most-aware'].includes(f.awareness),
    `${f.key} needs an awareness level`,
  );
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

  // The same rule, caught by a DIFFERENT phrasing. "The product appears exactly once" states
  // a unit count without using any noun the regex above looks for — it was written into
  // manifesto's plate brief on 2026-08-18 and removed before it shipped. Four RSC products
  // are genuinely multi-unit (foam soap bundle: three bottles; lip balm: four tubes), so a
  // count baked into a FORMAT rejects every correct render of them.
  assert.ok(
    !/\b(appears?|shown|rendered|pictured)\s+(exactly\s+)?(once|twice|a single time)\b/i.test(f.plateBrief),
    `${f.key}'s plate brief states a unit count in prose — unit count belongs to product.unitCount`
  );
}

// Which formats keep a setting, and why: each one's whole value IS the context — an
// everyday moment, an editorial still life, and (2026-08-19) two in-use scenes where the
// product is being handled or is sitting wet where it is actually used. Every other format
// is a studio shot as a finished ad too, so a setting there would be invention, not
// fidelity. Pinned as an exact set so a scene is never added by accident: `plateSetting`
// has no default precisely because 'scene' quietly licenses props.
assert.deepEqual(
  FORMATS.filter(f => f.plateSetting === 'scene').map(f => f.key).sort(),
  ['in-use-handwash', 'problem-aware', 'shower-shelf', 'top-x-review'],
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

assert.equal(formatByKey('giveaway-entry').productProminent, true);

// fact-hook renders the product "small and understated ... like a footnote", so its label is
// deliberately NOT legible and the gate must not demand it back. spec-panel is the inverse:
// a transparency pitch whose own label cannot be read defeats itself.
assert.equal(formatByKey('fact-hook').productProminent, false);
assert.equal(formatByKey('spec-panel').productProminent, true);

// selectFormats. "Full rotation" means the VISIBLE rotation — a giveaway format is opt-in
// by name and must never arrive by default, because the default is what you get by accident.
assert.equal(selectFormats().length, 13, 'no args returns the full visible rotation');
assert.equal(selectFormats([]).length, 13, 'empty array returns the full visible rotation');
assert.ok(!selectFormats().some(f => f.key === 'giveaway-entry'), 'the default rotation excludes it');
assert.deepEqual(
  selectFormats(['giveaway-entry']).map(f => f.key),
  ['giveaway-entry'],
  'but naming it explicitly still resolves it — that is an operator decision, and the gate judges it'
);
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

// ── plateVariants (added 2026-08-18) ────────────────────────────────────────────────
//
// EVERY VARIANT IS A PLATE BRIEF AND IS HELD TO EVERY PLATE-BRIEF RULE. The loop above
// validates `f.plateBrief` only; a variant is rendered in exactly the same way and reaches
// exactly the same paid image call, so a variant naming ad furniture or a unit count would
// be the 2026-08-15 incident again through a door the checks do not watch.
for (const f of FORMATS) {
  for (const v of f.plateVariants || []) {
    const where = `${f.key}/${v.key}`;
    assert.ok(v.plateBrief.length > 100, `${where} needs a real plate brief`);
    assert.notEqual(v.plateBrief, f.layoutBrief, `${where}'s plate brief must not be the layout brief`);
    assert.ok(!/#C1DF6D/i.test(v.plateBrief), `${where} must not use the retired green`);
    assert.ok(
      !/\b(column|badge|headline|icon|checklist|pictogram|cut-?out)\b/i.test(v.plateBrief),
      `${where} names finished-ad furniture`
    );
    assert.ok(
      !/\b(ingredients?|coconuts?|fruits?|nuts?|seeds?|sprigs?|greenery|botanicals?|wood slices?)\b/i.test(v.plateBrief),
      `${where} names ingredient or botanical styling`
    );
    assert.ok(
      !/\b(single|one|two|three|four)\s+(unit|bottle|tube|jar|item|piece)/i.test(v.plateBrief),
      `${where} fixes a unit count — that is product.unitCount's job`
    );
    assert.ok(
      !/\b(appears?|shown|rendered|pictured)\s+(exactly\s+)?(once|twice|a single time)\b/i.test(v.plateBrief),
      `${where} states a unit count in prose`
    );
    if (f.plateSetting === 'studio') {
      assert.ok(/nothing else appears/i.test(v.plateBrief), `${where} studio variant must exclude everything else`);
    }
  }
}

// giveaway-entry carries the five launch treatments. They vary GROUND COLOUR and PRODUCT
// SCALE/POSITION — the two things `--variations` alone cannot change, because both are
// written into the brief. Every ground stays inside the brand palette: a giveaway ad is the
// one asset that reaches cold audiences, and an off-brand frame there is the worst place for
// one.
{
  const g = formatByKey('giveaway-entry');
  assert.equal(g.plateVariants.length, 5, 'five launch treatments');
  assert.deepEqual(
    g.plateVariants.map(v => v.key),
    ['sand-hero', 'sand-large-centered', 'green-small', 'charcoal-contrast', 'grey-flatlay'],
  );
  const palette = ['#EDE5D8', '#000000', '#AEDEAC', '#EDEDED'];
  for (const v of g.plateVariants) {
    const hexes = v.plateBrief.match(/#[0-9A-F]{6}/gi) || [];
    assert.ok(hexes.length, `${v.key} must name its ground colour explicitly`);
    for (const h of hexes) {
      assert.ok(palette.includes(h.toUpperCase()), `${v.key} uses ${h}, which is outside the brand palette`);
    }
  }
  // The first treatment reproduces the original plate, so variation 1 of a 5-variation run
  // is the frame the format has always produced and the set stays comparable to what shipped.
  assert.equal(g.plateVariants[0].plateBrief, g.plateBrief, 'variant 1 must equal the base brief');
}

// formatForVariation resolves the treatment at the boundary — so no downstream signature
// changes, and no call site can forget the index and silently render treatment one N times.
{
  const g = formatByKey('giveaway-entry');
  assert.equal(formatForVariation(g, 1).plateVariantKey, 'sand-hero');
  assert.equal(formatForVariation(g, 4).plateVariantKey, 'charcoal-contrast');
  // CYCLES rather than clamps: more variations than treatments wraps, which is the useful
  // reading of --variations 7 against five treatments.
  assert.equal(formatForVariation(g, 6).plateVariantKey, 'sand-hero');
  assert.equal(formatForVariation(g, 6).plateBrief, formatForVariation(g, 1).plateBrief);
  // Defensive: a missing or nonsense index must not throw mid-run.
  assert.equal(formatForVariation(g).plateVariantKey, 'sand-hero');
  assert.equal(formatForVariation(g, 0).plateVariantKey, 'sand-hero');

  // A format with no plateVariants is returned UNCHANGED — identity, not a copy — so every
  // format that has not opted in behaves exactly as it did before this existed.
  const m = formatByKey('manifesto');
  assert.equal(formatForVariation(m, 3), m);
}

// ── the in-use formats carry people, by operator override (2026-08-19) ──────────────
//
// The "No people and no hands" line in problem-aware's plateBrief is overridden for these
// two and for these two only. What must NOT be overridden is the compliance half, which is
// about the medium rather than the composition: Meta restricts before/after and skin-
// condition depiction in health and beauty, and these are the first formats where a human
// body is in frame at all, so they are the formats most able to break it.
{
  const handwash = formatByKey('in-use-handwash');
  const shower = formatByKey('shower-shelf');

  assert.match(handwash.plateBrief, /Ordinary healthy skin only/, 'no skin condition may be depicted');
  assert.match(handwash.layoutBrief, /no depiction of a skin condition/i);
  assert.match(handwash.layoutBrief, /No before\/after split/i);
  assert.match(shower.layoutBrief, /no depiction of a skin condition/i);

  // ANATOMY IS UNGATED. Nothing in verify.js looks at hands, so the brief reduces the odds
  // instead: cropped at the wrist, partly covered, no face or body. If these constraints are
  // relaxed, the only remaining check on a malformed hand is a person looking at the frame.
  assert.match(handwash.plateBrief, /cropped at the wrist/);
  assert.match(handwash.plateBrief, /partly covered by lather/);
  assert.match(handwash.plateBrief, /No face, no arms, no body/);

  // The shower scene has no people at all — it is the lower-risk half of the pair, and that
  // is a property worth pinning so it is not quietly widened later.
  assert.match(shower.plateBrief, /No people, no hands/);

  // Both are scenes with the product NOT label-legible: hands and water obscure it, so the
  // gate must not demand the brand mark be read back at ~$0.13 a retry.
  for (const f of [handwash, shower]) {
    assert.equal(f.plateSetting, 'scene');
    assert.equal(f.productProminent, false);
  }
}

// ── product FORM: the bare bar is not the package (2026-08-20) ──────────────────────
//
// Operator caught this on a live plate: a wrapped bar being lathered, and a wrapped bar
// sitting wet on a soap dish, are both physically incoherent — you unwrap soap before you
// use it. The plates showed the PACKAGE in use rather than the soap.
//
// It is not a render glitch, it is structural: every reference photograph is the wrapped
// product and productDescription describes the wrapper and its printed label, so the
// fidelity gate would REJECT a correctly-unwrapped bar as "not our product" while passing
// the nonsense one. `productForm` is the seam — a property of the DEPICTION, not of the
// product, which is why it lives on the format.
{
  const inUse = FORMATS.filter(f => f.productForm === 'unwrapped').map(f => f.key).sort();
  assert.deepEqual(inUse, ['in-use-handwash', 'shower-shelf'],
    'exactly the in-use scenes depict the bare bar');

  // Everything else is the product AS SOLD, which is what the references show. Absent means
  // wrapped — the default has to be the form the whole pipeline was built around.
  for (const f of FORMATS) {
    if (inUse.includes(f.key)) continue;
    assert.equal(f.productForm, undefined, `${f.key} must not declare a form — wrapped is the default`);
  }

  // The plate briefs must say BARE, or the model renders the wrapper it has seen in every
  // reference photograph it was ever given for this product.
  for (const key of inUse) {
    assert.match(formatByKey(key).plateBrief, /bare unwrapped bar/i,
      `${key}'s plate brief must ask for the bare bar explicitly`);
  }
}
