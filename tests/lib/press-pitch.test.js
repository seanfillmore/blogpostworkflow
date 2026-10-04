import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFactSheet, pickProducts, pitchPrompt, quoteAppears, draftPitch, FACT_SHEET_LABEL_WORDS,
} from '../../lib/press-pitch.js';
import { OPT_OUT_LINE, signature } from '../../lib/press-outreach.js';

// Small invented fixtures; the tests never read the real config or catalogue.
const INGREDIENTS = {
  lotion: {
    name: 'Body Lotion', format: 'squeeze bottle', shopify_handle: 'test-lotion',
    base_ingredients: ['spring water', 'coconut oil', 'jojoba'],
    variations: [{ name: 'Pure Unscented', essential_oils: [] }, { name: 'Rose Petal', essential_oils: ['rose oil'] }],
  },
  bar_soap: {
    name: 'Bar Soap', format: 'bar', shopify_handle: 'test-soap',
    base_ingredients: ['saponified coconut oil'],
    variations: [{ name: 'Calming Lavender', essential_oils: ['lavender oil'] }],
  },
};
const CATALOG = {
  generated: '2026-01-01',
  products: {
    'test-lotion': { title: 'Lotion Title', price: 20, priceLabel: '$20', url: 'https://example.com/products/test-lotion' },
    'test-soap': { title: 'Soap Title', price: 8, priceLabel: '$8', url: 'https://example.com/products/test-soap' },
  },
};
const BRAND_KIT = { manufacturing: 'handmade in small batches, made in the USA' };
const ADDRESS = '100 Example St, Testville, ZZ 00000, United States';

const ARTICLE = 'Our tester said the lotion "felt like nothing at all" after a week. ' +
  'We tried twelve lotions over a dry winter in Denver and ranked them by absorption.';

const PROSPECT = {
  key: 'k1', source: 'pr-target', domain: 'example.com', targetUrl: 'https://example.com/best-lotions',
  person: { name: 'Jane Writer', authorUrl: 'https://example.com/jane' }, publication: 'Example Mag',
  competitors: [], prompts: ['best natural body lotion'], angle: null, rank: 1,
};
const CONTACT = { id: 'c1', name: 'Jane Writer', kind: 'person' };

const CLEAN_BODY = 'Your line about lotions that "felt like nothing at all" stuck with me. ' +
  'Our Body Lotion has 3 base ingredients and comes unscented. Happy to send samples if useful.';

function words(s) {
  return String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
}

test('quoteAppears matches curly quotes against straight text and rejects a paraphrase', () => {
  assert.equal(quoteAppears('the lotion “felt like nothing at all”', ARTICLE), true);
  assert.equal(quoteAppears('We tried   TWELVE lotions over a dry winter', ARTICLE), true);
  assert.equal(quoteAppears('the lotion felt weightless on skin', ARTICLE), false);
  assert.equal(quoteAppears('twelve', ARTICLE), false, 'under 12 characters');
  assert.equal(quoteAppears('x'.repeat(201), 'x'.repeat(300)), false, 'over 200 characters');
  assert.equal(quoteAppears(undefined, ARTICLE), false);
});

test('a fabricated opener quote twice fails with fabricated-opener after two calls', async () => {
  let calls = 0;
  const prompts = [];
  const generate = async (prompt) => {
    calls++;
    prompts.push(prompt);
    return { subject: 'Samples for your lotion roundup', opener_quote: 'a phrase that is not in the article', body: CLEAN_BODY };
  };
  const r = await draftPitch({ prospect: PROSPECT, articleText: ARTICLE, factSheet: 'facts', generate, postalAddress: ADDRESS, contact: CONTACT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fabricated-opener/);
  assert.equal(calls, 2);
  assert.match(prompts[1], /does not appear in the article/);
});

test('an antiperspirant claim on attempt 1 is regenerated and passes on attempt 2', async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    if (calls === 1) {
      return JSON.stringify({
        subject: 'Samples for your roundup',
        opener_quote: 'felt like nothing at all',
        body: 'Loved the "felt like nothing at all" line. Try our natural antiperspirant. Happy to send samples.',
      });
    }
    return '```json\n' + JSON.stringify({ subject: 'Samples for your lotion roundup', opener_quote: 'felt like nothing at all', body: CLEAN_BODY }) + '\n```';
  };
  const r = await draftPitch({ prospect: PROSPECT, articleText: ARTICLE, factSheet: 'facts', generate, postalAddress: ADDRESS, contact: CONTACT });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(r.draft.openerQuote, 'felt like nothing at all');
  assert.deepEqual(r.draft.products, ['lotion']);
});

test('final text greets, strips dashes, and ends with opt-out then signature', async () => {
  const generate = async () => ({
    subject: 'Samples — lotion roundup',
    opener_quote: 'felt like nothing at all',
    body: 'Your "felt like nothing at all" line stuck with me — our lotion is simple. Happy to send samples.',
  });
  const r = await draftPitch({ prospect: PROSPECT, articleText: ARTICLE, factSheet: 'facts', generate, postalAddress: ADDRESS, contact: CONTACT });
  assert.equal(r.ok, true, r.reason);
  const { text, subject } = r.draft;
  assert.ok(text.startsWith('Hi Jane,\n\n'));
  assert.ok(text.endsWith(OPT_OUT_LINE + '\n\n' + signature(ADDRESS)));
  assert.doesNotMatch(text, /[—–]/);
  assert.doesNotMatch(subject, /[—–]/);
});

test('a draft failing the outgoing-copy check is refused with a reason', async () => {
  const long = Array.from({ length: 160 }, () => 'word').join(' ');
  const generate = async () => ({ subject: 'Samples', opener_quote: 'felt like nothing at all', body: long });
  const r = await draftPitch({ prospect: PROSPECT, articleText: ARTICLE, factSheet: 'facts', generate, postalAddress: ADDRESS, contact: CONTACT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /over 150 words/);
});

test('buildFactSheet uses no word absent from its inputs (beyond its fixed labels)', () => {
  const sheet = buildFactSheet(INGREDIENTS, CATALOG, BRAND_KIT);
  const allowed = new Set([
    ...words(JSON.stringify(INGREDIENTS)),
    ...words(JSON.stringify(CATALOG)),
    ...words(JSON.stringify(BRAND_KIT)),
    ...FACT_SHEET_LABEL_WORDS,
    // The ingredient count is derived from the input list, by design.
    ...Object.values(INGREDIENTS).map((c) => String(c.base_ingredients.length)),
  ]);
  const stray = words(sheet).filter((w) => !allowed.has(w));
  assert.deepEqual(stray, []);
  assert.match(sheet, /Body Lotion/);
  assert.match(sheet, /3 base ingredients: spring water, coconut oil, jojoba/);
  assert.match(sheet, /1 base ingredient: saponified coconut oil/);
  assert.match(sheet, /Pure Unscented, Rose Petal/);
  assert.match(sheet, /\$20/);
  assert.match(sheet, /https:\/\/example\.com\/products\/test-lotion/);
  assert.match(sheet, /handmade in small batches, made in the USA/);
  assert.doesNotMatch(sheet, /family/i);
});

test('buildFactSheet skips a product missing from the config and tolerates a missing catalog entry', () => {
  const sheet = buildFactSheet(INGREDIENTS, { products: {} }, {});
  assert.match(sheet, /Bar Soap/);
  assert.doesNotMatch(sheet, /undefined|null/);
  assert.doesNotMatch(sheet, /Deodorant/);
});

test('pickProducts matches prompts and angle, caps at 2, defaults to lotion and soap', () => {
  assert.deepEqual(pickProducts({ prompts: ['best natural deodorant for women'], angle: null }), ['deodorant']);
  assert.deepEqual(pickProducts({ prompts: ['best foaming hand soap'], angle: null }), ['hand-soap']);
  assert.deepEqual(pickProducts({ prompts: ['fluoride free toothpaste', 'tinted lip balm', 'body cream'], angle: null }).length, 2);
  assert.deepEqual(pickProducts({ prompts: [], angle: 'pitch our moisturizer' }), ['body-cream']);
  assert.deepEqual(pickProducts({ prompts: [], angle: null }), ['lotion', 'soap']);
  assert.deepEqual(pickProducts({}), ['lotion', 'soap']);
});

test('pitchPrompt carries the rules, the article, and the link-gap ask', () => {
  const p = pitchPrompt({ prospect: PROSPECT, articleText: ARTICLE, factSheet: 'FACT SHEET HERE', products: ['lotion'] });
  assert.match(p, /opener_quote/);
  assert.match(p, /FACT SHEET HERE/);
  assert.match(p, /felt like nothing at all/);
  assert.match(p, /120 words/);
  assert.match(p, /antiperspirant/i);
  assert.match(p, /COSMETIC COMPLIANCE/);
  assert.match(p, /samples/i);
  const lg = pitchPrompt({
    prospect: { ...PROSPECT, source: 'link-gap', competitors: ['brand-a.example', 'brand-b.example'] },
    articleText: ARTICLE, factSheet: 'f', products: ['lotion'],
  });
  assert.match(lg, /brand-a\.example, brand-b\.example/);
  assert.match(lg, /https:\/\/example\.com\/best-lotions/);
});
