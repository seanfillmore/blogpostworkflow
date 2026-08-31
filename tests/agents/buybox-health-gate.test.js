// tests/agents/buybox-health-gate.test.js
//
// THE BUY BOX IS A REGULATED SURFACE AND WAS THE ONLY UNGATED ONE LEFT.
//
// `agents/featured-product-injector` writes a product card into live article
// `body_html`, directly above an Add-to-Cart button, and imported no health
// gate at all. Two of its three copy fields are attacker-shaped — not in the
// security sense, but in the sense that their content is decided at run time by
// something nobody reviews:
//
//   1. THE REVIEW QUOTE is whatever Judge.me's `fetchTopReview` returns for that
//      product at that moment. It is a VERBATIM CUSTOMER SENTENCE. This is
//      exactly the 2026-08-16 incident, which CLAUDE.md records: a correctly-
//      sourced Judge.me quote ("tried prescription strength lotions,
//      steroids... to no avail. Until Real Skin Care") passed claim-sourcing and
//      still had to be stopped, because the FTC holds an advertiser responsible
//      for what an endorsement CONVEYS and the FDA reads testimonials as
//      evidence of intended use. `selectQuotableReviews` was built for that and
//      wired only into ad-studio.
//
//   2. THE CTA HEADLINE is `Our pick for ${target_keyword}: ${product}` —
//      the keyword verbatim. A post targeting "body lotion for eczema" ships a
//      disease name above the buy button.
//
// MEASURED LIVE 2026-08-31, read-only, before this change: 188 live articles,
// 162 with a buy box, 149 with a review quote, only 8 DISTINCT quotes (the top
// review is reused across every page featuring that product — one toothpaste
// quote sits on 40 pages). All 8 were clean, and the single blocking headline on
// the site ("Our pick for body lotion for eczema") was on a DRAFT that 404s.
//
// So live exposure was ZERO and this gate is preventative. That is the whole
// reason to build it now rather than after: the amplification is ~40 live pages
// per bad review, applied unattended by cron, with no human in the loop.
//
// WHY THE SEO TIER AND NOT `hasHealthClaim`. `selectQuotableReviews` uses the AD
// gate, which blocks the whole `toxicity` vocabulary. CLAUDE.md is explicit that
// reusing it on SEO surfaces is the over-correction: "non-toxic" and "free from
// harmful chemicals" are this brand's central content position, and real
// customer reviews say exactly that. The buy box is blog copy on a live page, so
// it takes the SEO split — BLOCKING categories only (disease, drug, therapeutic,
// systemic-absorption, substantiation, product-category), advisory ignored.
//
// FAILURE DIRECTION: DEGRADE, NEVER REFUSE. A blocked quote falls through to the
// next 5-star review; a blocked headline falls back to a keyword-free form; a
// blocked button falls back to "Add to Cart". Only if every fallback also fails
// is the field omitted — and the buy box, price and Add-to-Cart link always
// ship. Stripping the buy box off a page that has traffic would be a worse
// outcome than the inaccuracy, by the Prime Directive; this is the same call
// `sanitizeProductCategoryTerm` (Arm B) already makes on this exact line.

import { strict as assert } from 'assert';
import { test } from 'node:test';

import { buildCtaCopy } from '../../agents/featured-product-injector/index.js';
import { fetchTopReview } from '../../lib/judgeme.js';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const isQuotable = (q) => checkSeoCopyFields({ 'review quote': q }).ok;

// ── the CTA headline ─────────────────────────────────────────────────────────

test('a clean keyword still produces the ordinary headline', () => {
  const { headline, buttonText } = buildCtaCopy({
    product: { title: 'Coconut Body Lotion' },
    keyword: 'best natural body lotion',
  });
  assert.equal(headline, 'Our pick for best natural body lotion: Coconut Body Lotion');
  assert.equal(buttonText, 'Shop Coconut Body Lotion');
});

test('a disease keyword falls back to a keyword-free headline, keeping the buy box', () => {
  // The real live case: /blogs/news/best-body-lotion-for-eczema-... targets
  // "body lotion for eczema". The product is still named and still linked.
  const { headline } = buildCtaCopy({
    product: { title: 'Coconut Body Lotion' },
    keyword: 'body lotion for eczema',
  });
  assert.equal(headline, 'Our pick: Coconut Body Lotion');
  assert.ok(checkSeoCopyFields({ headline }).ok, 'the fallback must itself be clean');
});

test('a product TITLE carrying a claim omits the headline rather than shipping it', () => {
  // The catalogue really has one: the "cut-and-scrape" product is titled
  // "Natural Wound Care ... Heal every cut and scrape". The keyword-free
  // fallback still contains the title, so it cannot rescue this case.
  const { headline, buttonText } = buildCtaCopy({
    product: { title: 'Natural Wound Care That Heals' },
    keyword: 'best natural balm',
  });
  assert.equal(headline, null, 'no headline is correct when the product name itself is the claim');
  assert.equal(buttonText, 'Add to Cart', 'the button falls back rather than repeating the claim');
});

test('the buy box never loses its call to action', () => {
  for (const kw of ['body lotion for eczema', 'lotion that heals', 'best natural body lotion']) {
    const { buttonText } = buildCtaCopy({ product: { title: 'Coconut Body Lotion' }, keyword: kw });
    assert.ok(buttonText && buttonText.length > 0, `empty button for ${kw}`);
  }
});

test('a missing product degrades exactly as it did before', () => {
  const { headline } = buildCtaCopy({ product: null, keyword: 'natural lotion' });
  assert.equal(headline, 'Our pick for natural lotion: this pick');
});

// ── the review quote ─────────────────────────────────────────────────────────

/** Minimal Judge.me stub: one product, a fixed review list, no network. */
function stubFetch(reviews) {
  return async (url) => {
    const u = String(url);
    // resolveExternalId reads `data.product.external_id` — singular, and the
    // external id, not the Judge.me row id.
    if (u.includes('/products')) {
      return { ok: true, json: async () => ({ product: { external_id: 7 } }) };
    }
    return { ok: true, json: async () => ({ reviews }) };
  };
}

// renderReviewBody drops anything under 20 WORDS, so fixtures have to be
// realistic length or they all return null and every assertion here passes for
// the wrong reason — which is exactly what the first draft of this file did.
const R = (body, rating = 5) => ({ rating, body, product_external_id: 7, reviewer: { verified_buyer: true } });

const PAD = 'I have been using it every single day for a couple of months now and I am very happy with it.';

test('a review carrying a disease claim is skipped for the next clean one', async () => {
  const reviews = [
    R(`This cleared up my eczema completely after years of steroid creams. ${PAD}`),
    R(`Soft and hydrated skin, exactly what I wanted from this one. ${PAD}`),
  ];
  const got = await fetchTopReview('coconut-lotion', 'shop', 'tok', {
    isQuotable,
    fetchImpl: stubFetch(reviews),
  });
  assert.ok(got, 'a clean review exists and must be used');
  assert.match(got.quote, /Soft and hydrated/);
});

test('no clean review means NO quote, never a claim', async () => {
  const reviews = [
    R(`Cured my dermatitis in under a week, nothing else ever came close. ${PAD}`),
    R(`Better than the prescription cream my own doctor gave me last year. ${PAD}`),
  ];
  const got = await fetchTopReview('coconut-lotion', 'shop', 'tok', {
    isQuotable,
    fetchImpl: stubFetch(reviews),
  });
  assert.equal(got, null, 'omitting the quote is correct; buildFeaturedProductHtml renders no quote block');
});

test('the brand position survives — "non-toxic" is advisory, not blocking', () => {
  // The whole reason this uses the SEO tier rather than the ad gate. Reusing
  // `hasHealthClaim` here would reject the reviews that best match this brand.
  const quote = 'Finally a non-toxic lotion free from harmful chemicals.';
  assert.ok(isQuotable(quote), 'toxicity language must NOT block a buy-box quote');
});

test('without a screen, behaviour is byte-identical to before (existing callers unaffected)', async () => {
  const reviews = [
    R(`Cured my dermatitis in under a week, nothing else ever came close. ${PAD}`),
    R(`Soft skin and a lovely light scent that does not linger too long. ${PAD}`),
  ];
  const got = await fetchTopReview('coconut-lotion', 'shop', 'tok', { fetchImpl: stubFetch(reviews) });
  assert.match(got.quote, /Cured my dermatitis/, 'the default must not silently start filtering');
});

test('a non-5-star review is still never quoted, screen or not', async () => {
  const reviews = [
    R(`Soft skin and lovely texture, though the pump can be a little stiff. ${PAD}`, 4),
    R(`Great lotion, very hydrating, and it absorbs without leaving me greasy. ${PAD}`, 5),
  ];
  const got = await fetchTopReview('coconut-lotion', 'shop', 'tok', {
    isQuotable,
    fetchImpl: stubFetch(reviews),
  });
  assert.match(got.quote, /Great lotion/);
});
