import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../../agents/ad-concepts/structures.js';
import * as ev from '../../agents/ad-concepts/evidence.js';
import { DISEASE_EXTRA, screenReviews, buildQuotePickPrompt, parseQuotePick, quoteFromPick, templateSlot, fillModelSlot, NoQuoteError } from '../../agents/ad-concepts/evidence.js';

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

test('screenReviews drops em dash, short, title-only, competitor, variant conflict, each with its reason', () => {
  const long = 'Really lovely lotion that I use every day';
  const inputs = [`${long} \u2014 great`, 'Too short', 'Coconut Moisturizer | 4oz', `${long} better than Acme`, `${long}, love the lavender scent`, long];
  const r = screenReviews(inputs, { competitorNames: ['Acme'], variant: 'calming-tea-tree', siblingVariants: ['calming-lavender'] });
  assert.deepEqual(r.kept, [long]);
  assert.deepEqual(r.dropped.map(d => d.text), inputs.slice(0, 5));
  assert.match(r.dropped[0].reason, /em dash/);
  assert.match(r.dropped[1].reason, /too short/);
  assert.match(r.dropped[2].reason, /title/);
  assert.match(r.dropped[3].reason, /competitor/);
  assert.match(r.dropped[4].reason, /variant conflict/);
});

test('screenReviews trims kept reviews', () => {
  assert.deepEqual(screenReviews(['  Really lovely lotion that I use every day \n'], {}).kept, ['Really lovely lotion that I use every day']);
});

test('screenReviews: plural-tolerant condition words and treatment phrasing', () => {
  const pad = ' and I really like it a lot';
  for (const t of ['It cleared up my diaper rashes' + pad, 'On a small cut it stopped stinging' + pad, 'Great on my sunburn' + pad, 'I saw scars fading fast' + pad, 'Helps my blisters' + pad, 'Soothes scrapes' + pad, 'It clears up my skin' + pad]) {
    const r = screenReviews([t], {});
    assert.equal(r.kept.length, 0, t);
  }
  // documented behaviour: "haircuts" is kept; "I wound up buying" is over-dropped (acceptable)
  assert.equal(screenReviews(['Great after my haircuts, so soft and light' + pad], {}).kept.length, 1);
  assert.equal(screenReviews(['I wound up buying three of these' + pad], {}).kept.length, 0);
});

test('screenReviews drops reviews about antiperspirant or OTC', () => {
  for (const t of ['Best natural antiperspirant I have ever used, love it so much!', 'Better than any over-the-counter stuff I tried before', 'Works like an OTC product, honestly lovely stuff']) {
    assert.equal(screenReviews([t], {}).kept.length, 0, t);
  }
});

test('truncateAtSentence is gone from the quote path', () => {
  assert.equal(ev.truncateAtSentence, undefined);
});

test('quote pick offers only whole reviews that fit, numbered in the offered list', () => {
  const long = 'x'.repeat(30) + '. ' + 'y'.repeat(300) + '.';
  const p = buildQuotePickPrompt({ structure: S('comment-card-offer'), reviews: [long, K1, K2], maxChars: 220 });
  assert.ok(!p.includes('xxxx'));
  assert.match(p, /\[0\] Incredibly/); assert.match(p, /\[1\] I'm obsessed/);
  assert.equal(parseQuotePick('{"index": 1}', 2), 1);
  assert.throws(() => parseQuotePick('{"index": 2}', 2), /out of range/);
  assert.throws(() => parseQuotePick('nope', 2), /parseable/);
  assert.throws(() => parseQuotePick('{"index": -1}', 2));
});

test('quoteFromPick returns the whole trimmed review verbatim, indexed in the offered list', () => {
  const long = 'z'.repeat(300) + '.';
  assert.equal(quoteFromPick([long, `  ${K2} `], 0, 220), K2);
  assert.equal(quoteFromPick([K1, K2], 1, 220), K2);
});

test('no review fits: typed NoQuoteError', () => {
  const long = 'z'.repeat(300) + '.';
  assert.throws(() => quoteFromPick([long], 0, 220), (e) => e instanceof NoQuoteError && e.name === 'NoQuoteError');
  assert.throws(() => buildQuotePickPrompt({ structure: S('comment-card-offer'), reviews: [long], maxChars: 220 }), NoQuoteError);
});

test('templateSlot: they-think-we-sell labels', () => {
  const s = S('they-think-we-sell');
  assert.equal(templateSlot(s, 'left', { product: { productNoun: 'Coconut lotion' } }), 'Coconut lotion they think we sell');
  assert.equal(templateSlot(s, 'right', { productNoun: 'Body cream' }), 'Body cream we actually sell');
});

const CN = ['Acme'];
test('templateSlot: checklist rows are gated and sourced', () => {
  const s = S('ours-vs-theirs-checklist');
  const sourceIndex = { catalog: 'Only 6 clean ingredients. Made in the USA.', reviews: 'Smells like a spa day' };
  const ctx = { facts: ['Only 6 clean ingredients', 'Made on the moon', 'Made in the USA'], sourceIndex, competitorNames: CN };
  assert.deepEqual(templateSlot(s, 'oursRows', ctx), ['Only 6 clean ingredients', 'Made in the USA']);
  assert.deepEqual(templateSlot(s, 'theirsRows', { competitorNames: CN }), ['Long ingredient list', 'Synthetic fragrance', 'Hard-to-pronounce additives']);
  assert.equal(templateSlot(s, 'title', {}), 'Ours vs Typical drugstore lotion');
});

test('checklist: health claim, reviews-only phrase, and brand rows rejected; missing inputs throw', () => {
  const s = S('ours-vs-theirs-checklist');
  const sourceIndex = { catalog: 'Cures eczema in 3 days. Only 6 clean ingredients.', reviews: 'Smells like a spa day', giveaway: 'Win a year of soap' };
  const r = ev.screenRows(['Cures eczema in 3 days', 'Smells like a spa day', 'Win a year of soap', 'Only 6 clean ingredients'], { sourceIndex, competitorNames: CN });
  assert.deepEqual(r.kept, ['Only 6 clean ingredients']);
  assert.equal(r.dropped.length, 3);
  assert.match(r.dropped[0].reason, /health/);
  assert.throws(() => templateSlot(s, 'oursRows', { facts: ['Made in the USA'], competitorNames: CN }), /sourceIndex/);
  assert.throws(() => templateSlot(s, 'oursRows', { facts: ['x'], sourceIndex }), /competitorNames/);
  assert.throws(() => templateSlot(s, 'theirsRows', {}), /competitorNames/);
  assert.deepEqual(templateSlot(s, 'theirsRows', { competitorNames: ['Synthetic'] }), ['Long ingredient list', 'Hard-to-pronounce additives']);
  const bad = { ...s, rows: { ...s.rows, theirs: ['Cures eczema', 'Long list'] } };
  assert.deepEqual(templateSlot(bad, 'theirsRows', { competitorNames: CN }), ['Long list']);
});

test('fillModelSlot throws when the slot has no maxWords', async () => {
  const st = { id: 'x', slots: { headline: { source: 'model' } } };
  await assert.rejects(() => fillModelSlot({ anthropic: stub('{"text":"a"}'), model: 'm', structure: st, slotName: 'headline', evidence: [], sourceIndex: {} }), /maxWords/);
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

test('templateSlot reports the rows it drops through ctx.onDropped', () => {
  const s = S('ours-vs-theirs-checklist');
  const seen = [];
  const sourceIndex = { catalog: 'Only 6 clean ingredients. Cures eczema fast.' };
  const kept = templateSlot(s, 'oursRows', { facts: ['Only 6 clean ingredients', 'Cures eczema fast', 'Made on the moon'], sourceIndex, competitorNames: CN, onDropped: (slot, d) => seen.push([slot, d]) });
  assert.deepEqual(kept, ['Only 6 clean ingredients']);
  assert.equal(seen[0][0], 'oursRows');
  assert.deepEqual(seen[0][1].map(d => d.text), ['Cures eczema fast', 'Made on the moon']);
  assert.ok(seen[0][1].every(d => d.reason));
});

// ---- acceptance dry run: the model cited "review-1" while the index key is "reviews" ----
test('fillModelSlot prompt lists the exact allowed sourceIds and labels evidence with them, never review-N', async () => {
  const a = stub('{"text":"Soft, not greasy","claims":[]}');
  await fillModelSlot({ anthropic: a, ...base, sourceIndex: { reviews: K1, catalog: 'x', pdp: 'Soft.', brandKit: 'y' } });
  const p = a.calls[0].messages[0].content;
  assert.match(p, /sourceId MUST be exactly one of: "reviews", "catalog", "pdp", "brandKit"/);
  assert.ok(p.includes(`[reviews] ${K1}`));
  assert.doesNotMatch(p, /review-\d/);
});

test('fillModelSlot normalises a cited "review-1" to "reviews" before gating', async () => {
  const a = stub(JSON.stringify({ text: 'Soft, not greasy', claims: [{ text: 'Incredibly soft.', sourceId: 'review-1' }, { text: 'Doesn’t make you feel greasy or sticky after use.', sourceId: 'Review_2' }] }));
  assert.equal(await fillModelSlot({ anthropic: a, ...base, sourceIndex: { reviews: K1 } }), 'Soft, not greasy');
  assert.equal(a.calls.length, 1);
  const bad = stub(JSON.stringify({ text: 'Soft', claims: [{ text: 'Incredibly soft.', sourceId: 'reviewer-1' }] }), JSON.stringify({ text: 'Soft', claims: [{ text: 'Incredibly soft.', sourceId: 'reviewer-1' }] }));
  await assert.rejects(fillModelSlot({ anthropic: bad, ...base, sourceIndex: { reviews: K1 } }), /unknown source/);
});
