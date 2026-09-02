// tests/agents/ad-studio-golden-thread.test.js
//
// The golden-thread gate. See agents/ad-studio/golden-thread.js for the derivation of every
// number asserted here; these tests pin the measurement so a later edit has to re-measure
// rather than re-assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  findGoldenThread, sellingVocabulary, splitPlateZones, splitPrimaryText, contentTokens,
  MIN_PIVOT_TOKENS, MAX_PREMISE_DOMINANCE, HOOK_ZONES, GOLDEN_THREAD_RULE, goldenThreadRetryNote,
  MIN_BODY_TOKENS_FOR_PIVOT,
} from '../../agents/ad-studio/golden-thread.js';

// ── The two product vocabularies, from the live PDP bodies as at 2026-09-01. Inlined rather
// than fetched: a test that reaches the network fails for reasons that have nothing to do
// with the thing under test.
const SOAP_PDP = `Most bar soap is rendered animal fat held together with synthetic detergents and
"fragrance." This isn't that. One fat: organic virgin coconut oil, cold-pressed and unrefined, turned
into soap. The variations layer in a single named essential oil — no synthetic fragrance, no animal
fat, no detergents. One-ingredient soap base. Organic virgin coconut oil turned into real soap, with
the glycerin that comes with it. Nothing added to irritate sensitive skin. Skin feels conditioned,
not stripped.`;

const soapVocab = () => sellingVocabulary({
  pdpBody: SOAP_PDP,
  catalogEntry: { title: 'Moisturizing Coconut Soap | 3.4oz', priceLabel: '$11' },
  persona: { name: 'Sensitive-skin buyer', angles: ['reacts to fragrance', 'wants a short ingredient list'] },
});

// ── REAL ADS. Verbatim copy.json from data/creatives/ad-studio on the production box, one
// per format family this agent has shipped. None of these may fire.
const REAL_ADS = {
  'offer-focused': {
    headline: 'Nothing Added to Irritate Sensitive Skin',
    subhead: 'No fragrance, no oils added — just saponified organic virgin coconut oil.',
    offerBadge: '$11 A BAR',
    bottomBar: 'SKIN FEELS CONDITIONED, NOT STRIPPED',
  },
  'us-vs-them': {
    headline: 'READ THE LABEL.\nWE DARE YOU.',
    leftHeader: 'MOST BAR SOAP',
    leftItems: [
      'Synthetic "fragrance" hiding undisclosed compounds',
      'Sulfate detergents that strip the skin barrier',
      'Rendered animal fat in the base',
      'Long chemical list on the back panel',
    ],
    rightHeader: 'REAL SKIN CARE',
    rightItems: [
      'No fragrance, nothing added to irritate sensitive skin',
      'One ingredient: saponified organic virgin coconut oil',
      'No SLS, no SLES, no EDTA, no sodium tallowate',
      'Skin afterward feels conditioned, not stripped',
    ],
    bottomBar: 'MOISTURIZING COCONUT SOAP · PURE UNSCENTED · $11',
  },
  manifesto: {
    headline: 'NOTHING\nADDED TO IRRITATE',
    rows: ['No fragrance. No oils added.', 'One fat: coconut oil.', 'Conditioned, not stripped.'],
    bottomBar: 'MOISTURIZING COCONUT SOAP · PURE UNSCENTED · 3.4 OZ · $11 · MADE IN THE USA',
  },
  'fact-hook': {
    headline: '112',
    statContext: 'The number of unique chemical ingredients the average adult puts on their skin in a day — as many as 112, per an EWG / Morning Consult survey of 2,200 U.S. adults, 2023.',
    subhead: 'Pure Unscented is one ingredient: saponified organic virgin coconut oil, no oils added. No fragrance, nothing added to irritate sensitive skin.',
    bottomBar: 'NO PURCHASE NECESSARY — MADE IN THE USA — REALSKINCARE.COM',
  },
};

// ── HAND-WRITTEN GOLDEN THREADS. The hook's premise elaborated across every zone with the
// product's own reasons never stated — the shape an LLM produces by default. Same
// calibration method as lib/product-category-terms.js.
const ADVERSARIAL = {
  'premise elaborated': {
    headline: '112',
    statContext: 'The number of unique chemical ingredients the average adult puts on their skin in a day — EWG / Morning Consult, 2023.',
    subhead: 'Most of those 112 are synthetic compounds nobody discloses. The average bathroom shelf stacks dozens more every morning. How many did you put on today?',
    bottomBar: 'COUNT YOUR CHEMICALS — REALSKINCARE.COM',
  },
  'premise as the closing argument': {
    headline: '112',
    statContext: 'Unique chemical ingredients the average adult applies daily, per EWG / Morning Consult, 2023.',
    subhead: 'Twelve products a day. Dozens of undisclosed compounds in each. That number climbs every year.',
    bottomBar: '112 CHEMICALS A DAY. STILL COUNTING.',
  },
  'hook rerun as body': {
    headline: 'THE AVERAGE BATHROOM SHELF HOLDS 12 PRODUCTS',
    subhead: 'Twelve every morning. Twelve labels nobody reads. Twelve chances for a reaction you cannot trace.',
    bottomBar: 'TWELVE PRODUCTS. HOW MANY DO YOU NEED?',
  },
  'outside stat as theme': {
    headline: '2,200 ADULTS WERE SURVEYED',
    rows: ['Most could not name what they applied.', 'Most had never read a full label.', 'Most assumed somebody checked.'],
    bottomBar: 'NOBODY CHECKED. — EWG / MORNING CONSULT 2023',
  },
};

const score = zones => findGoldenThread({ ...splitPlateZones(zones, null), selling: soapVocab() });

test('golden thread: no false positive on any real shipped ad', () => {
  for (const [name, zones] of Object.entries(REAL_ADS)) {
    const r = score(zones);
    assert.equal(r.goldenThread, false, `"${name}" fired: ${r.reason}`);
  }
});

test('golden thread: every hand-written golden thread is caught', () => {
  for (const [name, zones] of Object.entries(ADVERSARIAL)) {
    const r = score(zones);
    assert.equal(r.goldenThread, true, `"${name}" was MISSED (pivot ${r.pivot}, dominance ${r.dominance.toFixed(2)})`);
    assert.match(r.reason, /became the ad's theme/);
  }
});

test('golden thread: the threshold sits inside a real gap, not on the edge of one', () => {
  const real = Object.values(REAL_ADS).map(z => score(z)).filter(r => !r.exempt).map(r => r.pivot);
  const adv = Object.values(ADVERSARIAL).map(z => score(z).pivot);
  const floor = Math.min(...real);
  const ceiling = Math.max(...adv);
  assert.ok(ceiling < MIN_PIVOT_TOKENS, `adversarial ceiling ${ceiling} must sit below the threshold ${MIN_PIVOT_TOKENS}`);
  assert.ok(MIN_PIVOT_TOKENS < floor, `threshold ${MIN_PIVOT_TOKENS} must sit below the real-ad floor ${floor}`);
  // Re-derived, not asserted as a constant: if the corpus moves, this fails rather than ageing.
  assert.ok(floor / ceiling >= 2, `separation collapsed to ${(floor / ceiling).toFixed(2)}x — re-measure before moving a threshold`);
});

test('golden thread: a headline that is itself a buy reason is exempt, not merely passing', () => {
  // "NOTHING ADDED TO IRRITATE" is drawn wholly from the PDP, so there is no second premise
  // that COULD become the theme. This is what stops the gate firing on manifesto/us-vs-them,
  // and it must come from the arithmetic rather than a list of format keys.
  const r = findGoldenThread({
    hook: 'Nothing added to irritate sensitive skin',
    body: ['One fat: coconut oil.'],
    selling: soapVocab(),
  });
  assert.equal(r.exempt, true);
  assert.equal(r.goldenThread, false);
  assert.deepEqual(r.hookPremise, []);
});

test('golden thread: statContext counts as hook, not as body', () => {
  // Scoring the caption as body credits a fact-hook ad for explaining its own statistic —
  // the measurement error that dropped separation to 1.1x. See the module header.
  assert.ok(HOOK_ZONES.has('headline'));
  assert.ok(HOOK_ZONES.has('statContext'));
  const { hook, body } = splitPlateZones(REAL_ADS['fact-hook'], null);
  assert.equal(hook.length, 2, 'headline + statContext are the hook');
  assert.ok(!body.some(b => String(b).includes('Morning Consult')), 'the caption must not be in the body');
});

test('golden thread: the brand kit is not part of the selling vocabulary', () => {
  // brand-kit.json holds category context — the EWG 112 figure lives there and is a HOOK,
  // not a reason anyone buys soap. Folding it in would let a fact-hook ad that never pivoted
  // score as though it had.
  const v = sellingVocabulary({
    pdpBody: 'one ingredient coconut oil',
    catalogEntry: null,
    persona: null,
    brandKit: { category_ingredient_load: 'as many as 112 unique chemical ingredients' },
  });
  assert.ok(!v.has('112'), 'brand-kit vocabulary must not reach the selling set');
  assert.ok(v.has('coconut'));
});

test('golden thread: digits survive tokenizing', () => {
  // "112" is an entire live headline. Dropping numerics would empty its hook premise and
  // auto-exempt the one format most prone to this defect.
  assert.ok(contentTokens('112 chemicals').has('112'));
});

test('golden thread: singular and plural are one token', () => {
  const t = contentTokens('ingredient ingredients');
  assert.equal(t.size, 1);
});

test('golden thread: the rule ships in the first prompt and the retry names the premise', () => {
  assert.match(GOLDEN_THREAD_RULE, /must NOT become the ad's\s+main theme/);
  assert.match(GOLDEN_THREAD_RULE, /When the headline is itself\s+a product benefit, this rule does not apply/);
  const note = goldenThreadRetryNote(score(ADVERSARIAL['premise elaborated']));
  assert.match(note, /Keep the headline/);
  assert.match(note, /112/, 'the retry must quote the offending premise, not just say "try again"');
});

test('golden thread: a single-sentence primary text reports no pivot rather than passing', () => {
  const { hook, body } = splitPrimaryText('One ingredient. That is the whole soap.');
  assert.equal(hook, 'One ingredient.');
  assert.equal(body, 'That is the whole soap.');
  const only = splitPrimaryText('One ingredient, nothing else');
  assert.equal(only.body, '');
});

// ── KNOWN LIMITATION, PINNED ON PURPOSE.
//
// Stefan Georgi published a matched pair — same product, same buyer, same hook, one labelled
// bad and one good. It is the ideal calibration set and this measure DOES NOT separate it:
// both are 11-paragraph UGC yapper scripts sharing their whole opening, diverging only in the
// final third, so whole-body lexical overlap reads them as near-identical.
//
// This agent writes plates of 3-6 short zones, not 11-paragraph scripts, and at that scale the
// measure separates 2.25x. The miss is recorded here rather than dropped so that anyone who
// later teaches this fleet long-form scripts finds out that this gate does not cover them.
test('golden thread: KNOWN MISS — long-form scripts are not separated by this measure', () => {
  // Written at the length of a REAL product page (~150 words), because a stub under
  // MIN_SELLING_VOCABULARY disarms the check and the test would pass for the wrong reason.
  const selling = sellingVocabulary({
    pdpBody: `Stop scrubbing your toilet. This drop-in device releases a cleaning agent with every
      flush, so the bowl stays sparkling white without a brush, a chore or a weekend. If you hate
      cleaning the toilet, this is the one you want. That stubborn brown ring around the water
      line stops coming back. The dingy, stained look that builds up over the years lifts within
      a week, and the bowl gets whiter than it has been in years. No more embarrassment when
      guests use your bathroom, and no frantic pre-guest scrub before anyone arrives. Setup takes
      thirty seconds — you just drop it in. Waterproof, no wiring, no plumbing, no refills for
      months. A UV light on a timer sanitizes the bowl twice a day. Thousands of five-star
      reviews from people who say they have not scrubbed a toilet in months. Backed by a
      money-back guarantee, so there is no risk in trying it.`,
  });
  assert.ok(selling.size >= 40, 'the fixture vocabulary must be large enough that the check is armed');
  const hook = 'I just found out how much poop bacteria gets on your hands every time you flush the toilet.';
  // The two closes, which are where V1 and V2 actually differ.
  const v1Close = `And the second she told me all that, I went home and disinfected every toilet handle in my house. You can clean your bathroom all day, but that handle is getting recontaminated with every single flush. So if you're still flushing a dirty toilet, just know — your toilet handle is dirtier than your trash can. Get this thing, protect your family from that spray.`;
  const v2Close = `But honestly? What actually sold me wasn't the germ stuff. It's that I HATE cleaning the toilet. No matter how hard I scrub, that brown ring around the water line always comes back, and the whole bowl has gotten dingier. I'd get embarrassed when guests used our bathroom. Within a week the ring was gone. My toilet bowl is whiter than it's been in ten years. That chore is gone from my life.`;

  const bad = findGoldenThread({ hook, body: v1Close, selling });
  const good = findGoldenThread({ hook, body: v2Close, selling });

  // Neither is disarmed or exempt, so this is a real measurement rather than a skipped one.
  for (const r of [bad, good]) {
    assert.equal(r.disarmed, false);
    assert.equal(r.exempt, false);
  }

  // The concept holds: the bad close carries a THIRD of the selling vocabulary the good one
  // does (measured 6 vs 18). The measure is reading the right thing.
  assert.ok(bad.pivot * 2 <= good.pivot, `expected a wide gap, got ${bad.pivot} vs ${good.pivot}`);

  // AND YET THE GATE DOES NOT FIRE ON IT. At long-form length even a body that never pivots
  // accumulates enough incidental product vocabulary to clear a floor calibrated on 3-6 short
  // plate zones. That is the documented limitation, asserted rather than described so it
  // cannot quietly stop being true: if someone recalibrates for long form, this flips and the
  // test tells them the scope note above needs rewriting.
  assert.equal(good.goldenThread, false, 'the good close must never fire');
  assert.equal(bad.goldenThread, false, 'KNOWN: the plate-calibrated floor does not catch long-form');
});


// ── MEASURED 2026-09-02: the Meta 125-character primary text, and why the pivot COUNT is
// switched off at that length. See MIN_BODY_TOKENS_FOR_PIVOT in the module header.
//
// There has never been a real flexible run — zero exist anywhere on the production box — so
// unlike the plate corpus above BOTH sides here are hand-written. That is stated rather than
// hidden: the false-positive rate is the number that costs, and it is the one with no
// independent evidence behind it. Re-measure after the first real `--flexible` run.

const GOOD_PRIMARY = [
  "Your bar soap has 20+ ingredients. Ours has one: organic virgin coconut oil. Nothing added to irritate.",
  "Most soap is animal fat and detergent. This is saponified coconut oil — skin feels conditioned, not stripped.",
  "Read the back panel sometime. Then read ours: one fat, no fragrance, no sulfates, no tallow.",
  "112 chemicals a day on the average adult. This bar is one ingredient, unscented, $11.",
  "Fragrance is the #1 skin irritant. Pure Unscented has none — just coconut oil soap.",
  "Tired of soap that strips? One fat, cold-pressed coconut oil, glycerin left in.",
  "You cannot pronounce half your soap. Ours is coconut oil. That is the whole label.",
  "Undisclosed compounds hide behind one word. We have no fragrance at all.",
];

// The hook's premise elaborated, the product's own reasons never stated.
const BAD_PRIMARY = [
  "112 chemicals a day on the average adult. Twelve products, dozens undisclosed. How many today?",
  "Fragrance is the #1 skin irritant. It hides behind one word on a label. It is in almost everything.",
  "2,200 adults were surveyed. Most could not name what they applied that morning. Most never looked.",
  "The average shelf holds 12 products. Twelve labels. Twelve chances nobody audited.",
  "Undisclosed compounds hide behind one word. That word is legal. That word is everywhere.",
  "Read the back panel sometime. You will not like it. Most people never do.",
];

const scorePrimary = t => findGoldenThread({ ...splitPrimaryText(t), selling: soapVocab() });

test('golden thread: a 125-char primary text is below the pivot-count floor by construction', () => {
  // The structural gap the threshold sits in. Plate bodies are far richer than primary-text
  // bodies, with no overlap — this is what makes one constant serve both surfaces.
  const plateBodies = Object.values(REAL_ADS)
    .map(z => contentTokens(splitPlateZones(z, null).body).size);
  const primaryBodies = GOOD_PRIMARY.concat(BAD_PRIMARY)
    .map(t => contentTokens(splitPrimaryText(t).body).size);

  assert.ok(Math.max(...primaryBodies) < MIN_BODY_TOKENS_FOR_PIVOT,
    `primary-text bodies (max ${Math.max(...primaryBodies)}) must fall below the floor`);
  assert.ok(Math.min(...plateBodies) >= MIN_BODY_TOKENS_FOR_PIVOT,
    `plate bodies (min ${Math.min(...plateBodies)}) must clear the floor`);

  // And the consequence: the count is never consulted on a primary text.
  for (const t of GOOD_PRIMARY.concat(BAD_PRIMARY)) {
    const r = scorePrimary(t);
    if (!r.exempt && !r.disarmed) assert.equal(r.pivotCounted, false, `pivot must not be counted for: ${t}`);
  }
});

test('golden thread: ZERO false positives on good primary texts', () => {
  // The property that makes shipping this safe on a surface with no real data: it can never
  // regenerate copy that pivots properly. A pivot floor of 3 rejects two of these for being
  // SHORT — which is why the count is off and the ratio decides.
  for (const t of GOOD_PRIMARY) {
    const r = scorePrimary(t);
    assert.equal(r.goldenThread, false, `false positive on: ${t}\n  ${r.reason}`);
  }
});

test('golden thread: dominance catches the unambiguous primary-text threads', () => {
  const caught = BAD_PRIMARY.filter(t => scorePrimary(t).goldenThread);
  // Half, not all — stated as a measurement rather than claimed as coverage. The misses are
  // bodies that neither continue the premise nor pivot, plus hooks built entirely from our
  // own vocabulary (which read as exempt). Both are recorded in the module header.
  assert.ok(caught.length >= BAD_PRIMARY.length / 2,
    `expected at least half caught, got ${caught.length}/${BAD_PRIMARY.length}`);
  for (const t of caught) assert.match(scorePrimary(t).reason, /come from the hook's premise/);
});

test('golden thread: an exempt primary text is a structural miss, not a pass', () => {
  // "Your bar soap has 20+ ingredients" is about a COMPETITOR but is built entirely from
  // words our own PDP uses, so the exemption fires and the ad is never judged. Pinned so the
  // limitation stays visible: it is the reason the catch rate is not higher.
  const r = scorePrimary("Your bar soap has 20+ ingredients. Most are synthetic. Nobody reads the panel.");
  assert.equal(r.exempt, true);
  assert.equal(r.goldenThread, false);
});
