import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../../agents/ad-concepts/structures.js';
import { DISEASE_EXTRA, screenReviews, truncateAtSentence, buildQuotePickPrompt, parseQuotePick, quoteFromPick, templateSlot, fillModelSlot } from '../../agents/ad-concepts/evidence.js';

const lib = loadLibrary();
const S = (id) => lib.structures.find(s => s.id === id);
const R1 = 'This lotion is not just hydrating, it has an amazing scent and helps my diabetic skin! I would recommend';
const R2 = "dude as soon as you put it on it just ABSORBS. My hands are in water a lot at my job and this locks moisture in better than any B & B Works or Body shop product. It also doesn't burn my cuts.";
const K1 = 'Incredibly soft. Doesn’t make you feel greasy or sticky after use. It makes you feel incredibly moisturized.';
const K2 = "I'm obsessed with all things Real Skin Care. This is THE moisturizer for Wisconsin winters for my whole family. It's long lasting and doesn't feel greasy. We use it all over and love it!";

test('screenReviews drops the two real bad reviews and keeps the two good ones', () => {
  const r = screenReviews([R1, R2, K1, K2], {});
  assert.deepEqual(r.kept, [K1, K2]);
  assert.deepEqual(r.dropped.map(d => d.text), [R1, R2]);
  assert.ok(r.dropped.every(d => d.reason));
  assert.ok(Object.isFrozen(DISEASE_EXTRA));
});

test('screenReviews drops em dash, short, title-only, competitor, variant conflict', () => {
  const long = 'Really lovely lotion that I use every day';
  const r = screenReviews([`${long} — great`, 'Too short', 'Coconut Moisturizer | 4oz', `${long} better than Acme`, `${long}, love the lavender scent`, long], { competitorNames: ['Acme'], variant: 'calming-tea-tree', siblingVariants: ['calming-lavender'] });
  assert.deepEqual(r.kept, [long]);
  assert.equal(r.dropped.length, 5);
});

test('truncateAtSentence: whole sentences only, verbatim, null when first too long', () => {
  assert.equal(truncateAtSentence('One. Two! Three?', 11), 'One. Two!');
  assert.equal(truncateAtSentence('One. Two! Three?', 100), 'One. Two! Three?');
  assert.equal(truncateAtSentence('A very long first sentence here. B.', 10), null);
  assert.equal(truncateAtSentence('No punctuation at all', 50), 'No punctuation at all');
  assert.equal(truncateAtSentence('Hi. Loves 3.5 stars ok.', 8), 'Hi.');
  const q = truncateAtSentence(K1, 60);
  assert.ok(K1.includes(q) && K1.startsWith(q));
});

test('quote pick prompt/parse/verbatim', () => {
  const p = buildQuotePickPrompt({ structure: S('comment-card-offer'), reviews: [K1, K2] });
  assert.match(p, /\[0\] Incredibly/); assert.match(p, /\[1\] I'm obsessed/);
  assert.equal(parseQuotePick('{"index": 1}', 2), 1);
  assert.throws(() => parseQuotePick('{"index": 2}', 2), /out of range/);
  assert.throws(() => parseQuotePick('nope', 2), /parseable/);
  assert.throws(() => parseQuotePick('{"index": -1}', 2));
  const q = quoteFromPick([K1, K2], 1, 220);
  assert.ok(K2.includes(q)); assert.equal(q, K2);
  assert.throws(() => quoteFromPick([K2], 0, 5), /whole sentence/);
});

test('templateSlot: they-think-we-sell labels', () => {
  const s = S('they-think-we-sell');
  assert.equal(templateSlot(s, 'left', { product: { productNoun: 'Coconut lotion' } }), 'Coconut lotion they think we sell');
  assert.equal(templateSlot(s, 'right', { productNoun: 'Body cream' }), 'Body cream we actually sell');
});

test('templateSlot: checklist rows', () => {
  const s = S('ours-vs-theirs-checklist');
  const sourceIndex = { catalog: 'Only 6 clean ingredients. Made in the USA.' };
  assert.deepEqual(templateSlot(s, 'oursRows', { facts: ['Only 6 clean ingredients', 'Made on the moon', 'Made in the USA'], sourceIndex }), ['Only 6 clean ingredients', 'Made in the USA']);
  assert.deepEqual(templateSlot(s, 'theirsRows', {}), ['Long ingredient list', 'Synthetic fragrance', 'Hard-to-pronounce additives']);
  assert.throws(() => templateSlot(s, 'theirsRows', { competitorNames: ['Synthetic'] }), /brand/);
  assert.equal(templateSlot(s, 'title', {}), 'Ours vs Typical drugstore lotion');
});

const stub = (...texts) => { const calls = []; return { calls, messages: { create: async (a) => { calls.push(a); const t = texts.shift(); return typeof t === 'object' ? t : { stop_reason: 'end_turn', content: [{ type: 'text', text: t }] }; } } }; };
const base = { model: 'm', structure: S('comment-card-offer'), slotName: 'headline', evidence: [K1], sourceIndex: { pdp: 'Soft.' } };

test('fillModelSlot returns clean text in one call', async () => {
  const a = stub('{"text":"Soft, not greasy","claims":[]}');
  assert.equal(await fillModelSlot({ anthropic: a, ...base }), 'Soft, not greasy');
  assert.equal(a.calls.length, 1);
});

test('fillModelSlot regenerates once on an em dash, naming it', async () => {
  const a = stub('{"text":"Soft — not greasy","claims":[]}', '{"text":"Soft, not greasy","claims":[]}');
  assert.equal(await fillModelSlot({ anthropic: a, ...base }), 'Soft, not greasy');
  assert.equal(a.calls.length, 2);
  assert.match(a.calls[1].messages[0].content, /em dash/);
});

test('fillModelSlot throws after two failures, on max_tokens, and on too many words', async () => {
  await assert.rejects(() => fillModelSlot({ anthropic: stub('{"text":"a — b"}', '{"text":"c — d"}'), ...base }), /failed the gate twice/);
  await assert.rejects(() => fillModelSlot({ anthropic: stub({ stop_reason: 'max_tokens', content: [] }), ...base }), /cut off/);
  await assert.rejects(() => fillModelSlot({ anthropic: stub('{"text":"one two three four five six"}', '{"text":"one two three four five six"}'), ...base }), /words/);
});
