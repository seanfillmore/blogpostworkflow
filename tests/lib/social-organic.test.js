import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewerDisplayName, quotableReviews, topicCandidates, vocObjections, vocPhrases, organicCopyProblems,
  carouselShapeProblems, carouselFields, currentProducts, carouselSlideHtml, reviewCardHtml, textPostHtml, competitorIn,
} from '../../lib/social-organic.js';

const COMP = [{ name: 'Native', domain: 'nativecos.com' }, { name: 'Piperwai', domain: 'piperwai.com' }];
const PRODUCTS = { 'coconut-lotion': 'Body Lotion', 'coconut-soap': 'Bar Soap' };
const rev = (over = {}) => ({ id: 1, rating: 5, reviewer_name: 'Amanda Kohl', body: 'This lotion soaks in fast and my hands stay soft through the whole workday, even in winter.', product_handle: 'coconut-lotion', published: true, hidden: false, verified: true, created_at: '2026-10-01', ...over });

test('reviewerDisplayName: First L., first name alone, and never anonymous or an email', () => {
  assert.equal(reviewerDisplayName('amanda kohl'), 'Amanda K.');
  assert.equal(reviewerDisplayName('Mary Ann Smith'), 'Mary S.');
  assert.equal(reviewerDisplayName('Jo'), 'Jo');
  assert.equal(reviewerDisplayName('Anonymous'), null);
  assert.equal(reviewerDisplayName('jane@x.com'), null);
  assert.equal(reviewerDisplayName(''), null);
  assert.equal(reviewerDisplayName('J'), null);
});

test('quotableReviews: only published, visible, 5-star, current-product, clean reviews, under the current name', () => {
  const ok = quotableReviews([rev()], { products: PRODUCTS, competitors: COMP });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, 'Amanda K.');
  assert.equal(ok[0].product_title, 'Body Lotion');
  const none = (over) => quotableReviews([rev(over)], { products: PRODUCTS, competitors: COMP }).length;
  assert.equal(none({ hidden: true }), 0, 'hidden reviews are the fakes and wrong-product ones');
  assert.equal(none({ published: false }), 0);
  assert.equal(none({ rating: 4 }), 0);
  assert.equal(none({ product_handle: 'organic-body-lotion' }), 0, 'a product we no longer sell');
  assert.equal(none({ reviewer_name: 'Anonymous' }), 0);
  assert.equal(none({ body: 'Love it!' }), 0, 'too short');
  assert.equal(none({ body: 'It healed my eczema in a week and my skin feels amazing now, truly.' }), 0, 'health claim');
  assert.equal(none({ body: 'Better than Native by a mile, my hands stay soft through the whole workday.' }), 0, 'competitor');
  assert.equal(none({ body: 'Soft hands all day — even through winter, I love this lotion so much.' }), 0, 'dash: quoted verbatim or not at all');
  assert.equal(quotableReviews([rev()], { products: PRODUCTS, usedIds: new Set(['1']) }).length, 0, 'never reused');
});

test('topicCandidates: seeds first, then product question searches by impressions, then objections; never reused', () => {
  const rows = [
    { query: 'how to improve soap making skills', impressions: 900 },
    { query: 'does native deodorant have aluminum', impressions: 500 },
    { query: 'is sls free toothpaste better', impressions: 40 },
    { query: 'is sls free toothpaste better', impressions: 30 },
    { query: 'what toothpaste is sls free', impressions: 50 },
    { query: 'best lotion', impressions: 999 },
  ];
  const t = topicCandidates({ seeds: ['Seed A'], gscRows: rows, vocObjections: ['Coconut oil clogs pores'], used: ['seed a'], competitors: COMP });
  assert.deepEqual(t.map((x) => x.topic), ['is sls free toothpaste better', 'what toothpaste is sls free', 'Coconut oil clogs pores']);
  assert.deepEqual(t.map((x) => x.source), ['search', 'search', 'customer objection']);
});

test('vocObjections / vocPhrases read the voice-of-customer sections', () => {
  const md = '# VOC\n\n## Objections\n\n- **Bar looks small.** — 5\n- **Oils feel greasy.** — 3\n\n## Golden-nugget phrases\n\n- **"soft all day"** — 4\n\n## Trigger points\n\n- **Winter cracks** — 2\n\n## Who we\'re not for\n\n- **x**\n';
  assert.deepEqual(vocObjections(md), ['Bar looks small.', 'Oils feel greasy.']);
  assert.deepEqual(vocPhrases(md), ['"soft all day"', 'Winter cracks']);
});

test('organicCopyProblems: claims, dashes, links, competitors and ungrounded numbers', () => {
  const facts = 'Body Lotion: 94 customer reviews averaging 4.9 stars';
  assert.deepEqual(organicCopyProblems({ caption: 'Soft hands, 94 reviews in. Link in bio.' }, { facts, competitors: COMP }), []);
  const p = organicCopyProblems({ a: 'Heals eczema', b: 'soft — really', c: 'see https://x.co', d: 'unlike Native', e: '12 reasons' }, { facts, competitors: COMP }).join(' | ');
  assert.match(p, /a: claim/);
  assert.match(p, /b: contains an em or en dash/);
  assert.match(p, /c: contains a link/);
  assert.match(p, /d: names a competitor \(Native\)/);
  assert.match(p, /e: the number 12 is not in the facts/);
  assert.equal(competitorIn('our native ingredients', COMP), 'Native', 'whole-word match');
});

test('carouselShapeProblems and carouselFields', () => {
  const d = { slides: [1, 2, 3, 4, 5].map((n) => ({ title: `T${n}`, body: n > 1 ? 'b' : '' })), caption: 'c' };
  assert.deepEqual(carouselShapeProblems(d), []);
  assert.match(carouselShapeProblems({ slides: d.slides.slice(0, 3), caption: 'c' }).join(), /3 slides/);
  assert.deepEqual(Object.keys(carouselFields(d)).slice(0, 3), ['slide 1 title', 'slide 2 title', 'slide 2 body']);
});

test('currentProducts maps press-facts product URLs to names', () => {
  assert.deepEqual(currentProducts({ products: { a: { name: 'Body Lotion', url: 'https://www.realskincare.com/products/coconut-lotion' } } }), { 'coconut-lotion': 'Body Lotion' });
});

test('templates escape text and carry the slide counter', () => {
  assert.match(carouselSlideHtml({ index: 1, total: 6, title: 'A <b>', body: 'x' }), /2\/6/);
  assert.match(carouselSlideHtml({ index: 1, total: 6, title: 'A <b>', body: 'x' }), /A &lt;b&gt;/);
  assert.match(reviewCardHtml({ quote: '"hi"', name: 'Amanda K.', product: 'Body Lotion' }), /on Body Lotion/);
  assert.match(textPostHtml({ text: 'Winter hands' }), /@realskincare_com/);
});
