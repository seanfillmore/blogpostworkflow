import { strict as assert } from 'node:assert';
import { buildCopyPrompt, parseCopyResponse, enforceZoneCapacity, expectedStrings } from '../../agents/ad-studio/copy.js';
import { formatByKey, FORMATS } from '../../agents/ad-studio/formats.js';
import { buildSourceIndex } from '../../agents/ad-studio/claims.js';

// buildCopyPrompt names the format's zones and forbids unsourced claims.
const prompt = buildCopyPrompt({
  format: formatByKey('ingredient-callout'),
  product: { title: 'Non-Toxic Body Lotion', handle: 'coconut-lotion', priceLabel: '$30' },
  pdpBody: 'six ingredients that actually absorb',
  persona: { name: 'Sensitive-skin switcher', angles: ['tried everything'] },
  tactics: ['Specificity beats adjectives'],
});
assert.ok(prompt.includes('ingredient-callout'), 'prompt names the format');
for (const z of formatByKey('ingredient-callout').zones) {
  assert.ok(prompt.includes(z), `prompt must name zone ${z}`);
}
assert.ok(/sourceId/.test(prompt), 'prompt must require a sourceId');
assert.ok(/evidence/.test(prompt), 'prompt must require an evidence quote');
assert.ok(prompt.includes('$30'), 'prompt carries the price');
assert.ok(prompt.includes('Sensitive-skin switcher'), 'prompt carries the persona');
assert.ok(prompt.includes('tried everything'), 'prompt carries the persona angle');
assert.ok(prompt.includes('Specificity beats adjectives'), 'prompt carries the tactic menu');
assert.ok(prompt.includes('six ingredients that actually absorb'), 'prompt carries PDP copy');

// buildCopyPrompt names a zone's declared capacity as an explicit maximum, so the
// model is told the layout's physical limit instead of only being asked to fill the
// zone. ingredient-callout declares zoneCapacity.listItems = 4.
assert.equal(formatByKey('ingredient-callout').zoneCapacity.listItems, 4, 'fixture assumption');
assert.ok(
  /listItems \(maximum 4 items/.test(prompt),
  'prompt must name the zone\'s declared maximum'
);
// A zone with no declared capacity (subhead) gets no maximum language attached to it.
assert.ok(!/subhead \(maximum/.test(prompt), 'a zone with no capacity must not get a maximum hint');

// The evidence instruction must forbid a synthesized quote — the real live failure
// was the model citing "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients
// (coconut-lotion) — $30", which concatenates the catalog title, the handle and the
// price with a dash. No such string exists in any source; the gate correctly rejected
// it, but the prompt never told the model that a compound line must become two
// separately-sourced claims. Assert the tightened instruction is actually present.
assert.match(prompt, /contiguous/i, 'evidence must be a contiguous substring');
assert.match(prompt, /verbatim/i, 'evidence must be verbatim, not reworded');
assert.match(prompt, /\bone\b.*source|single.*source|ONE named source/i, 'evidence must come from a single named source');
assert.match(prompt, /split it into|split.*two claims/i, 'a compound claim must be split into two sourced claims');

// parseCopyResponse: bare JSON.
const payload = {
  zones: { headline: 'SIX INGREDIENTS.', subhead: "THAT'S THE WHOLE LIST.", listItems: ['ORGANIC JOJOBA'], bottomBar: 'NO MINERAL OIL' },
  claims: [{ zone: 'headline', text: 'SIX INGREDIENTS.', factual: true, sourceId: 'catalog', evidence: '6 Clean Ingredients' }],
};
const parsed = parseCopyResponse(JSON.stringify(payload));
assert.equal(parsed.zones.headline, 'SIX INGREDIENTS.');
assert.equal(parsed.claims.length, 1);

// parseCopyResponse: markdown-fenced JSON, with and without a language tag.
assert.equal(parseCopyResponse('```json\n' + JSON.stringify(payload) + '\n```').zones.headline, 'SIX INGREDIENTS.');
assert.equal(parseCopyResponse('```\n' + JSON.stringify(payload) + '\n```').zones.headline, 'SIX INGREDIENTS.');

// parseCopyResponse: prose before and after the JSON block.
const chatty = 'Here you go:\n```json\n' + JSON.stringify(payload) + '\n```\nHope that helps.';
assert.equal(parseCopyResponse(chatty).zones.subhead, "THAT'S THE WHOLE LIST.");

// parseCopyResponse: garbage throws a message naming the agent, not a bare SyntaxError.
assert.throws(() => parseCopyResponse('not json at all'), /ad-studio.*copy/i);

// Missing required keys throw rather than yielding a half-built object.
assert.throws(() => parseCopyResponse(JSON.stringify({ zones: {} })), /claims/i);
assert.throws(() => parseCopyResponse(JSON.stringify({ claims: [] })), /zones/i);

// expectedStrings flattens strings and arrays in stable order, dropping empties.
assert.deepEqual(
  expectedStrings({ headline: 'A', listItems: ['B', 'C'], bottomBar: '', subhead: 'D' }),
  ['A', 'B', 'C', 'D']
);
assert.deepEqual(expectedStrings({}), []);

// enforceZoneCapacity — the hard-cap backstop. This is the fix for the real incident:
// a format asked for 6 listItems / 4 bottomBar items when the layout only had room
// for 4 / 3, so the image model silently dropped and rewrote the overflow and every
// paid render was rejected by the verify gate.
{
  const ingredientCallout = formatByKey('ingredient-callout'); // zoneCapacity: { listItems: 4, bottomBar: 3 }

  // A 6-item array over a capacity of 4 is truncated to exactly 4, and a string zone
  // (headline) is left untouched.
  const zones = {
    headline: 'SIX INGREDIENTS.',
    listItems: ['Coconut Oil', 'Jojoba Oil', 'Shea Butter', 'Vitamin E', 'Beeswax', 'Arrowroot'],
  };
  const { zones: out, dropped } = enforceZoneCapacity(zones, ingredientCallout);
  assert.deepEqual(out.listItems, ['Coconut Oil', 'Jojoba Oil', 'Shea Butter', 'Vitamin E'], 'array truncated to the declared capacity');
  assert.equal(out.headline, 'SIX INGREDIENTS.', 'string zones are left untouched');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].zone, 'listItems');
  assert.deepEqual(dropped[0].items, ['Beeswax', 'Arrowroot'], 'dropped reports exactly the removed items');

  // A format with no zoneCapacity at all is a no-op — same zones back, nothing dropped.
  const problemAware = formatByKey('problem-aware');
  assert.equal(problemAware.zoneCapacity, undefined, 'fixture assumption');
  const untouchedInput = { headline: 'H', subhead: 'S', bottomBar: 'B' };
  const { zones: untouchedOut, dropped: noDrops } = enforceZoneCapacity(untouchedInput, problemAware);
  assert.deepEqual(untouchedOut, untouchedInput, 'zones pass through unchanged when the format declares no capacity');
  assert.deepEqual(noDrops, []);

  // An array at or under capacity is left alone (no spurious truncation/log).
  const atCap = { listItems: ['A', 'B', 'C', 'D'] };
  const { zones: atCapOut, dropped: atCapDropped } = enforceZoneCapacity(atCap, ingredientCallout);
  assert.deepEqual(atCapOut.listItems, ['A', 'B', 'C', 'D']);
  assert.deepEqual(atCapDropped, []);

  // Truncation is logged, not silent — a model that ignores the prompt hint must
  // leave a visible trace, or a dropped claim reads as full coverage when it isn't.
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    enforceZoneCapacity(
      { listItems: ['A', 'B', 'C', 'D', 'E'] },
      ingredientCallout
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, 'exactly one warning for the one truncated zone');
  assert.match(warnings[0], /truncated zone "listItems"/);
  assert.match(warnings[0], /ingredient-callout/);
  assert.match(warnings[0], /\bE\b/, 'the logged message names the dropped item');

  // A capacity hit but nothing dropped (at or under cap) must not log anything.
  const originalWarn2 = console.warn;
  const warnings2 = [];
  console.warn = (...args) => warnings2.push(args.join(' '));
  try {
    enforceZoneCapacity({ listItems: ['A'] }, ingredientCallout);
  } finally {
    console.warn = originalWarn2;
  }
  assert.deepEqual(warnings2, [], 'no truncation, no log');
}

// ── EMPTY IS NOT VALID COPY (2026-08-16) ────────────────────────────────────────────
//
// parseCopyResponse checked the SHAPE of the response and never its content, so
// {"headline": "", "attribution": "", "trustLine": ""} sailed through: the claim gate had
// zero claims to validate and therefore trivially passed, three plates were rendered and
// paid for, and the comp pass filled the vacuum by INVENTING ad copy ("Real Skin Care for
// Real People") that no source had ever supported.
//
// That is the worst failure available here — the claim gate exists to stop unsourced copy,
// and an empty response walks AROUND it rather than through it. It happened on
// `testimonial`, whose entire purpose is quoting a real customer.
{
  const testimonial = formatByKey('testimonial');
  const blank = JSON.stringify({ zones: { headline: '', attribution: '', trustLine: '' }, claims: [] });
  assert.throws(
    () => parseCopyResponse(blank, testimonial),
    /empty zone\(s\): headline, attribution, trustLine/,
    'an all-empty response must be refused',
  );

  // One empty zone among good ones is still a blank region in the finished ad.
  assert.throws(
    () => parseCopyResponse(
      JSON.stringify({ zones: { headline: 'Real quote', attribution: '', trustLine: 'x' }, claims: [] }),
      testimonial,
    ),
    /empty zone\(s\): attribution/,
  );

  // Whitespace is empty.
  assert.throws(
    () => parseCopyResponse(
      JSON.stringify({ zones: { headline: '   ', attribution: 'a', trustLine: 'b' }, claims: [] }),
      testimonial,
    ),
    /empty zone\(s\): headline/,
  );

  // A complete response is unchanged.
  const good = parseCopyResponse(
    JSON.stringify({ zones: { headline: 'q', attribution: '— Karen M.', trustLine: 't' }, claims: [] }),
    testimonial,
  );
  assert.deepEqual(good.zones, { headline: 'q', attribution: '— Karen M.', trustLine: 't' });
}

// An ARRAY zone counts as empty when it has no usable entries — a list format with
// `listItems: []` renders the same blank region a missing string would.
{
  const cb = formatByKey('ingredient-callout');
  const zones = { headline: 'h', subhead: 's', listItems: [], bottomBar: ['b'] };
  assert.throws(() => parseCopyResponse(JSON.stringify({ zones, claims: [] }), cb), /empty zone\(s\): listItems/);
  assert.throws(
    () => parseCopyResponse(JSON.stringify({ zones: { ...zones, listItems: ['', '  '] }, claims: [] }), cb),
    /empty zone\(s\): listItems/,
    'an array of blanks is still empty',
  );
  const ok = parseCopyResponse(JSON.stringify({ zones: { ...zones, listItems: ['jojoba'] }, claims: [] }), cb);
  assert.deepEqual(ok.zones.listItems, ['jojoba']);
}

// With no format passed, the declared list falls back to the response's own keys — a
// caller that omits it still gets the empty check, just scoped to what was returned.
assert.throws(
  () => parseCopyResponse(JSON.stringify({ zones: { headline: '' }, claims: [] })),
  /empty zone\(s\): headline/,
);

// ── variant threading (fix/ad-brief-variant-copy) ──────────────────────────────────
//
// buildCopyPrompt used to see only the PRODUCT (title/handle/priceLabel), never which
// VARIANT the copy was for. The PDP body and catalog text describe the whole product
// line, so on a scentless variant the writer would happily borrow a sibling variant's
// essential-oil language straight off that shared source text — both gates pass it,
// because the claim IS true of the line and IS traceable to the PDP, just not true of
// THIS bottle. An optional `variant` parameter closes that gap.

// No `variant` key at all: every caller in this codebase's history today. The prompt
// must come out byte-for-byte identical to before this change.
{
  const args = {
    format: formatByKey('problem-aware'),
    product: { title: 'Coconut Bar Soap', handle: 'coconut-soap', priceLabel: '$12' },
    pdpBody: 'available in lavender, citrus and pure unscented',
  };
  const withoutVariantKey = buildCopyPrompt(args);
  const withExplicitUndefined = buildCopyPrompt({ ...args, variant: undefined });
  assert.ok(!/VARIANT:/.test(withoutVariantKey), 'omitting variant must not add a VARIANT block');
  assert.equal(withoutVariantKey, withExplicitUndefined, 'variant: undefined must behave identically to omitting the key');
}

// A variant is named: the writer is told which one and told not to borrow an attribute
// from a sibling variant, even though the PDP/catalog text describes the whole line.
{
  const prompt = buildCopyPrompt({
    format: formatByKey('problem-aware'),
    product: { title: 'Coconut Bar Soap', handle: 'coconut-soap', priceLabel: '$12' },
    pdpBody: 'available in lavender, citrus and pure unscented',
    variant: 'pure-unscented',
  });
  assert.match(prompt, /VARIANT: pure-unscented/, 'the prompt must name the variant');
  assert.match(prompt, /THIS variant ONLY/i, 'the writer must be scoped to this variant');
  assert.match(prompt, /sibling variant|different variant/i, 'the writer must be told not to borrow a sibling variant\'s attributes');
}

// An unscented-style variant name gets the operator's exact instruction: no essential
// oil / scent / fragrance claim, and the absence of fragrance framed as a BENEFIT to
// lead with — verbatim: "make sure there are no essential oil claims... You can
// mention no fragrance as a benefit."
{
  const prompt = buildCopyPrompt({
    format: formatByKey('problem-aware'),
    product: { title: 'Coconut Bar Soap', handle: 'coconut-soap', priceLabel: '$12' },
    pdpBody: 'available in lavender, citrus and pure unscented',
    variant: 'pure-unscented',
  });
  assert.match(prompt, /no essential oil/i, 'unscented variant must forbid essential oil claims');
  assert.match(prompt, /BENEFIT/, 'the absence of fragrance must be framed as a benefit to lead with');
}

// A scented variant's name carries none of "unscented"/"fragrance-free"/"no scent", so
// it must NOT get the no-fragrance instruction — that instruction only applies to a
// variant that is actually scentless.
{
  const prompt = buildCopyPrompt({
    format: formatByKey('problem-aware'),
    product: { title: 'Coconut Bar Soap', handle: 'coconut-soap', priceLabel: '$12' },
    pdpBody: 'available in lavender, citrus and pure unscented',
    variant: 'lavender',
  });
  assert.match(prompt, /VARIANT: lavender/);
  assert.ok(!/NO added fragrance/i.test(prompt), 'a scented variant must not get the no-fragrance instruction');
}

// ── the optional giveaway block (added 2026-08-18) ───────────────────────────────────
//
// Modelled on `variant` above, deliberately: an optional block that contributes NOTHING
// when absent. The no-giveaway prompt is the one every existing concept is written from, so
// it must not drift by so much as a newline just because giveaways became possible.
{
  const base = {
    format: formatByKey('offer-focused'),
    product: { title: 'Coconut Bar Soap', handle: 'coconut-soap', priceLabel: '$12' },
    pdpBody: 'saponified coconut oil, nothing else',
    persona: { name: 'Household switcher', angles: ['the bar you put out for guests'] },
    variant: 'pure-unscented',
    reviews: ['It lasts for ages.'],
  };

  // BYTE-IDENTICAL when no giveaway is passed. Compared against a prompt built from an
  // explicit `giveaway: null` and from omitting the key entirely — both are "no giveaway".
  const without = buildCopyPrompt(base);
  assert.equal(buildCopyPrompt({ ...base, giveaway: null }), without, 'giveaway: null must change nothing');
  assert.equal(buildCopyPrompt({ ...base, giveaway: undefined }), without, 'giveaway: undefined must change nothing');
  assert.ok(!/GIVEAWAY/.test(without), 'no giveaway language leaks into an ordinary prompt');
  assert.match(without, /from: pdp, catalog, brandKit, reviews —/, 'the source list is unchanged');

  // With a giveaway, the writer is told the three things it cannot get wrong: what the
  // prize is, when entries close, and that the ask is an ENTRY rather than a purchase.
  const giveaway = {
    name: 'Official Rules — "Win 36 Free Bars" Giveaway',
    closesOn: 'September 14, 2026',
    prizes: 'Thirty-six (36) bars of Pure Unscented Moisturizing Coconut Soap, shipped over three (3) years.',
    entryPeriod: 'The Promotion begins at 12:00 AM CT on August 18, 2026 and ends at 11:59 PM CT on September 14, 2026.',
    howToEnter: 'No purchase necessary. To enter, submit your email address and first name.',
    eligibility: 'Open to legal residents of the fifty (50) United States who are eighteen (18) years of age or older.',
  };
  const withGiveaway = buildCopyPrompt({ ...base, giveaway });

  assert.match(withGiveaway, /Thirty-six \(36\) bars/, 'the prize is stated, verbatim from the rules');
  assert.match(withGiveaway, /three \(3\) years/, 'including its duration — the strong hook');
  assert.match(withGiveaway, /Entries close September 14, 2026/, 'the deadline is stated');
  assert.match(withGiveaway, /ENTRY \(an email address\), NOT a purchase/, 'the goal is an entry, not a sale');
  assert.match(withGiveaway, /NO PURCHASE NECESSARY/);
  assert.match(withGiveaway, /Open to legal residents of the fifty \(50\) United States/, 'eligibility is quoted too');

  // The claim instruction must actually OFFER the new sourceId, or the writer would cite a
  // source it was never told it had — and the gate would reject copy that was correct.
  assert.match(withGiveaway, /from: pdp, catalog, brandKit, reviews, giveaway —/);

  // A call to action asserts no fact. Without this the writer marks "Enter to win" factual
  // and burns the concept looking for a quote that does not exist in a legal document.
  assert.match(withGiveaway, /"Enter to win".*factual: false/s);
  // ...but a DATE is a fact, and must not get swept into the same exemption.
  assert.match(withGiveaway, /A DATE is a fact/);

  // The block is additive: everything the ordinary prompt said is still said.
  assert.match(withGiveaway, /VARIANT: pure-unscented/);
  assert.match(withGiveaway, /NO HEALTH CLAIMS/);
  assert.match(withGiveaway, /saponified coconut oil, nothing else/);

  // ── a shipping schedule is not a supply duration ───────────────────────────────────
  //
  // THE INCIDENT. This block used to ask the writer to quote the prize's "quantity and
  // duration", and the first live giveaway run returned "Win a three-year SUPPLY" from rules
  // saying only "shipped over three (3) years". Both gates passed it — every word traced to
  // the rules prose — because the failure is a SEMANTIC conversion no string matcher sees:
  // "shipped over 3 years" is a fact about fulfilment, "a 3-year supply" is a claim about
  // how fast the winner uses soap. Nothing sources that.
  assert.match(withGiveaway, /SHIPPING SCHEDULE/, 'the writer must be told to state the schedule');
  assert.match(
    withGiveaway,
    /may NOT convert that\s+into how long they will last anyone/,
    'and told explicitly not to convert it into a duration of use',
  );
  // Compared against a whitespace-normalised prompt: the block hard-wraps, so the phrases it
  // names can straddle a newline. What matters is that each one is spelled out rather than
  // gestured at — "do not overstate" would not have stopped the run that caused this.
  const flat = withGiveaway.replace(/\s+/g, ' ');
  for (const banned of ['a three-year supply', 'lasts three years', "three years' worth"]) {
    assert.ok(flat.includes(banned), `the banned phrasing "${banned}" must be named, not implied`);
  }

  // ── prizeFraming: an A/B knob over a multi-component prize ─────────────────────────
  //
  // Absent, it contributes NOTHING — same discipline as the giveaway block itself. A default
  // here would silently re-frame every giveaway ad the fleet already generates.
  assert.ok(!/PRIZE FRAMING/.test(withGiveaway), 'no framing instruction without the option');
  assert.equal(
    buildCopyPrompt({ ...base, giveaway: { ...giveaway, prizeFraming: undefined } }),
    withGiveaway,
    'an undefined framing must be byte-identical to no framing',
  );
  assert.equal(
    buildCopyPrompt({ ...base, giveaway: { ...giveaway, prizeFraming: 'nonsense' } }),
    withGiveaway,
    'an unrecognised framing falls back to no instruction rather than emitting a broken one — '
    + 'parseArgs is what rejects a bad value, and it does so by name before any spend',
  );

  const soapOnly = buildCopyPrompt({ ...base, giveaway: { ...giveaway, prizeFraming: 'soap' } });
  assert.match(soapOnly, /lead with the SOAP portion of the prize only/);
  assert.match(soapOnly, /Do not mention the\s+Sensitive Skin Moisturizing Sets/);
  // Understating a prize is safe; overstating is not. The asymmetry is stated so nobody
  // "balances" it later into permission to inflate.
  assert.match(soapOnly, /Understating a prize is permitted; overstating one is not/);

  const fullPrize = buildCopyPrompt({ ...base, giveaway: { ...giveaway, prizeFraming: 'full' } });
  assert.match(fullPrize, /name BOTH components of the prize/);
  assert.match(fullPrize, /Sensitive\s+Skin Moisturizing Sets/);
  // Both framings still quote the SAME rules text and face the SAME gate — the knob decides
  // emphasis, never what counts as sourced.
  for (const p of [soapOnly, fullPrize]) {
    assert.match(p, /Thirty-six \(36\) bars/);
    assert.match(p, /from: pdp, catalog, brandKit, reviews, giveaway —/);
    assert.match(p, /SHIPPING SCHEDULE/);
  }
}

// ── every citable source must be VISIBLE to the writer (2026-08-18) ──────────────────
//
// THE BUG. `pdp` and `reviews` had their text in the prompt; `brandKit` and `catalog` were
// named in the "cite one of these" list and their content was never shown. A writer cannot
// quote a contiguous verbatim substring of a source it has never seen, so those two were
// nameable but uncitable — and naming them was WORSE than omitting them, because the writer
// attributes a real fact to the wrong source and the gate rejects correct copy. Live on
// 2026-08-18: the EWG ingredient figure sat in brand-kit.json, the writer could only see the
// PDP, so it cited `pdp` and the run died with the evidence in the index the whole time.
// Same class as PR #491's `reviews` — an accepted sourceId nothing populated.
{
  const brandKit = { marker: 'BRANDKITMARKER' };
  const catalogEntry = { marker: 'CATALOGMARKER' };
  const sourceIndex = buildSourceIndex({
    pdpBody: 'PDPMARKER', brandKit, catalogEntry, reviews: ['REVIEWMARKER'],
  });
  const p = buildCopyPrompt({
    format: FORMATS[0], product: { title: 'T', handle: 'h', priceLabel: '$1' },
    pdpBody: 'PDPMARKER', persona: { name: 'N', angles: ['a'] }, reviews: ['REVIEWMARKER'],
    sourceIndex, brandKit, catalogEntry,
  });
  for (const marker of ['PDPMARKER', 'REVIEWMARKER', 'BRANDKITMARKER', 'CATALOGMARKER']) {
    assert.ok(p.includes(marker), `${marker} must be visible to the writer, not merely citable`);
  }

  // Rendered from the ORIGINAL object, never sourceIndex[id]: normalizeForMatch lowercases
  // and strips punctuation, so the index holds "{markerbrandkitmarker}". Showing that would
  // hand the writer mangled text to quote and teach it to write lowercase copy.
  assert.ok(!p.includes('{markerbrandkitmarker}'), 'the normalised index text must not be shown');

  // OFFER ONLY WHAT EXISTS. Telling the writer it may cite `catalog` on a run with no
  // catalog entry is an invitation to attribute a true statement to a source that is not
  // there for this product.
  const pdpOnly = buildCopyPrompt({
    format: FORMATS[0], product: { title: 'T', handle: 'h', priceLabel: '$1' },
    pdpBody: 'P', persona: { name: 'N', angles: ['a'] },
    sourceIndex: buildSourceIndex({ pdpBody: 'P' }),
  });
  assert.match(pdpOnly, /from: pdp —/, 'a pdp-only run must offer only pdp');
  assert.ok(!/BRAND KIT \(a source/.test(pdpOnly), 'and must not render an absent source block');

  // Callers that pass no sourceIndex keep the old fixed list, so anything not yet updated
  // behaves exactly as before.
  const legacy = buildCopyPrompt({
    format: FORMATS[0], product: { title: 'T', handle: 'h', priceLabel: '$1' },
    pdpBody: 'P', persona: { name: 'N', angles: ['a'] },
  });
  assert.match(legacy, /from: pdp, catalog, brandKit, reviews —/, 'no sourceIndex keeps the legacy list');
}
