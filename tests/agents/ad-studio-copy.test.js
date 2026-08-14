import { strict as assert } from 'node:assert';
import { buildCopyPrompt, parseCopyResponse, enforceZoneCapacity, expectedStrings } from '../../agents/ad-studio/copy.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

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
