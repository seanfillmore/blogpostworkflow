import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ingredientFacts, siblingVariants, brandFacts, resolveLanding, parseMetaCopyResponse, metaCopyZones,
  unsourcedNumbers, metaCopyViolations, generateMetaCopy, renderMetaCopyMarkdown, writeBatchMetaCopy,
  buildMetaCopyPrompt, META_COPY_FILE,
} from '../../../agents/ad-batch/meta-copy.js';
import { parseMetaCopy } from '../../../lib/social-ingest.js';
import { parseArgs, writeCopyForBatch, copyOnly } from '../../../agents/ad-batch/index.js';
import { parseBatch } from '../../../agents/ad-batch/batch.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const ingredients = JSON.parse(readFileSync(join(ROOT, 'config/ingredients.json'), 'utf8'));
const pressFacts = JSON.parse(readFileSync(join(ROOT, 'config/press-facts.json'), 'utf8'));
const bundles = JSON.parse(readFileSync(join(ROOT, 'config/bundles.json'), 'utf8')).bundles;

const PDP = 'Thick enough for heels, hands and elbows. It goes on like butter and works in. No synthetic fragrance.';
const CATALOG = { 'coconut-moisturizer': { title: 'Coconut Moisturizer | 4oz', price: 28, url: 'https://www.realskincare.com/products/coconut-moisturizer' } };

const GOOD = {
  primaryTexts: [
    'Thick enough for heels, hands and elbows, and it goes on like butter. Try it tonight.',
    'Coconut Breeze has 8 ingredients in total. You can read the whole label in one breath, so read it before you buy.',
    'It goes on like butter and works in, with no synthetic fragrance. Thick cream for the rough spots that lotion never reaches.',
    'Handmade in small batches, made in the USA. Try the cream and see why people are switching from long-label lotions.',
  ],
  headlines: ['Read the whole label', 'Goes on like butter', 'Why people are switching', 'Made in the USA'],
  pairing: [{ image: 1, primaryTexts: [4, 1], headlines: [3] }, { image: 2, primaryTexts: [2], headlines: [1] }],
  claims: [
    { zone: 'primaryText1', text: 'Thick enough for heels, hands and elbows', factual: true, sourceId: 'pdp', evidence: 'Thick enough for heels, hands and elbows' },
    { zone: 'primaryText2', text: '8 ingredients', factual: true, sourceId: 'catalog', evidence: 'Body Cream in Coconut Breeze has 8 ingredients in total' },
    { zone: 'primaryText3', text: 'no synthetic fragrance', factual: true, sourceId: 'pdp', evidence: 'No synthetic fragrance' },
    { zone: 'primaryText4', text: 'Handmade in small batches, made in the USA', factual: true, sourceId: 'catalog', evidence: 'Handmade in small batches, made in the USA' },
    { zone: 'headline4', text: 'Made in the USA', factual: true, sourceId: 'catalog', evidence: 'made in the USA' },
  ],
};

function stubAnthropic(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] };
      },
    },
  };
}

function deps(anthropic, over = {}) {
  return {
    anthropic, catalog: CATALOG, ingredients, pressFacts, bundles, competitorNames: ['Dove'],
    siteUrl: 'https://www.realskincare.com',
    fetchPdpBody: async () => PDP, fetchReviews: async () => [], selectReviews: (r) => r,
    now: () => new Date('2026-10-23T12:00:00Z'), ...over,
  };
}

const RECORD = {
  product: { handle: 'coconut-moisturizer', variant: 'coconut-breeze', title: 'Coconut Moisturizer | 4oz' },
  concepts: [
    { headline: '5 reasons people are switching', subhead: 'to a body cream with a 7-ingredient base', dir: '/b/01 5 reasons people are switching', kept: 4 },
    { headline: 'You can read the whole label', subhead: null, dir: '/b/02 You can read the whole label', kept: 4 },
    { headline: 'Nothing kept', dir: '/b/03 Nothing kept', kept: 0 },
  ],
};

// ── sources ──────────────────────────────────────────────────────────────────
test('ingredientFacts counts by product AND scent', () => {
  const breeze = ingredientFacts(ingredients, 'coconut-moisturizer', 'coconut-breeze');
  assert.match(breeze[0], /base formula has 7 ingredients/);
  assert.match(breeze[1], /Coconut Breeze has 8 ingredients in total/);
  const pure = ingredientFacts(ingredients, 'coconut-moisturizer', 'pure-unscented');
  assert.match(pure[1], /has 7 ingredients in total, nothing added to the base/);
  assert.deepEqual(ingredientFacts(ingredients, 'no-such-product', null), []);
  assert.ok(siblingVariants(ingredients, 'coconut-moisturizer', 'coconut-breeze').includes('rose-petal'));
});

test('brandFacts drops prices, percentages, review counts and subscriptions', () => {
  const f = brandFacts(pressFacts);
  assert.ok(f.includes('30-day money-back guarantee'));
  assert.ok(f.every((x) => !/[$%]|review|subscri/i.test(x)));
});

test('resolveLanding: batch file, PDP, matching bundle, fallback', () => {
  const site = 'https://www.realskincare.com';
  assert.equal(resolveLanding({ landing: '/pages/coconut-body-cream', items: [{ handle: 'coconut-moisturizer' }], siteUrl: site }).url, `${site}/pages/coconut-body-cream`);
  assert.equal(resolveLanding({ items: [{ handle: 'coconut-moisturizer' }], catalog: CATALOG, siteUrl: site }).url, CATALOG['coconut-moisturizer'].url);
  const set = resolveLanding({ items: [{ handle: 'coconut-lotion', variant: 'pure-unscented' }, { handle: 'coconut-moisturizer', variant: 'pure-unscented' }], bundles, siteUrl: site });
  assert.equal(set.url, `${site}/products/sensitive-skin-starter-set`);
  const none = resolveLanding({ items: [{ handle: 'coconut-soap', variant: 'x' }, { handle: 'coconut-oil-toothpaste', variant: 'y' }], bundles, siteUrl: site });
  assert.match(none.source, /no bundle matches/);
});

// ── parse / checks ───────────────────────────────────────────────────────────
test('parseMetaCopyResponse enforces counts, limits, the fold and distinctness', () => {
  const ok = parseMetaCopyResponse(JSON.stringify(GOOD), { conceptCount: 2 });
  assert.equal(ok.primaryTexts.length, 4);
  assert.deepEqual(ok.pairing[0].primaryTexts, [4, 1]);
  assert.throws(() => parseMetaCopyResponse('nope'), /not JSON/);
  assert.throws(() => parseMetaCopyResponse(JSON.stringify({ ...GOOD, headlines: [...GOOD.headlines.slice(0, 3), 'x'.repeat(41)] })), /over 40/);
  assert.throws(() => parseMetaCopyResponse(JSON.stringify({ ...GOOD, primaryTexts: GOOD.primaryTexts.map((t) => t.padEnd(130, '.')) })), /125 characters or fewer/);
  assert.throws(() => parseMetaCopyResponse(JSON.stringify({ ...GOOD, primaryTexts: [GOOD.primaryTexts[0], ...GOOD.primaryTexts.slice(0, 3)] })), /not distinct/);
  assert.throws(() => parseMetaCopyResponse(JSON.stringify({ ...GOOD, headlines: ['a', 'b'] })), /got 2/);
  // newlines are collapsed so the markdown parser reads one item per line
  assert.ok(!parseMetaCopyResponse(JSON.stringify({ ...GOOD, primaryTexts: ['Line one.\nLine two.', ...GOOD.primaryTexts.slice(1)] })).primaryTexts[0].includes('\n'));
});

test('unsourcedNumbers: a number must sit in the evidence for its own field', () => {
  assert.deepEqual(unsourcedNumbers({ primaryText1: 'Has 8 ingredients' }, [{ zone: 'primaryText1', factual: true, evidence: 'has 8 ingredients in total' }]), []);
  assert.deepEqual(unsourcedNumbers({ primaryText1: 'Has 7 ingredients' }, [{ zone: 'primaryText1', factual: true, evidence: 'has 8 ingredients in total' }]), [{ zone: 'primaryText1', n: '7' }]);
  assert.deepEqual(unsourcedNumbers({ headline1: '30 days' }, [{ zone: 'primaryText1', factual: true, evidence: '30-day' }]), [{ zone: 'headline1', n: '30' }]);
});

test('metaCopyViolations catches dashes, prices, unsourced claims, sibling scents and competitors', () => {
  const ctx = { sourceIndex: { pdp: PDP, catalog: { x: 1 } }, competitorNames: ['Dove'], variant: 'coconut-breeze', siblingVariants: ['rose-petal'] };
  const cats = (fields, claims = []) => metaCopyViolations(fields, claims, ctx).map((h) => h.category + ':' + h.why).join(' | ');
  assert.match(cats({ headline1: 'Soft skin — fast' }), /dash/);
  assert.match(cats({ headline1: 'Now 20% off' }), /price/);
  assert.match(cats({ headline1: 'Only $28' }), /price/);
  assert.match(cats({ primaryText1: 'Made with saffron' }, [{ zone: 'primaryText1', text: 'saffron', factual: true, sourceId: 'pdp', evidence: 'saffron' }]), /evidence not found/);
  assert.match(cats({ primaryText1: 'Smells like rose petal' }), /variant conflict/);
  assert.match(cats({ primaryText1: 'Better than Dove' }), /competitor/);
  assert.match(cats({ primaryText1: 'Our antiperspirant' }), /antiperspirant/);
  assert.equal(cats({ headline1: 'Goes on like butter' }), '');
});

// ── generation through the shared gate loop ──────────────────────────────────
const gateCtx = { sourceIndex: { pdp: PDP, catalog: { products: { 'coconut-moisturizer': { ingredients: ingredientFacts(ingredients, 'coconut-moisturizer', 'coconut-breeze') } }, brand_facts: brandFacts(pressFacts) } }, competitorNames: [], variant: 'coconut-breeze', siblingVariants: [] };

test('generateMetaCopy passes clean copy on the first attempt', async () => {
  const a = stubAnthropic([GOOD]);
  const r = await generateMetaCopy({ anthropic: a, prompt: 'P', conceptCount: 2, gateCtx });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].model, (await import('../../../config/llm-models.js')).LLM_MODELS.standard);
});

test('generateMetaCopy retries once naming the violation, then succeeds', async () => {
  const bad = { ...GOOD, headlines: ['Heals dry skin', ...GOOD.headlines.slice(1)] };
  const a = stubAnthropic([bad, GOOD]);
  const r = await generateMetaCopy({ anthropic: a, prompt: 'P', conceptCount: 2, gateCtx });
  assert.equal(r.ok, true);
  assert.equal(a.calls.length, 2);
  assert.match(a.calls[1].messages[0].content, /PREVIOUS ATTEMPT WAS REJECTED/);
  assert.match(a.calls[1].messages[0].content, /heal/i);
});

test('generateMetaCopy: a wrong-scent count fails twice and returns not ok', async () => {
  const wrong = { ...GOOD, primaryTexts: ['Only 7 ingredients in Coconut Breeze.', ...GOOD.primaryTexts.slice(1)] };
  const a = stubAnthropic([wrong, wrong]);
  const r = await generateMetaCopy({ anthropic: a, prompt: 'P', conceptCount: 2, gateCtx });
  assert.equal(r.ok, false);
  assert.equal(a.calls.length, 2);
  assert.ok(r.violations.some((v) => v.category === 'unsourced-number'));
});

test('generateMetaCopy: malformed JSON is retried with the parse error named', async () => {
  const a = stubAnthropic(['not json', GOOD]);
  const r = await generateMetaCopy({ anthropic: a, prompt: 'P', conceptCount: 2, gateCtx });
  assert.equal(r.ok, true);
  assert.match(a.calls[1].messages[0].content, /not JSON/);
});

// ── the file ─────────────────────────────────────────────────────────────────
test('rendered markdown round-trips through lib/social-ingest.js parseMetaCopy', () => {
  const copy = parseMetaCopyResponse(JSON.stringify(GOOD), { conceptCount: 2 });
  const md = renderMetaCopyMarkdown({ title: 'Coconut Moisturizer | 4oz', landing: { url: 'https://www.realskincare.com/products/coconut-moisturizer' }, concepts: RECORD.concepts, copy, generatedAt: '2026-10-23T12:00:00Z' });
  assert.deepEqual(parseMetaCopy(md), { primaryTexts: GOOD.primaryTexts, headlines: GOOD.headlines });
  assert.match(md, /Landing page: https:\/\/www\.realskincare\.com\/products\/coconut-moisturizer/);
  assert.match(md, /01 5 reasons people are switching: primary texts 1 and 4, headline 3/);
  assert.doesNotMatch(md, /[–—]/);
});

test('prompt covers a set, names the landing page and the image headlines', () => {
  const p = buildMetaCopyPrompt({
    title: 'Sensitive Skin Moisturizing Set', items: [{ handle: 'coconut-lotion', variant: 'pure-unscented', title: 'Body Lotion' }, { handle: 'coconut-moisturizer', variant: 'pure-unscented', title: 'Cream' }],
    variant: null, concepts: RECORD.concepts.slice(0, 2), landing: { url: 'https://x/products/sensitive-skin-starter-set' }, catalogEntry: {}, sourceIds: ['catalog'],
  });
  assert.match(p, /a SET, Sensitive Skin Moisturizing Set/);
  assert.match(p, /sells the SET/);
  assert.match(p, /on-image headline: "You can read the whole label"/);
  assert.match(p, /sensitive-skin-starter-set/);
});

function batchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ad-batch-copy-'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(RECORD));
  return dir;
}

test('writeBatchMetaCopy writes the file, uses only kept concepts, and records the outcome', async () => {
  const dir = batchDir();
  const a = stubAnthropic([GOOD]);
  const r = await writeBatchMetaCopy({ batchDir: dir, record: RECORD, deps: deps(a), log: () => {} });
  assert.equal(r.status, 'written');
  assert.equal(r.landing, CATALOG['coconut-moisturizer'].url);
  const md = readFileSync(join(dir, META_COPY_FILE), 'utf8');
  assert.deepEqual(parseMetaCopy(md).headlines, GOOD.headlines);
  assert.doesNotMatch(a.calls[0].messages[0].content, /Nothing kept/);
  // the catalog source is the scent-specific count, and the price is not shown to the writer
  assert.match(a.calls[0].messages[0].content, /Coconut Breeze has 8 ingredients in total/);
  assert.doesNotMatch(a.calls[0].messages[0].content, /"price"/);
});

test('writeBatchMetaCopy never overwrites an existing file without rewrite', async () => {
  const dir = batchDir();
  writeFileSync(join(dir, META_COPY_FILE), 'hand edited');
  const a = stubAnthropic([GOOD]);
  const r = await writeBatchMetaCopy({ batchDir: dir, record: RECORD, deps: deps(a), log: () => {} });
  assert.equal(r.status, 'kept-existing');
  assert.equal(a.calls.length, 0);
  assert.equal(readFileSync(join(dir, META_COPY_FILE), 'utf8'), 'hand edited');
  const r2 = await writeBatchMetaCopy({ batchDir: dir, record: RECORD, rewrite: true, deps: deps(a), log: () => {} });
  assert.equal(r2.status, 'written');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('meta-copy.previous-')), 'the replaced copy is kept');
});

test('writeBatchMetaCopy writes nothing when copy fails twice, and never throws', async () => {
  const dir = batchDir();
  const bad = { ...GOOD, headlines: ['Cures eczema', ...GOOD.headlines.slice(1)] };
  const r = await writeBatchMetaCopy({ batchDir: dir, record: RECORD, deps: deps(stubAnthropic([bad, bad])), log: () => {} });
  assert.equal(r.status, 'failed');
  assert.equal(existsSync(join(dir, META_COPY_FILE)), false);
  const boom = { messages: { create: async () => { throw new Error('network down'); } } };
  const r2 = await writeBatchMetaCopy({ batchDir: dir, record: RECORD, deps: deps(boom), log: () => {} });
  assert.equal(r2.status, 'failed');
  assert.match(r2.reason, /network down/);
});

test('a PDP fetch failure degrades to the other sources', async () => {
  const dir = batchDir();
  const lines = [];
  const r = await writeBatchMetaCopy({ batchDir: dir, record: RECORD, deps: deps(stubAnthropic([{ ...GOOD, claims: GOOD.claims.filter((c) => c.sourceId !== 'pdp') }]), { fetchPdpBody: async () => { throw new Error('429'); } }), log: (l) => lines.push(l) });
  assert.equal(r.status, 'written');
  assert.ok(lines.some((l) => /no product page body/.test(l)));
});

// ── CLI wiring ───────────────────────────────────────────────────────────────
test('parseArgs: copy flags', () => {
  assert.equal(parseArgs(['b.json']).copy, true);
  assert.equal(parseArgs(['b.json', '--no-copy']).copy, false);
  assert.equal(parseArgs(['b.json', '--rewrite-copy']).rewriteCopy, true);
  const c = parseArgs(['--copy-only', '/x/batch', '--landing', '/pages/p']);
  assert.equal(c.copyOnly, '/x/batch');
  assert.equal(c.landing, '/pages/p');
  assert.throws(() => parseArgs(['b.json', '--landing', '/p']), /--copy-only/);
  assert.throws(() => parseArgs(['--copy-only', '/x', '--no-copy']), /contradict/);
});

test('parseBatch accepts an optional realskincare.com landing', () => {
  const c = [{ headline: 'A' }];
  assert.equal(parseBatch({ product: 'p', concepts: c }).landing, null);
  assert.equal(parseBatch({ product: 'p', concepts: c, landing: '/pages/coconut-body-cream' }).landing, '/pages/coconut-body-cream');
  assert.throws(() => parseBatch({ product: 'p', concepts: c, landing: 'https://evil.example/x' }), /landing/);
});

test('copyOnly writes meta-copy.md from run.json and stamps run.json', async () => {
  const dir = batchDir();
  const r = await copyOnly({ copyOnly: dir, rewriteCopy: false, landing: '/pages/coconut-body-cream' }, { log: () => {}, deps: deps(stubAnthropic([GOOD])) });
  assert.equal(r.status, 'written');
  assert.equal(r.landing, 'https://www.realskincare.com/pages/coconut-body-cream');
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(run.metaCopy.status, 'written');
  assert.equal(run.concepts.length, 3, 'run.json is otherwise unchanged');
});

test('writeCopyForBatch records a failure in run.json and does not throw', async () => {
  const dir = batchDir();
  const r = await writeCopyForBatch(dir, RECORD, { log: () => {}, deps: null });
  assert.equal(r.status, 'failed');
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).metaCopy.status, 'failed');
});

test('zones name each field', () => {
  assert.deepEqual(Object.keys(metaCopyZones({ primaryTexts: ['a', 'b'], headlines: ['c'] })), ['primaryText1', 'primaryText2', 'headline1']);
});
