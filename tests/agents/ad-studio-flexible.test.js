// tests/agents/ad-studio-flexible.test.js
//
// The 3-2-2 flexible ad. What is under test is mostly REFUSAL: the mode's value is that it
// produces the one structure whose arithmetic works at $30/day, so every way of ending up
// with a different structure has to be a loud error rather than a quiet manifest.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertFlexibleArgs, parseFlexibleCopyResponse, flexibleZones, renderFlexibleManifest,
  buildFlexibleCopyPrompt, PLATE_COUNT, PRIMARY_TEXT_COUNT, HEADLINE_COUNT,
  HEADLINE_MAX_CHARS, PRIMARY_TEXT_MAX_CHARS,
} from '../../agents/ad-studio/flexible.js';
import { parseArgs, collectFlexiblePlates, FLEXIBLE_DEFAULT_TARGET } from '../../agents/ad-studio/index.js';
import { assertNoHealthClaims } from '../../agents/ad-studio/health-claims.js';

const META45 = { platform: 'meta', ratio: '4:5', mode: 'plate', wantsComp: true };
const OK_ARGS = { formats: ['a', 'b', 'c'], targets: [META45], variations: 1 };

// ── assertFlexibleArgs ──────────────────────────────────────────────────────
assert.doesNotThrow(() => assertFlexibleArgs(OK_ARGS), 'the canonical shape passes');

assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, formats: ['a', 'b'] }),
  /exactly 3 --formats \(got 2/,
  'two plates is not a 3-2-2'
);

// The specific mistake this guards: three variations of ONE format looks like three
// creatives and is three ads chasing the same buyer.
assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, formats: ['a'], variations: 3 }),
  /exactly 3 --formats/,
  'one format with three variations is rejected on the format count first'
);

assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, variations: 2 }),
  /fixes --variations at 1 \(got 2/,
  'extra variations would multiply the ads the mode exists to consolidate'
);

// Mixed ratios are the subtle one — the run succeeds, the plates look fine, and the ad
// quietly asks Meta to decide creative and shape at once.
assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, targets: [META45, { platform: 'meta', ratio: '1:1' }] }),
  /exactly ONE target \(got 2/,
  'two ratios is two questions'
);

assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, targets: [{ platform: 'demand-gen', ratio: '1:1' }] }),
  /Demand Gen has no flexible-ad equivalent/,
  'flexible ads are a Meta format'
);

// ── parseArgs wiring ────────────────────────────────────────────────────────
{
  const args = parseArgs(['--product', 'coconut-lotion', '--flexible', '--formats', 'us-vs-them,manifesto,testimonial']);
  assert.equal(args.flexible, true);
  assert.equal(args.targets.length, 1, 'flexible defaults to a single placement, not the usual three');
  assert.equal(`${args.targets[0].platform}=${args.targets[0].ratio}`, FLEXIBLE_DEFAULT_TARGET);
  assert.equal(args.variations, 1);
}

// A non-flexible run must be completely unaffected — same three Meta placements as before.
{
  const args = parseArgs(['--product', 'coconut-lotion', '--formats', 'us-vs-them']);
  assert.equal(args.flexible, false);
  assert.equal(args.targets.length, 3, 'the ordinary default is untouched');
}

// An explicit --targets still wins over the flexible default, and is still validated.
{
  const args = parseArgs(['--product', 'p', '--flexible', '--formats', 'us-vs-them,manifesto,testimonial', '--targets', 'meta=9:16']);
  assert.equal(args.targets[0].ratio, '9:16');
}

assert.throws(
  () => parseArgs(['--product', 'p', '--flexible', '--formats', 'us-vs-them,manifesto,testimonial', '--targets', 'meta']),
  /exactly ONE target \(got 3/,
  '--targets meta expands to three ratios and must be caught'
);

assert.throws(
  () => parseArgs(['--brief', 'coconut-lotion-1', '--flexible']),
  /mutually exclusive/,
  'brief mode carries one approved concept; say so by name rather than complaining about --formats'
);

// ── parseFlexibleCopyResponse ───────────────────────────────────────────────
const GOOD = JSON.stringify({
  primaryTexts: ['You have tried every bottle on the shelf.', 'Six ingredients. That is the whole list.'],
  headlines: ['Still dry by lunchtime?', 'Six ingredients, nothing else'],
  claims: [{ zone: 'headline2', text: 'Six ingredients', factual: true, sourceId: 'catalog', evidence: '6 clean ingredients' }],
});

{
  const out = parseFlexibleCopyResponse(GOOD);
  assert.equal(out.primaryTexts.length, PRIMARY_TEXT_COUNT);
  assert.equal(out.headlines.length, HEADLINE_COUNT);
  assert.equal(out.claims.length, 1);
}

// Fenced and chatty responses are the norm, not the exception.
assert.doesNotThrow(() => parseFlexibleCopyResponse('Sure!\n```json\n' + GOOD + '\n```'), 'fenced JSON parses');

assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['a', 'b', 'c'], headlines: ['x', 'y'],
  })),
  /exactly 2 primaryTexts \(got 3/,
  'three texts is a different structure, not a bonus'
);

assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({ primaryTexts: ['a', '  '], headlines: ['x', 'y'] })),
  /primaryTexts\[1\] is empty/,
  'a blank field is not a field'
);

// The failure an operator cannot see by reading the manifest: both entries look fine
// alone, and the shared pool has nothing to learn between them.
assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['Dry skin?', 'dry skin?'], headlines: ['x', 'y'],
  })),
  /primaryTexts are not distinct/,
  'case-only differences are one angle'
);

assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['a', 'b'], headlines: ['x'.repeat(HEADLINE_MAX_CHARS + 1), 'y'],
  })),
  /exceeds Meta's field limits/,
  'Meta truncates; a truncated headline is a different headline'
);

assert.doesNotThrow(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['a'.repeat(PRIMARY_TEXT_MAX_CHARS), 'b'], headlines: ['x'.repeat(HEADLINE_MAX_CHARS), 'y'],
  })),
  'exactly at the limit is allowed'
);

assert.throws(() => parseFlexibleCopyResponse('not json at all'), /was not JSON/);

// ── the gates apply to ad-level copy too ────────────────────────────────────
// The whole reason flexibleZones exists: the health gate is reused UNCHANGED, so a
// disease name in a primary text stops the run exactly as it would on a plate.
{
  const zones = flexibleZones({
    primaryTexts: ['Tried steroids for your eczema?', 'clean'],
    headlines: ['a', 'b'],
  });
  assert.deepEqual(Object.keys(zones), ['primaryText1', 'primaryText2', 'headline1', 'headline2']);
  assert.throws(() => assertNoHealthClaims(zones), /eczema|steroid/i,
    'ad-level copy is subject to the same law as plate copy');
}

// ── the prompt carries the shared rules block ───────────────────────────────
{
  const prompt = buildFlexibleCopyPrompt({
    product: { title: 'Coconut Lotion', handle: 'coconut-lotion', priceLabel: '$30' },
    concepts: [{ format: { key: 'us-vs-them', name: 'Us vs Them', awareness: 'solution-aware' } }],
    sourceIds: ['pdp', 'catalog'],
  });
  assert.match(prompt, /NO HEALTH CLAIMS, in any field/, 'the shared rules block is present, with the ad-level noun');
  assert.match(prompt, /sourceId\s+from: pdp, catalog/, 'only the sources actually held are offered');
  assert.match(prompt, /genuinely DIFFERENT\s+ANGLES/, 'the two-angles requirement is stated, since it is the point');
}

// ── collectFlexiblePlates ───────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'flex-'));
  // .jpg, NOT .png. artifactName() ends in ".png" because it is a placement-format label;
  // artifactFilename() rewrites the extension to whatever Gemini actually returned, and
  // the recorded artifact is the real filename. The first version of this fixture used
  // .png — my assumption rather than reality — so it passed while the live run reported
  // all three plates unverified against a run.json that said 2 of 3 passed.
  const results = [
    { conceptSlug: 'us-vs-them', format: 'us-vs-them', variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-4x5.jpg', ok: true }] }] },
    { conceptSlug: 'manifesto', format: 'manifesto', variations: [{ n: 1, ok: false, artifacts: [{ artifact: 'meta-plate-4x5.jpg', ok: false }] }] },
    { conceptSlug: 'testimonial', format: 'testimonial', variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-4x5.webp', ok: true }] }] },
  ];
  const plates = collectFlexiblePlates({ runId: 'r1', results, target: META45, root });
  assert.equal(plates.length, 3);
  assert.deepEqual(plates.map(p => p.verified), [true, false, true],
    'a rejected plate is still listed — the operator has two usable plates and must be told, not silently handed a 2-2-2');
  assert.match(plates[0].file, /r1\/us-vs-them\/v1\/meta-plate-4x5\.jpg$/,
    'the path carries the REAL extension, taken from the recorded artifact rather than rebuilt from the label');
  assert.match(plates[2].file, /meta-plate-4x5\.webp$/, 'any media type Gemini returns is matched');

  // A concept whose target errored before writing anything has no file to point at.
  const errored = collectFlexiblePlates({
    runId: 'r1', target: META45, root,
    results: [{ conceptSlug: 'ghosted', format: 'ghosted', variations: [{ n: 1, ok: false, artifacts: [] }] }],
  });
  assert.equal(errored[0].file, null, 'no invented path for an artifact that was never written');
  assert.equal(errored[0].verified, false);

  // A stray file from an earlier run in the same directory must never be picked up:
  // the list comes from what this run recorded, not from readdir.
  mkdirSync(join(root, 'data', 'creatives', 'ad-studio', 'r1', 'ghost', 'v1'), { recursive: true });
  writeFileSync(join(root, 'data', 'creatives', 'ad-studio', 'r1', 'ghost', 'v1', 'meta-plate-4x5.png'), 'x');
  assert.equal(collectFlexiblePlates({ runId: 'r1', results, target: META45, root }).length, 3,
    'the ghost concept is not in results, so it is not in the ad');
}

// ── renderFlexibleManifest ──────────────────────────────────────────────────
{
  const { json, md } = renderFlexibleManifest({
    runId: 'r1',
    product: { handle: 'coconut-lotion', title: 'Coconut Lotion' },
    variant: null,
    target: META45,
    plates: [
      { format: 'us-vs-them', file: '/tmp/a.jpg', verified: true },
      { format: 'manifesto', file: '/tmp/b.jpg', verified: false },
      { format: 'testimonial', file: null, verified: false },
    ],
    primaryTexts: ['one', 'two'],
    headlines: ['three', 'four'],
    claims: [],
  });

  assert.equal(json.structure.combinations, PLATE_COUNT * PRIMARY_TEXT_COUNT * HEADLINE_COUNT);
  assert.equal(json.structure.combinations, 12, 'the 12 that share one learning pool');
  assert.equal(json.placement.ratio, '4:5');
  assert.match(md, /12 combinations sharing one learning pool/);
  assert.match(md, /Do not create three ads/, 'the instruction that makes or breaks the structure is in the deliverable');
  assert.match(md, /did not pass verification — do not ship/, 'the unverified plate is flagged where the operator will see it');
  assert.match(md, /no artifact produced/, 'a concept that rendered nothing says so rather than listing a path that does not exist');
  assert.match(md, /harvest it by copying its post ID/, 'the winner-harvesting rule travels with the ad');
}

console.log('✓ ad-studio flexible-ad tests pass');

// ── --objective: what the ad is FOR ─────────────────────────────────────────
// The first real run got this wrong in a way no gate could catch: the campaign optimises
// on LEAD (a giveaway entry) and the copy sold the lotion, so Meta would have been asked
// to find people likely to enter a giveaway using an ad that never mentioned one.
{
  const { assertObjective, OBJECTIVES, DEFAULT_OBJECTIVE, buildFlexibleCopyPrompt } =
    await import('../../agents/ad-studio/flexible.js');

  assert.equal(DEFAULT_OBJECTIVE, 'sale', 'selling stays the default; entry is opted into');
  assert.deepEqual(OBJECTIVES, ['sale', 'entry']);

  assert.doesNotThrow(() => assertObjective('sale'));
  assert.doesNotThrow(() => assertObjective('entry', { giveaway: { name: 'X' } }));
  assert.throws(() => assertObjective('lead'), /unknown --objective "lead"/);

  // Entry copy with no Entry Period open would fail the claim gate on every prize and
  // deadline anyway — fail earlier, and say why.
  assert.throws(() => assertObjective('entry', { giveaway: null }),
    /needs a live giveaway.*not a citable source/s);

  const base = {
    product: { title: 'Lotion', handle: 'coconut-lotion', priceLabel: '$30' },
    concepts: [{ format: { key: 'giveaway-entry', name: 'Giveaway entry', awareness: 'unaware' } }],
    sourceIds: ['pdp', 'giveaway'],
  };
  const sale = buildFlexibleCopyPrompt({ ...base });
  assert.match(sale, /THE JOB OF THIS AD: sell the product/);
  assert.doesNotMatch(sale, /GIVEAWAY ENTRY/);

  const entry = buildFlexibleCopyPrompt({
    ...base, objective: 'entry',
    giveaway: {
      name: 'Win 36 Free Bars', closesOn: 'September 14, 2026',
      prizes: 'Thirty-six (36) bars of Pure Unscented Moisturizing Coconut Soap, shipped over three (3) years',
      entryPeriod: 'ends at 11:59 PM CT on September 14, 2026',
      howToEnter: 'No purchase necessary.', eligibility: 'US residents 18+',
    },
  });
  assert.match(entry, /THE JOB OF THIS AD: get a GIVEAWAY ENTRY\. Not a sale — an entry\./);
  assert.match(entry, /call to action is to ENTER, in both primary texts/);

  // The writer gets the VERBATIM rules, not a sentence this file wrote. Three runs failed
  // the claim gate because the prompt named "giveaway" as citable, never showed the rules,
  // and separately injected a tidy "entries close September 14, 2026" that the model quoted
  // straight back as evidence — prompt-manufactured text masquerading as source.
  assert.match(entry, /OFFICIAL RULES \(a source you may cite as "giveaway"\)/,
    'the rules text itself is in the prompt, so a verbatim quote is possible at all');
  assert.match(entry, /ends at 11:59 PM CT on September 14, 2026/,
    'the deadline appears only in its real wording');
  assert.match(entry, /Do not restate a deadline in your own words and cite that/);
}

// ── the badge text reaches the renderer ─────────────────────────────────────
// Badge micro-copy is excluded from labelStrings because the VERIFIER cannot read 8px arc
// type back. That is right, and it silently starved the RENDER prompt too — so the model
// invented the words. Two live plates read "SBGAWID CODDA&T OIL" and "HYDENTIAL OILS", and
// the gate passed both, because a vision model auto-corrects while transcribing.
{
  const { extractBadgeText, buildLabelStrings } = await import('../../agents/ad-studio/index.js');
  const prose = 'A white bottle with the brand name "real SKIN CARE" near the top, a small '
    + 'circular badge noting "Organic Coconut Oil + Essential Oils," and "moisturizing body lotion" below.';

  assert.deepEqual(extractBadgeText(prose), ['Organic Coconut Oil + Essential Oils']);

  // The two selections are exact complements — a string belongs to one list or the other,
  // never both, or the verifier would start demanding back what it cannot read.
  const labels = buildLabelStrings({ manifestEntry: { productDescription: prose }, variant: 'pure-unscented' });
  assert.ok(!labels.includes('Organic Coconut Oil + Essential Oils'),
    'badge text stays OUT of the strings the verifier demands back');
  assert.ok(labels.includes('real SKIN CARE') && labels.includes('moisturizing body lotion'),
    'spec-bearing strings are unaffected');

  assert.deepEqual(extractBadgeText('A bottle with "real SKIN CARE" on it.'), [],
    'no badge named, nothing claimed');
}

// ── the badge is per-VARIANT, and no rule about "unscented" can infer it ────
// Verified against the reference photographs, which disagree with each other:
//   coconut-soap/pure-unscented    MADE WITH / ORGANIC COCONUT OIL
//   coconut-lotion/pure-unscented  MADE WITH / ORGANIC COCONUT OIL / + ESSENTIAL OILS
// The render prompt asserted the first shape for every unscented variant for one round and
// (briefly, in this branch) the second for another. Both invent packaging for half the
// catalogue. It is data, so it comes from data.
{
  const { resolveBadgeStrings } = await import('../../agents/ad-studio/index.js');
  const entry = {
    productDescription: 'A bar with a circular badge noting "Organic Coconut Oil + Essential Oils".',
    variantBadges: { 'pure-unscented': 'Made with Organic Coconut Oil' },
  };
  assert.deepEqual(resolveBadgeStrings({ manifestEntry: entry, variant: 'pure-unscented' }),
    ['Made with Organic Coconut Oil'], 'the variant override wins over the product prose');
  assert.deepEqual(resolveBadgeStrings({ manifestEntry: entry, variant: 'calming-lavender' }),
    ['Organic Coconut Oil + Essential Oils'], 'a variant with no override uses the product badge');
  assert.deepEqual(resolveBadgeStrings({ manifestEntry: entry, variant: null }),
    ['Organic Coconut Oil + Essential Oils'], 'no variant, no override');

  // "" means this variant carries NO badge — distinct from having no override at all.
  assert.deepEqual(resolveBadgeStrings({
    manifestEntry: { ...entry, variantBadges: { plain: '' } }, variant: 'plain',
  }), [], 'an empty override means no badge, not "fall back"');
}

// ── the scent gate defers to the variant's real badge ───────────────────────
// It reasoned purely from the word "unscented" and rejected any scent ingredient read off
// the label. Right for coconut-soap/pure-unscented (MADE WITH / ORGANIC COCONUT OIL);
// wrong for coconut-lotion/pure-unscented, whose bottle prints "+ ESSENTIAL OILS". On
// 2026-08-19 it rejected three plates for faithfully reproducing the reference photographs
// they were handed as ground truth — a product on which no correct render could pass.
{
  const { scentVerdict } = await import('../../agents/ad-studio/verify.js');
  const LOTION = ['Made with Organic Coconut Oil + Essential Oils'];
  const SOAP = ['Made with Organic Coconut Oil'];

  const good = scentVerdict('ORGANIC COCONUT OIL + ESSENTIAL OILS',
    { variant: 'pure-unscented', expectedBadge: LOTION });
  assert.equal(good.ok, true, 'the real bottle says it, so the render is accurate');
  assert.equal(good.status, 'on-variant-badge');

  const invented = scentVerdict('ORGANIC COCONUT OIL + ESSENTIAL OILS',
    { variant: 'pure-unscented', expectedBadge: SOAP });
  assert.equal(invented.ok, false, 'the soap badge does NOT say it — still a hard reject');
  assert.equal(invented.status, 'scent-on-unscented');

  // No badge on file → unchanged from before, so nothing that was passing starts failing.
  assert.equal(scentVerdict('ESSENTIAL OILS', { variant: 'pure-unscented' }).ok, false);
  assert.equal(scentVerdict('LAVENDER', { variant: 'calming-lavender' }).status, 'not-unscented');

  // Every scent word must be on the badge — a badge naming one does not license another.
  const partly = scentVerdict('ESSENTIAL OILS + LAVENDER',
    { variant: 'pure-unscented', expectedBadge: LOTION });
  assert.equal(partly.ok, false, 'lavender is not on the badge, so it was invented');

  // Illegible badge type stays acceptable — that is the cost of 8px arc text, not a lie.
  assert.equal(scentVerdict('illegible', { variant: 'pure-unscented', expectedBadge: SOAP }).ok, true);
}

// ── prize-duration claims: instruction was never enough ─────────────────────
// "36 bars SHIPPED OVER three years" is a fulfilment schedule; "a three-year supply" is a
// claim about how fast the winner uses soap. Neither gate can see the difference — every
// word traces to the rules, and none of it names a disease. buildGiveawayBlock has
// forbidden it in prose since 2026-08-18, and on 2026-08-19 the ad-level writer produced
// "Enter to win a year of clean coconut soap" through a prompt containing that prohibition.
{
  const { findSupplyDurationClaims, assertNoSupplyDurationClaims } =
    await import('../../agents/ad-studio/copy.js');

  for (const bad of [
    'Enter to win a year of clean coconut soap',   // the one that actually happened
    'Win a three-year supply',                     // the 2026-08-18 one
    'Three (3) years worth of soap',               // the rules' own numeral style
    '3 YEAR OF SOAP - FREE',                       // a real finished ad, 2026-08-19
    '3 YEARS OF SOAP',
    '2 years of soap free',
    '36 bars that last three years',
    'a 3 year supply',
  ]) {
    assert.ok(findSupplyDurationClaims(bad).length, `must catch: ${bad}`);
  }

  // What the rules actually say must pass, or the guard blocks correct copy.
  for (const ok of [
    'Thirty-six (36) bars of soap, shipped over three (3) years',
    'Enter to win 36 bars',
    'No purchase necessary',
    '6-month shelf life',                          // a product fact, not a use-rate claim
    // The rules' own prize wording contains the substring "per year of four (4) bars",
    // so a pattern keyed loosely on "year of" would reject the source text itself.
    'shipped over three (3) years in three (3) shipments per year of four (4) bars each',
  ]) {
    assert.deepEqual(findSupplyDurationClaims(ok), [], `must not fire on: ${ok}`);
  }

  assert.throws(
    () => assertNoSupplyDurationClaims({ primaryText1: 'Enter to win a year of soap', headline1: 'fine' }),
    /SUPPLY DURATION.*rate of use/s,
  );
  assert.doesNotThrow(() => assertNoSupplyDurationClaims({
    primaryText1: 'Win 36 bars, shipped over three (3) years', headline1: 'Enter free',
  }));

  // Array-valued zones (the manifesto format's `rows`) are checked item by item.
  assert.throws(() => assertNoSupplyDurationClaims({ rows: ['No parabens.', 'A year of soap.'] }),
    /\[rows\]/);
}
