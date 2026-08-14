import { strict as assert } from 'node:assert';
import { buildCopyPrompt, parseCopyResponse, expectedStrings } from '../../agents/ad-studio/copy.js';
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
