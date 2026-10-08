import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import { parseBatch, screenConcepts, resolveProduct, resolveLineup, categoryFor, DEFAULT_COUNT } from '../../../agents/ad-batch/batch.js';
import { selectLibraryScenes, parseFreshScenes, customScenes, suitsCategory, generateFreshScenes } from '../../../agents/ad-batch/scenes.js';
import { buildPrompt, productForm } from '../../../agents/ad-batch/prompt.js';
import { tokens, findRun, decide, requiredLabelStrings, inventedClaims, parseCheck, checkPrompt } from '../../../agents/ad-batch/check.js';
import { openAiCostUsd, ATTEMPTS } from '../../../agents/ad-batch/render.js';
import { slug, batchDirName, conceptDirName, imageName, scenesMarkdown } from '../../../agents/ad-batch/output.js';
import { parseArgs, planScenes, renderScene } from '../../../agents/ad-batch/index.js';

const library = JSON.parse(readFileSync(new URL('../../../data/ad-batch/scenes.json', import.meta.url)));
// data/product-images/ is gitignored, so the manifest is a fixture here.
const manifest = [
  { handle: 'coconut-moisturizer', title: 'Coconut Moisturizer | 4oz', unitCount: 1, imageDir: 'coconut-moisturizer',
    productDescription: 'A white jar with a black ridged lid. The label reads "real SKIN CARE", then "moisturizing body cream", with "4 fl. oz • 118ml" on a black band.' },
  { handle: 'coconut-lotion', title: 'Body Lotion', unitCount: 1, imageDir: 'coconut-lotion', productDescription: 'A bottle.' },
];

const CREAM = {
  handle: 'coconut-moisturizer', variant: 'coconut-breeze', title: 'Coconut Moisturizer | 4oz', category: 'skin', unitCount: 1,
  description: 'A white jar with a black lid.', unwrappedDescription: '',
  labelStrings: ['real SKIN CARE', 'moisturizing body cream', '4 fl. oz • 118ml', 'coconut breeze'],
  refs: { packaged: ['/x/cream.png'], unwrapped: [] },
};
const SOAP = { ...CREAM, handle: 'coconut-soap', variant: 'pure-unscented', title: 'Moisturizing Coconut Soap | 3.4oz', category: 'bath',
  unwrappedDescription: 'A bare ivory puck.', labelStrings: ['real SKIN CARE', 'hand & body soap', '3.4 oz • 84g', 'realskincare.com', 'pure unscented'],
  refs: { packaged: ['/x/wrapped.png'], unwrapped: ['/x/raw.jpg'] } };

// ── batch file ───────────────────────────────────────────────────────────────
test('parseBatch fills defaults and trims', () => {
  const b = parseBatch({ product: ' coconut-soap ', concepts: [{ headline: ' Pure. Unscented. ', subhead: '  ' }] });
  assert.equal(b.product, 'coconut-soap');
  assert.equal(b.count, DEFAULT_COUNT);
  assert.deepEqual(b.concepts, [{ headline: 'Pure. Unscented.', subhead: null }]);
  assert.deepEqual(b.scenes, []);
});

test('parseBatch names every problem at once', () => {
  assert.throws(() => parseBatch({ count: 30, form: 'boxed', concepts: [{}] }), (e) =>
    /product/.test(e.message) && /count/.test(e.message) && /form/.test(e.message) && /no headline/.test(e.message));
});

test('screenConcepts skips a cure claim and the antiperspirant word, keeps ordinary copy', () => {
  const { ok, skipped } = screenConcepts([
    { headline: '7 Simple Ingredients', subhead: 'vs 20+ in most lotions' },
    { headline: 'Heals eczema overnight', subhead: null },
    { headline: 'Our natural antiperspirant', subhead: null },
  ]);
  assert.deepEqual(ok.map(c => c.headline), ['7 Simple Ingredients']);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every(s => s.reasons.length > 0));
});

test('resolveProduct uses curated refs, falls back to the variant folder, and builds label strings', () => {
  const files = new Set(['/img/_clean-batch3/cream-coconut-breeze.png']);
  const fs = { exists: (p) => files.has(p) || p === '/img/coconut-moisturizer/pure-unscented', list: () => ['b.jpg', 'a.png', 'notes.txt'] };
  const refs = { 'coconut-moisturizer': { 'coconut-breeze': { packaged: ['_clean-batch3/cream-coconut-breeze.png', 'missing.png'] } } };
  const p = resolveProduct({ handle: 'coconut-moisturizer', variant: 'coconut-breeze', manifest, references: refs, imageRoot: '/img', fs });
  assert.deepEqual(p.refs.packaged, ['/img/_clean-batch3/cream-coconut-breeze.png']);
  assert.ok(p.labelStrings.includes('coconut breeze'));
  assert.ok(p.labelStrings.includes('moisturizing body cream'));
  const q = resolveProduct({ handle: 'coconut-moisturizer', variant: 'pure-unscented', manifest, references: refs, imageRoot: '/img', fs });
  assert.deepEqual(q.refs.packaged, ['/img/coconut-moisturizer/pure-unscented/a.png', '/img/coconut-moisturizer/pure-unscented/b.jpg']);
});

test('resolveProduct refuses an unknown handle and a product with no photos', () => {
  assert.throws(() => resolveProduct({ handle: 'nope', manifest, imageRoot: '/img' }), /not in data\/product-images/);
  assert.throws(() => resolveProduct({ handle: 'coconut-lotion', variant: 'x', manifest, imageRoot: '/img', fs: { exists: () => false, list: () => [] } }), /no reference photos/);
});

test('categoryFor maps the catalogue and defaults to all', () => {
  assert.equal(categoryFor('organic-foaming-hand-soap'), 'bath');
  assert.equal(categoryFor('coconut-lotion'), 'skin');
  assert.equal(categoryFor('unknown'), 'all');
});

// ── scene library ────────────────────────────────────────────────────────────
test('scene library: unique ids, known families, every scene has a type style', () => {
  const ids = library.scenes.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of library.scenes) {
    assert.ok(library.families.includes(s.family), s.id);
    assert.ok(s.scene && s.typeStyle, s.id);
  }
  assert.ok(library.scenes.length >= 40);
});

test('selectLibraryScenes covers every family before repeating one, and respects suits', () => {
  const picked = selectLibraryScenes({ library, category: 'bath', n: 12, seed: 'Pure. Unscented.' });
  assert.equal(picked.length, 12);
  assert.equal(new Set(picked.map(s => s.id)).size, 12);
  assert.ok(picked.every(s => suitsCategory(s, 'bath')));
  const fams = new Set(picked.slice(0, library.families.length).map(s => s.family));
  assert.equal(fams.size, library.families.length);
});

test('selectLibraryScenes prefers never-used scenes and pushes this-run scenes last', () => {
  const all = library.scenes.filter(s => suitsCategory(s, 'skin'));
  // Two of the five nature scenes were used recently: the family's slot goes to an unused one.
  const usage = { 'beach-sunset': '2026-10-01T00:00:00Z', 'jungle-floor': '2026-10-02T00:00:00Z' };
  const picked = selectLibraryScenes({ library, category: 'skin', n: 12, usage, seed: 'x' });
  assert.ok(picked.every(s => !usage[s.id]), 'used scenes should not be picked while unused ones remain');
  const first = selectLibraryScenes({ library, category: 'skin', n: 12, seed: 'a' });
  const second = selectLibraryScenes({ library, category: 'skin', n: 12, seed: 'b', exclude: new Set(first.map(s => s.id)) });
  const overlap = second.filter(s => first.some(f => f.id === s.id));
  assert.ok(overlap.length <= Math.max(0, 24 - all.length), `overlap ${overlap.length}`);
});

test('parseFreshScenes sanitises, prefixes and dedupes ids, and rejects junk', () => {
  const text = 'Sure! [{"id":"Rooftop Garden","family":"nature","scene":"a rooftop garden at dusk","typeStyle":"bold sans"},{"id":"rooftop garden","scene":"another"},{"scene":""}] done';
  const s = parseFreshScenes(text, { k: 5 });
  assert.deepEqual(s.map(x => x.id), ['fresh-rooftop-garden', 'fresh-rooftop-garden-2']);
  assert.ok(s[1].typeStyle);
  assert.deepEqual(parseFreshScenes('no json here', { k: 3 }), []);
  assert.equal(parseFreshScenes(text, { k: 1 }).length, 1);
});

test('generateFreshScenes degrades instead of throwing', async () => {
  const boom = { messages: { create: async () => { throw new Error('cli down'); } } };
  const r = await generateFreshScenes({ anthropic: boom, model: 'm', product: CREAM, concept: { headline: 'h' }, chosen: [], k: 4, library });
  assert.deepEqual(r.scenes, []);
  assert.match(r.degraded, /cli down/);
});

test('planScenes tops up from the library when the planner fails, and honours a custom list', async () => {
  const boom = { messages: { create: async () => { throw new Error('x'); } } };
  const batch = { count: 16, scenes: [] };
  const { scenes, degraded } = await planScenes({ batch, concept: { headline: 'h' }, product: CREAM, library, usage: {}, taken: new Set(), anthropic: boom });
  assert.equal(scenes.length, 16);
  assert.equal(new Set(scenes.map(s => s.id)).size, 16);
  assert.ok(degraded);
  const custom = await planScenes({ batch: { count: 16, scenes: ['a red barn', 'hands under a waterfall'] }, concept: { headline: 'h' }, product: CREAM, library, usage: {}, taken: new Set(), anthropic: boom });
  assert.equal(custom.scenes.length, 2);
  assert.equal(custom.scenes[1].hands, true);
});

test('customScenes flags in-use scenes', () => {
  assert.equal(customScenes(['lathering in the shower'])[0].inUse, true);
});

// ── prompt ───────────────────────────────────────────────────────────────────
test('productForm: bar soap goes bare only for in-use scenes unless forced', () => {
  assert.equal(productForm({ product: SOAP, scene: { inUse: true } }), 'unwrapped');
  assert.equal(productForm({ product: SOAP, scene: {} }), 'packaged');
  assert.equal(productForm({ product: SOAP, scene: { inUse: true }, form: 'packaged' }), 'packaged');
  assert.equal(productForm({ product: SOAP, scene: {}, form: 'unwrapped' }), 'unwrapped');
  assert.equal(productForm({ product: CREAM, scene: { inUse: true }, form: 'unwrapped' }), 'packaged');
});

test('buildPrompt carries the exact copy, label strings, type style and the no-other-text rule', () => {
  const { prompt, refs, shown } = buildPrompt({ product: CREAM, concept: { headline: '7 Simple Ingredients', subhead: 'vs 20+ in most lotions' }, scene: { scene: 'a beach', typeStyle: 'script + serif' } });
  assert.equal(shown, 'packaged');
  assert.deepEqual(refs, ['/x/cream.png']);
  for (const s of ['"7 Simple Ingredients"', '"vs 20+ in most lotions"', '"moisturizing body cream"', 'script + serif', '(4:5)', 'No other text']) assert.ok(prompt.includes(s), s);
  const bare = buildPrompt({ product: SOAP, concept: { headline: 'Pure.' }, scene: { scene: 'shower', typeStyle: 't', inUse: true } });
  assert.equal(bare.shown, 'unwrapped');
  assert.deepEqual(bare.refs, ['/x/raw.jpg']);
  assert.ok(bare.prompt.includes('A bare ivory puck.'));
  assert.ok(!bare.prompt.includes('subhead'));
});

// ── check ────────────────────────────────────────────────────────────────────
const concept = { headline: '7 Simple Ingredients', subhead: 'vs 20+ in most lotions' };
const goodRead = { lettering: ['7 Simple', 'Ingredients', 'vs 20+ in most lotions'], label_text: ['real', 'SKIN CARE', 'coconut breeze', 'moisturizing body cream', '4 fl. oz • 118mi'], our_product_count: 1, matches_reference: 'MATCH', hands_present: false, hand_defect: '' };

test('tokens and findRun normalise case, quotes and punctuation', () => {
  assert.deepEqual(tokens('Foam that’s actually soap.'), ['foam', 'thats', 'actually', 'soap']);
  assert.equal(findRun(['a', 'b', 'c'], ['b', 'c']), 1);
  assert.equal(findRun(['a', 'c', 'b'], ['b', 'c']), -1);
});

test('decide passes a good read; a tiny volume misprint is not a failure', () => {
  const v = decide({ read: goodRead, concept, product: CREAM, shown: 'packaged' });
  assert.equal(v.ok, true, v.reasons.join('; '));
});

test('decide fails a misspelled or reordered headline', () => {
  assert.equal(decide({ read: { ...goodRead, lettering: ['7 Simple', 'Ingrediants', 'vs 20+ in most lotions'] }, concept, product: CREAM, shown: 'packaged' }).ok, false);
  assert.equal(decide({ read: { ...goodRead, lettering: ['Ingredients 7 Simple', 'vs 20+ in most lotions'] }, concept, product: CREAM, shown: 'packaged' }).ok, false);
});

test('decide fails a wrong product name on the label', () => {
  const v = decide({ read: { ...goodRead, label_text: ['real SKIN CARE', 'coconut breez', 'moisturizing body cream'] }, concept, product: CREAM, shown: 'packaged' });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(), /coconut breeze/);
});

test('decide allows prop text and other products, fails invented claims', () => {
  const prop = decide({ read: { ...goodRead, lettering: [...goodRead.lettering, 'PASSPORT'] }, concept, product: CREAM, shown: 'packaged' });
  assert.equal(prop.ok, true);
  assert.match(prop.notes.join(), /passport/i);
  for (const bad of ['380+ five-star reviews', 'Dermatologist Tested', '★★★★★', '#1 Best Seller']) {
    const v = decide({ read: { ...goodRead, lettering: [...goodRead.lettering, bad] }, concept, product: CREAM, shown: 'packaged' });
    assert.equal(v.ok, false, bad);
  }
});

test('decide checks unit count, fidelity and hands; a bare bar must carry no text', () => {
  assert.equal(decide({ read: { ...goodRead, our_product_count: 2 }, concept, product: CREAM, shown: 'packaged' }).ok, false);
  assert.equal(decide({ read: { ...goodRead, matches_reference: 'MISMATCH', mismatch_reason: 'pump top' }, concept, product: CREAM, shown: 'packaged' }).ok, false);
  assert.equal(decide({ read: { ...goodRead, matches_reference: 'CANNOT_TELL' }, concept, product: CREAM, shown: 'packaged' }).ok, true);
  assert.equal(decide({ read: { ...goodRead, hands_present: true, hand_defect: 'six fingers' }, concept, product: CREAM, shown: 'packaged' }).ok, false);
  const handsOk = decide({ read: { ...goodRead, hands_present: true }, concept, product: CREAM, shown: 'packaged' });
  assert.equal(handsOk.ok, true);
  assert.ok(handsOk.notes.includes('hands in frame'));
  const bareRead = { ...goodRead, label_text: [] };
  assert.equal(decide({ read: bareRead, concept, product: SOAP, shown: 'unwrapped' }).ok, true);
  assert.equal(decide({ read: { ...bareRead, label_text: ['SOAP'] }, concept, product: SOAP, shown: 'unwrapped' }).ok, false);
  assert.equal(decide({ read: null, concept, product: CREAM, shown: 'packaged' }).ok, false);
});

test('requiredLabelStrings drops volume figures and URLs', () => {
  assert.deepEqual(requiredLabelStrings(SOAP.labelStrings), ['real SKIN CARE', 'hand & body soap', 'pure unscented']);
});

test('inventedClaims is quiet on ordinary prop text', () => {
  assert.deepEqual(inventedClaims('PASSPORT'), []);
  assert.ok(inventedClaims('clinically proven').length > 0);
});

test('parseCheck tolerates prose around the JSON', () => {
  assert.equal(parseCheck('here: {"our_product_count":1} thanks').our_product_count, 1);
  assert.equal(parseCheck('nothing'), null);
});

// ── render / output / CLI ────────────────────────────────────────────────────
test('openAiCostUsd prices the usage block', () => {
  assert.equal(openAiCostUsd(null), 0);
  assert.ok(Math.abs(openAiCostUsd({ input_tokens: 1e6, output_tokens: 1e6 }) - 38) < 1e-9);
  assert.deepEqual(ATTEMPTS, ['openai', 'openai', 'gemini']);
});

test('output names are filesystem-safe and ordered', () => {
  assert.equal(slug('Pure. Unscented. / Nothing: to hide?'), 'Pure Unscented Nothing to hide');
  assert.equal(conceptDirName(0, { headline: "Foam that's actually soap." }), "01 Foam that's actually soap");
  assert.equal(imageName(8, { id: 'beach-sunset' }), '09-beach-sunset.png');
  assert.equal(batchDirName({ date: '2026-10-06', product: CREAM }), '2026-10-06 Coconut Moisturizer - coconut-breeze');
  const md = scenesMarkdown({ concept, results: [{ ok: false, reasons: ['a|b'], notes: [], scene: { scene: 's', source: 'library', family: 'nature' } }] });
  assert.ok(md.includes('a/b'));
});

test('parseArgs', () => {
  const a = parseArgs(['b.json', '--dry-run', '--max-renders', '10']);
  assert.equal(a.batchFile, 'b.json'); assert.equal(a.dryRun, true); assert.equal(a.maxRenders, 10);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['b.json', '--nope']), /unknown/);
});

// renderScene end to end with stubbed engines: OpenAI fails the check, then passes.
test('renderScene retries on a failed check and keeps the first passing render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adbatch-'));
  const ref = join(dir, 'ref.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toFile(ref);
  const img = await sharp({ create: { width: 80, height: 100, channels: 3, background: '#ccc' } }).png().toBuffer();
  const product = { ...CREAM, refs: { packaged: [ref], unwrapped: [] } };
  let renders = 0; let checks = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { renders++; return { ok: true, json: async () => ({ data: [{ b64_json: img.toString('base64') }], usage: { input_tokens: 100, output_tokens: 100 } }) }; };
  const anthropic = { messages: { create: async () => {
    checks++;
    const read = checks === 1 ? { ...goodRead, lettering: ['7 Simpel Ingredients', 'vs 20+ in most lotions'] } : goodRead;
    return { content: [{ text: JSON.stringify(read) }] };
  } } };
  try {
    const budget = { used: 0, max: 10, costUsd: 0 };
    const r = await renderScene({ job: { product, concept, scene: { id: 's', scene: 'beach', typeStyle: 't' }, form: null }, clients: { openaiKey: 'k', gemini: null, anthropic }, budget, refCache: new Map(), log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(renders, 2);
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].ok, false);
    assert.equal(budget.used, 2);
    assert.ok(budget.costUsd > 0);
  } finally { globalThis.fetch = realFetch; }
});

test('renderScene stops at the render budget', async () => {
  const r = await renderScene({ job: { product: CREAM, concept, scene: { id: 's', scene: 'x', typeStyle: 't' } }, clients: { openaiKey: 'k', gemini: null, anthropic: null }, budget: { used: 5, max: 5, costUsd: 0 }, refCache: new Map(), log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /budget/);
});

// ── sets (2-3 products in one image) ─────────────────────────────────────────
const LOTION = { ...CREAM, handle: 'coconut-lotion', variant: 'pure-unscented', title: 'Body Lotion',
  description: 'A tall white squeeze bottle with a black disc cap.',
  labelStrings: ['real SKIN CARE', 'moisturizing body lotion', '8 fl. oz. (236ml)', 'pure unscented'],
  refs: { packaged: ['/x/lotion.jpg', '/x/lotion-2.jpg'], unwrapped: [] } };
const CREAM_PU = { ...CREAM, variant: 'pure-unscented', labelStrings: ['real SKIN CARE', 'moisturizing body cream', '4 fl. oz • 118ml', 'pure unscented'] };
const SET = { handle: 'coconut-lotion+coconut-moisturizer', variant: 'pure-unscented', title: 'Sensitive Skin Moisturizing Set',
  category: 'skin', unitCount: 2, description: '', unwrappedDescription: '', labelStrings: [], items: [LOTION, CREAM_PU],
  refs: { packaged: ['/x/lotion.jpg', '/x/cream.png'], unwrapped: [] } };

test('parseBatch accepts a set of 2-3 products and refuses bad sets', () => {
  const b = parseBatch({ products: [{ product: 'coconut-lotion', variant: 'pure-unscented' }, { product: 'coconut-moisturizer', variant: 'pure-unscented' }],
    title: ' Sensitive Skin Moisturizing Set ', concepts: [{ headline: 'x' }] });
  assert.equal(b.product, null);
  assert.equal(b.title, 'Sensitive Skin Moisturizing Set');
  assert.deepEqual(b.items.map(i => i.product), ['coconut-lotion', 'coconut-moisturizer']);
  // single-product batches keep their old shape
  assert.deepEqual(parseBatch({ product: 'coconut-soap', concepts: [{ headline: 'x' }] }).items, [{ product: 'coconut-soap', variant: null }]);
  const bad = (raw) => assert.throws(() => parseBatch({ concepts: [{ headline: 'x' }], ...raw }));
  bad({ products: [{ product: 'a' }] });
  bad({ products: [{ product: 'a' }, { product: 'b' }, { product: 'c' }, { product: 'd' }] });
  bad({ products: [{ product: 'a' }, { product: 'a' }] });
  bad({ product: 'a', products: [{ product: 'a' }, { product: 'b' }] });
  bad({ products: [{ product: 'a' }, { product: 'b' }], form: 'unwrapped' });
});

test('resolveLineup builds a set from two products, one reference each, in order', () => {
  const fs = { exists: () => true, list: () => ['1.jpg', '2.jpg'] };
  const references = { 'coconut-lotion': { 'pure-unscented': { packaged: ['l/a.jpg', 'l/b.jpg'] } }, 'coconut-moisturizer': { 'pure-unscented': { packaged: ['c/a.png'] } } };
  const batch = parseBatch({ products: [{ product: 'coconut-lotion', variant: 'pure-unscented' }, { product: 'coconut-moisturizer', variant: 'pure-unscented' }],
    concepts: [{ headline: 'x' }] });
  const set = resolveLineup({ batch, manifest, references, imageRoot: '/r', fs });
  assert.equal(set.items.length, 2);
  assert.equal(set.unitCount, 2);
  assert.equal(set.variant, 'pure-unscented');
  assert.equal(set.category, 'skin');
  assert.deepEqual(set.refs.packaged, ['/r/l/a.jpg', '/r/c/a.png']);
  assert.equal(set.title, 'Body Lotion + Coconut Moisturizer');
  // one item resolves exactly like resolveProduct
  const single = resolveLineup({ batch: parseBatch({ product: 'coconut-moisturizer', variant: 'pure-unscented', concepts: [{ headline: 'x' }] }), manifest, references, imageRoot: '/r', fs });
  assert.equal(single.items, undefined);
  assert.equal(single.handle, 'coconut-moisturizer');
});

test('buildPrompt for a set describes every product, its label and one-of-each', () => {
  const { prompt, refs, shown } = buildPrompt({ product: SET, concept: { headline: 'Skin that reacts to everything?', subhead: null }, scene: library.scenes[0], form: null });
  assert.equal(shown, 'packaged');
  assert.deepEqual(refs, ['/x/lotion.jpg', '/x/cream.png']);
  assert.match(prompt, /PRODUCT 1 \(reference photo 1/);
  assert.match(prompt, /PRODUCT 2 \(reference photo 2/);
  assert.match(prompt, /"moisturizing body lotion"/);
  assert.match(prompt, /"moisturizing body cream"/);
  assert.match(prompt, /exactly ONE of each of the 2 products/);
  assert.doesNotMatch(prompt, /Show exactly one of this product/);
});

const SET_READ = {
  lettering: ['Skin that reacts', 'to everything?'],
  products: [
    { product: 1, count: 1, label_text: ['real', 'SKIN CARE', 'pure unscented', 'moisturizing body lotion', '8 fl oz 236ml'], matches_reference: 'MATCH' },
    { product: 2, count: 1, label_text: ['real', 'SKIN CARE', 'pure unscented', 'moisturizing body cream', '4 fl oz 118ml'], matches_reference: 'MATCH' },
  ],
  hands_present: false, hand_defect: '',
};
const SET_CONCEPT = { headline: 'Skin that reacts to everything?', subhead: null };

test('decide passes a good set read and checks each product on its own', () => {
  assert.equal(decide({ read: SET_READ, concept: SET_CONCEPT, product: SET, shown: 'packaged' }).ok, true);
  const wrongLabel = structuredClone(SET_READ); wrongLabel.products[1].label_text = ['real', 'SKIN CARE', 'pure unscented', 'moisturizing body lotion'];
  const r1 = decide({ read: wrongLabel, concept: SET_CONCEPT, product: SET, shown: 'packaged' });
  assert.equal(r1.ok, false);
  assert.match(r1.reasons.join(), /Coconut Moisturizer: label missing or misspelled "moisturizing body cream"/);
  const two = structuredClone(SET_READ); two.products[0].count = 2;
  assert.match(decide({ read: two, concept: SET_CONCEPT, product: SET, shown: 'packaged' }).reasons.join(), /Body Lotion: 2 units, expected 1/);
  const missing = structuredClone(SET_READ); missing.products = [missing.products[0]];
  assert.match(decide({ read: missing, concept: SET_CONCEPT, product: SET, shown: 'packaged' }).reasons.join(), /no reading for product 2/);
  const mismatch = structuredClone(SET_READ); mismatch.products[0].matches_reference = 'MISMATCH'; mismatch.products[0].mismatch_reason = 'pump top';
  assert.match(decide({ read: mismatch, concept: SET_CONCEPT, product: SET, shown: 'packaged' }).reasons.join(), /Body Lotion does not match the photos: pump top/);
});

test('checkPrompt for a set names one reference per product and the ad as the last image', () => {
  const p = checkPrompt({ product: SET, shown: 'packaged' });
  assert.match(p, /Image 1 is a REFERENCE photo of product 1: Body Lotion/);
  assert.match(p, /Image 2 is a REFERENCE photo of product 2: Coconut Moisturizer/);
  assert.match(p, /Image 3 is an AD to check/);
  assert.match(p, /exactly 2 entries in "products"/);
});

test('renderScene checks a set against one reference per product', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adb-set-'));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  const a = join(dir, 'a.png'); const b = join(dir, 'b.png');
  writeFileSync(a, png); writeFileSync(b, png);
  const product = { ...SET, items: [{ ...LOTION, refs: { packaged: [a], unwrapped: [] } }, { ...CREAM_PU, refs: { packaged: [b], unwrapped: [] } }], refs: { packaged: [a, b], unwrapped: [] } };
  let imagesSent = 0;
  const anthropic = { messages: { create: async ({ messages }) => {
    imagesSent = messages[0].content.filter(c => c.type === 'image').length;
    return { content: [{ text: JSON.stringify(SET_READ) }] };
  } } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }], usage: {} }) });
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl;
  try {
    const r = await renderScene({ job: { product, concept: SET_CONCEPT, scene: library.scenes[0], form: null },
      clients: { openaiKey: 'k', gemini: null, anthropic }, budget: { used: 0, max: 5, costUsd: 0 }, refCache: new Map(), log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(imagesSent, 3);
  } finally { globalThis.fetch = realFetch; }
});
