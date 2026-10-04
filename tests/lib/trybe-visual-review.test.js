import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisualRequest, parseVisualVerdict, finalizeVerdict, factsFromPdp,
  matchShopifyProduct, submissionImageUrl, cacheKey, REVIEW_RULES, VISUAL_MODEL,
} from '../../lib/trybe-visual-review.js';
import { createVisualReviewer, sizedShopifyImage } from '../../lib/trybe-visual-fetch.js';

const lotion = { handle: 'coconut-lotion', title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', body_html: '<p>Six ingredients: purified spring water, organic virgin coconut oil, organic jojoba, plant-based emulsifying wax.</p>', images: [{ src: '//cdn.shopify.com/a.webp?v=1' }, { src: 'https://cdn.shopify.com/b.jpg' }] };
const still = { id: 'submission_1', trybe_id: 't1', version: 1, status: 'pending', media_type: 'image', products: [{ name: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' }], asset: { url: 'https://r2.example/img.png' }, thumbnail_url: 'https://cdn.example/thumb.jpg' };
const reply = (obj) => JSON.stringify(obj);
const good = { overlay_text: ['my skin’s last step before lights out.'], product_shown: 'lotion', issues: [], verdict: 'looks_ready', summary: 'Matches.', creator_note: '' };

test('the rules carry the operator rulings from the first static batch', () => {
  assert.match(REVIEW_RULES, /pump where the real bottle has a flip-disc cap/);
  assert.match(REVIEW_RULES, /Ignore the tiny curved text/);
  assert.match(REVIEW_RULES, /"essential oils" listed in place of an ingredient/);
  assert.match(REVIEW_RULES, /antiperspirant/);
});

test('factsFromPdp strips markup and caps length', () => {
  assert.equal(factsFromPdp('<p>A&nbsp;<b>b</b></p><script>x()</script>'), 'A b');
  assert.ok(factsFromPdp('x'.repeat(10000)).length <= 3000);
});

test('matchShopifyProduct matches the synced title and never guesses', () => {
  assert.equal(matchShopifyProduct({ name: 'non-toxic body lotion made with only 6 clean ingredients' }, [lotion]), lotion);
  assert.equal(matchShopifyProduct({ name: 'Deodorant' }, [lotion]), null);
  assert.equal(matchShopifyProduct({}, [lotion]), null);
});

test('a still uses its asset, a video its thumbnail; a new version is a new cache key', () => {
  assert.equal(submissionImageUrl(still), 'https://r2.example/img.png');
  assert.equal(submissionImageUrl({ ...still, media_type: 'video' }), 'https://cdn.example/thumb.jpg');
  assert.notEqual(cacheKey(still), cacheKey({ ...still, version: 2 }));
});

test('buildVisualRequest sends references, then the submission, then facts and rules', () => {
  const req = buildVisualRequest({ submission: still, products: [{ title: lotion.title, facts: 'emulsifying wax' }], references: [{ media_type: 'image/jpeg', data: 'R' }], image: { media_type: 'image/png', data: 'S' } });
  assert.equal(req.model, VISUAL_MODEL);
  const kinds = req.messages[0].content.map((b) => b.type);
  assert.deepEqual(kinds, ['text', 'image', 'text', 'image', 'text']);
  assert.equal(req.messages[0].content[3].source.data, 'S');
  assert.match(req.messages[0].content[4].text, /emulsifying wax/);
  assert.equal(req.messages.length, 1, 'one user turn, so the subscription transport can carry it');
});

test('parseVisualVerdict accepts fenced JSON and refuses anything else', () => {
  assert.equal(parseVisualVerdict('```json\n' + reply(good) + '\n```').verdict, 'looks_ready');
  assert.equal(parseVisualVerdict('no json here'), null);
  assert.equal(parseVisualVerdict(reply({ ...good, verdict: 'great' })), null);
});

test('finalizeVerdict: a claim in the image text forces needs_changes, deterministically', () => {
  const v = finalizeVerdict(parseVisualVerdict(reply({ ...good, overlay_text: ['This lotion healed my eczema'] })));
  assert.equal(v.verdict, 'needs_changes');
  assert.ok(v.claims.length > 0);
  assert.ok(v.issues.some((i) => i.type === 'claim'));
});

test('finalizeVerdict: allowed copy stays ready; ready-with-issues becomes unsure', () => {
  assert.equal(finalizeVerdict(parseVisualVerdict(reply({ ...good, overlay_text: ['Feels good on my dry, sensitive skin', 'NO FRAGRANCE. NO DYES.'] }))).verdict, 'looks_ready');
  assert.equal(finalizeVerdict(parseVisualVerdict(reply({ ...good, issues: [{ type: 'packaging', detail: 'pump top' }] }))).verdict, 'unsure');
});

test('sizedShopifyImage resolves protocol-relative URLs and sets a width', () => {
  assert.equal(sizedShopifyImage('//cdn.shopify.com/a.webp?v=1'), 'https://cdn.shopify.com/a.webp?v=1&width=800');
});

function imgFetch(calls, { type = 'image/png' } = {}) {
  return async (url) => {
    calls.push(String(url));
    return new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': type } });
  };
}

test('reviewer: fetches the image and PDP photos, calls the model once, caches by version', async (t) => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'trybe-visual-'));
  const calls = [];
  let modelCalls = 0;
  const client = { messages: { create: async (req) => { modelCalls++; assert.equal(req.messages[0].content.filter((b) => b.type === 'image').length, 3); return { content: [{ type: 'text', text: reply(good) }] }; } } };
  const review = createVisualReviewer({ client, cacheDir: dir, fetchImpl: imgFetch(calls), shopifyProducts: [lotion] });
  const first = await review(still);
  assert.equal(first.verdict.verdict, 'looks_ready');
  assert.equal(first.verdict.references, 2);
  assert.deepEqual(first.verdict.matched_products, ['coconut-lotion']);
  assert.equal(readdirSync(dir).length, 1);
  const second = await review(still);
  assert.equal(second.cached, true);
  assert.equal(modelCalls, 1, 'a cached verdict is not re-reviewed');
  await review({ ...still, version: 2 });
  assert.equal(modelCalls, 2, 'a revised upload is reviewed fresh');
});

test('reviewer: failures are returned, never thrown, and never cached', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'trybe-visual-'));
  const bad = createVisualReviewer({ client: { messages: { create: async () => ({ content: [{ type: 'text', text: 'sorry' }] }) } }, cacheDir: dir, fetchImpl: imgFetch([]), shopifyProducts: [lotion] });
  assert.match((await bad(still)).error, /not the expected JSON/);
  const cut = createVisualReviewer({ client: { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [] }) } }, cacheDir: dir, fetchImpl: imgFetch([]), shopifyProducts: [lotion] });
  assert.match((await cut(still)).error, /truncated/);
  const html = createVisualReviewer({ client: { messages: { create: async () => { throw new Error('should not be called'); } } }, cacheDir: dir, fetchImpl: imgFetch([], { type: 'text/html' }), shopifyProducts: [lotion] });
  assert.match((await html(still)).error, /unsupported image type/);
  assert.match((await html({ ...still, asset: null, thumbnail_url: null })).error, /no image/);
  assert.equal(readdirSync(dir).length, 0);
});

test('reviewer: the Admin API loader goes first and the storefront is the fallback', async () => {
  const client = { messages: { create: async () => ({ content: [{ type: 'text', text: reply(good) }] }) } };
  const calls = [];
  const viaAdmin = createVisualReviewer({ client, fetchImpl: imgFetch(calls), loadProducts: async () => [lotion] });
  assert.deepEqual((await viaAdmin(still)).verdict.matched_products, ['coconut-lotion']);
  assert.ok(!calls.some((u) => u.includes('products.json')), 'storefront not touched when the Admin API answers');

  const fallbackCalls = [];
  const fallback = createVisualReviewer({
    client,
    loadProducts: async () => { throw new Error('no creds'); },
    fetchImpl: async (url) => {
      fallbackCalls.push(String(url));
      if (String(url).includes('products.json')) return new Response(JSON.stringify({ products: [lotion] }), { headers: { 'content-type': 'application/json' } });
      return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    },
  });
  assert.deepEqual((await fallback(still)).verdict.matched_products, ['coconut-lotion']);
  assert.ok(fallbackCalls.some((u) => u.includes('products.json')));
});

test('the creator note never carries an em or en dash', () => {
  const v = parseVisualVerdict(reply({ ...good, verdict: 'needs_changes', creator_note: 'Love this one — two fixes – then done.' }));
  assert.equal(v.creator_note, 'Love this one, two fixes, then done.');
});

import { catalogueFacts, REVIEW_REVISION } from '../../lib/trybe-visual-review.js';
import { readFileSync as _rf } from 'node:fs';

test('catalogue states the base count AND each scent total, from the real config', () => {
  const cat = catalogueFacts(JSON.parse(_rf(new URL('../../config/ingredients.json', import.meta.url), 'utf8')));
  // Sean, 2026-10-04: Coconut Breeze cream is 8, and "7" (the base) is honest too.
  assert.match(cat, /Body Cream \[coconut-moisturizer\], container: jar\. Base formula, 7 ingredients/);
  assert.match(cat, /Coconut Breeze \(\+ organic coconut oil extract = 8\)/);
  assert.match(cat, /A stated count of 7 is correct for every scent/);
  assert.match(cat, /Body Lotion \[coconut-lotion\].*Base formula, 6 ingredients/);
});

test('the request carries the catalogue and the owner-accepted copy rules', () => {
  const req = buildVisualRequest({ submission: { products: [{ name: 'Lotion' }] }, image: { media_type: 'image/jpeg', data: 'x' }, catalogue: '- Body Cream [coconut-moisturizer], container: jar.' });
  const text = req.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  assert.match(text, /FULL REAL SKIN CARE CATALOGUE/);
  assert.match(text, /vs 20\+ in most lotions/);
  assert.match(text, /type "tag"/);
});

test('a tag mismatch alone does not downgrade looks_ready; a real issue still does', () => {
  const base = { overlay_text: [], product_shown: 'Coconut Breeze body cream', summary: '', creator_note: '' };
  assert.equal(finalizeVerdict({ ...base, verdict: 'looks_ready', issues: [{ type: 'tag', detail: 'tagged as lotion, shows the cream' }] }).verdict, 'looks_ready');
  assert.equal(finalizeVerdict({ ...base, verdict: 'looks_ready', issues: [{ type: 'label', detail: 'wrong size' }] }).verdict, 'unsure');
});

test('the cache key carries the review revision, so a rules change re-reviews', () => {
  assert.equal(cacheKey({ id: 'abc', version: 2 }), `abc-v2-r${REVIEW_REVISION}`);
});
