// tests/agents/ad-structures-final-review.test.js
//
// Final whole-branch review fixes for agents/ad-concepts (2026-10-03). Phrases are the REAL
// live PDP / review text that shipped as checklist rows and quotes before these fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../../agents/ad-concepts/structures.js';
import { screenReviews, screenRows, fillModelSlot, unsourcedWords, buildRowPickPrompt, parseRowPick } from '../../agents/ad-concepts/evidence.js';
import { variantConflicts, describesScent } from '../../agents/ad-concepts/concepts.js';
import { valueLineOptions, bundleComponents } from '../../agents/ad-concepts/landing.js';
import { getLayout } from '../../agents/ad-concepts/layouts/index.js';
import { buildScenePrompt } from '../../agents/ad-concepts/plates.js';

const lib = loadLibrary();
const S = (id) => lib.structures.find(s => s.id === id);

// ---- 7: condition-word inflections ----
test('screenReviews: burn/sunburn/rash/bleed/scar/blister inflections are condition words; haircuts is not', () => {
  const pad = ' and I keep coming back to this lotion every day.';
  for (const w of ['burning', 'sunburned', 'rashy', 'bleeding', 'scarring', 'blistered']) {
    const r = screenReviews([`My skin was ${w}${pad}`], {});
    assert.equal(r.kept.length, 0, w);
    assert.match(r.dropped[0].reason, /condition word/, w);
  }
  const ok = screenReviews(['I put it on right after my haircuts and it feels lovely every time.'], {});
  assert.equal(ok.kept.length, 1);
  assert.equal(screenReviews(['It soothed my cuts after a long day in the garden, love it.'], {}).kept.length, 0);
});

// ---- 3: an unscented variant never describes or praises a scent ----
const UN = { variant: 'pure-unscented', siblingVariants: ['calming-lavender', 'coconut-breeze'] };
test('describesScent: positive scent wording yes, negations no', () => {
  for (const t of ['The scent is light', 'Love the smell of it', 'Smells amazing', 'a lovely aroma', 'the fragrance lingers', 'like a perfume']) assert.equal(describesScent(t), true, t);
  for (const t of ['No scent at all', 'Totally unscented', 'Fragrance-free and gentle', 'fragrance free', 'No added fragrance', 'No synthetic fragrance, no parabens', 'without any scent', 'Absorbs fast']) assert.equal(describesScent(t), false, t);
});

test('unscented variant: scent rows, reviews and model text are dropped; a scented variant keeps them', () => {
  assert.match(variantConflicts('The scent is light', UN).join(' '), /scent/);
  assert.deepEqual(variantConflicts('The scent is light', { variant: 'coconut-breeze', siblingVariants: ['pure-unscented'] }), []);
  assert.deepEqual(variantConflicts('No synthetic fragrance, no parabens', UN), []);
  const rows = screenRows(['The scent is light', 'A little goes a long way'], { sourceIndex: { pdp: 'The scent is light. A little goes a long way.' }, competitorNames: [], ...UN });
  assert.deepEqual(rows.kept, ['A little goes a long way']);
  assert.match(rows.dropped[0].reason, /scent/);
  const rev = screenReviews(['I love how this smells, so fresh and clean every morning.', 'Soaks in fast and my skin stays soft all day long.'], UN);
  assert.deepEqual(rev.kept, ['Soaks in fast and my skin stays soft all day long.']);
});

test('unscented variant: a model headline that praises the scent is regenerated', async () => {
  const calls = [];
  const texts = ['{"text":"Smells like heaven","claims":[]}', '{"text":"Soft all day","claims":[]}'];
  const anthropic = { messages: { create: async (a) => { calls.push(a); return { stop_reason: 'end_turn', content: [{ type: 'text', text: texts.shift() }] }; } } };
  const out = await fillModelSlot({ anthropic, model: 'm', structure: S('comment-card-offer'), slotName: 'headline', evidence: ['Soft all day long.'], sourceIndex: {}, ...UN });
  assert.equal(out, 'Soft all day');
  assert.match(calls[1].messages[0].content, /scent/);
});

// ---- 5: slots sourced from review wording ----
test('library: texture-scoop headline is marked sourceWords: reviews', () => {
  assert.equal(S('texture-scoop').slots.headline.sourceWords, 'reviews');
});

test('unsourcedWords: content words must appear in the evidence (stopwords, case, plural and -ly tolerated)', () => {
  const ev = 'Incredibly soft. Doesn’t make you feel greasy or sticky after use.';
  assert.deepEqual(unsourcedWords('Soft. Never greasy.', ev), []);
  assert.deepEqual(unsourcedWords('Softly sticky hands', ev), ['hands']);
  assert.deepEqual(unsourcedWords('Silky, never greasy', ev), ['silky']);
  assert.deepEqual(unsourcedWords('Incredible softness', 'incredibly soft'), ['softness']);
});

test('a sourceWords slot regenerates once naming the unsourced words, then the structure is skipped', async () => {
  const mk = (...texts) => { const calls = []; return { calls, messages: { create: async (a) => { calls.push(a); return { stop_reason: 'end_turn', content: [{ type: 'text', text: texts.shift() }] }; } } }; };
  const ev = ['Incredibly soft. Doesn’t make you feel greasy or sticky after use.'];
  const ok = mk('{"text":"Silky and light","claims":[]}', '{"text":"Soft. Never greasy.","claims":[]}');
  assert.equal(await fillModelSlot({ anthropic: ok, model: 'm', structure: S('texture-scoop'), slotName: 'headline', evidence: ev, sourceIndex: {} }), 'Soft. Never greasy.');
  assert.match(ok.calls[1].messages[0].content, /silky/i);
  assert.match(ok.calls[0].messages[0].content, /ONLY words that appear in the evidence/);
  const bad = mk('{"text":"Silky and light","claims":[]}', '{"text":"Velvet touch","claims":[]}');
  await assert.rejects(fillModelSlot({ anthropic: bad, model: 'm', structure: S('texture-scoop'), slotName: 'headline', evidence: ev, sourceIndex: {} }), /not in the review evidence/);
});

// ---- 1: the model picks checklist rows by index ----
test('row pick: prompt numbers the offered rows; parser takes 3-4 distinct in-range indices', () => {
  const rows = ['A little goes a long way', 'Beeswax is what makes it a cream', 'No synthetic fragrance, no parabens', 'It comes from the oils, not added fragrance'];
  const p = buildRowPickPrompt({ structure: S('ours-vs-theirs-checklist'), rows, min: 3, max: 4 });
  rows.forEach((r, i) => assert.ok(p.includes(`[${i}] ${r}`)));
  assert.deepEqual(parseRowPick('{"indices":[2,0,1]}', { n: 4, min: 3, max: 4 }), [2, 0, 1]);
  assert.throws(() => parseRowPick('{"indices":[0,1]}', { n: 4, min: 3, max: 4 }), /3-4/);
  assert.throws(() => parseRowPick('{"indices":[0,0,1]}', { n: 4, min: 3, max: 4 }), /distinct/);
  assert.throws(() => parseRowPick('{"indices":[0,1,9]}', { n: 4, min: 3, max: 4 }), /range/);
  assert.throws(() => parseRowPick('nope', { n: 4, min: 3, max: 4 }), /JSON/);
});

// ---- 9: band preference ----
test('valueLineOptions composes the approved C band from the real catalog title and brand kit', () => {
  const opts = valueLineOptions({ brandKit: { free_shipping_threshold: 45, manufacturing: 'Made in the USA' }, catalogEntry: { title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' } });
  assert.equal(opts.find(o => o.id === 'ingredients-origin').text, 'Only 6 clean ingredients. Made in the USA.');
  assert.ok(opts.some(o => o.id === 'free-shipping' && o.text === 'FREE SHIPPING ON ORDERS OVER $45'));
  assert.equal(valueLineOptions({ brandKit: {}, catalogEntry: { title: 'Only 6 clean ingredients' } }).find(o => o.id === 'ingredients-origin'), undefined);
  assert.deepEqual(S('they-think-we-sell').bandPreference, ['ingredients-origin']);
});

// ---- 4: bundle components from the set's own manifest description ----
test('bundleComponents reads the real starter-set description in order', () => {
  const desc = 'The set consists of three items: a tall, slim cylindrical squeeze bottle (8 fl oz) of moisturizing body lotion with a black flip-top cap; a short, wide cylindrical jar (4 fl oz) of moisturizing body cream with a black screw-on lid; and a round, flat disc-shaped hand & body soap bar wrapped in white packaging.';
  assert.deepEqual(bundleComponents(desc), ['Body Lotion', 'Body Cream', 'Hand & Body Soap']);
  assert.deepEqual(bundleComponents('A short, wide-mouth plastic jar.'), []);
});

// ---- 10: headline-over-photo splits at sentence boundaries ----
test('headline-over-photo sets "Soft. Never greasy." on two lines like approved B', () => {
  const html = getLayout('headline-over-photo').render({ plates: ['x.jpg'], slots: { headline: 'Soft. Never greasy.' }, ratio: '1:1' });
  assert.ok(html.includes('Soft.\nNever greasy.'));
  assert.match(html, /white-space:pre-line/);
  const one = getLayout('headline-over-photo').render({ plates: ['x.jpg'], slots: { headline: 'A 4.5 oz jar' }, ratio: '1:1' });
  assert.ok(one.includes('A 4.5 oz jar'));
});

// ---- 11: texture-scoop is cream-only, so the scene says cream ----
test('texture-scoop scene restores "thick whipped white cream"', () => {
  assert.match(S('texture-scoop').scene.primary, /thick whipped white cream/);
  const p = buildScenePrompt({ structure: S('texture-scoop'), product: { productNoun: 'body cream', productDescriptionShort: '4 fl oz white jar', unitCount: 1, labelStrings: ['real SKIN CARE'], physicalDescription: 'A jar.' } });
  assert.match(p, /thick whipped white cream/);
});

test('library validation: sourceWords and bandPreference values', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'lib-'));
  mkdirSync(join(dir, 'sources'));
  const base = S('texture-scoop');
  copyFileSync(new URL(`../../data/ad-structures/${base.sources[0].image}`, import.meta.url), join(dir, base.sources[0].image));
  const write = (o) => { const p = join(dir, 'library.json'); writeFileSync(p, JSON.stringify({ version: 1, structures: [{ ...base, ...o }] })); return p; };
  assert.throws(() => loadLibrary(write({ slots: { headline: { source: 'model', maxWords: 4, sourceWords: 'pdp' } } })), /sourceWords/);
  assert.throws(() => loadLibrary(write({ bandPreference: ['made-on-the-moon'] })), /bandPreference/);
  assert.throws(() => loadLibrary(write({ bandPreferenceOverOffer: 'yes' })), /bandPreferenceOverOffer/);
  assert.equal(loadLibrary(write({ bandPreference: ['ingredients-origin'], bandPreferenceOverOffer: false })).structures.length, 1);
});

test('real manifest: the starter set names its three components; the jar reads 4 fl oz from its label', async () => {
  const { readFileSync } = await import('node:fs');
  const { productDescriptionShort } = await import('../../agents/ad-concepts/index.js');
  const { buildLabelStrings } = await import('../../agents/ad-studio/index.js');
  const { selectVolumeStrings } = await import('../../agents/ad-studio/verify.js');
  const m = JSON.parse(readFileSync(new URL('../../data/product-images/manifest.json', import.meta.url), 'utf8'));
  const set = m.find(e => e.handle === 'sensitive-skin-starter-set');
  assert.deepEqual(bundleComponents(set.productDescription), ['Body Lotion', 'Body Cream', 'Hand & Body Soap']);
  const jar = m.find(e => e.handle === 'coconut-moisturizer');
  const labels = buildLabelStrings({ manifestEntry: jar, variant: 'pure-unscented' });
  assert.equal(productDescriptionShort(jar.productDescription, 'cream', selectVolumeStrings(labels)), '4 fl oz white jar');
});
