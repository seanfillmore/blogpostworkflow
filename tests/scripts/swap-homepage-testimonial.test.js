import test from 'node:test';
import assert from 'node:assert/strict';

import {
  swapTestimonial, REPLACEMENT, OLD_QUOTE, OLD_ATTR, NEW_QUOTE, NEW_ATTR, SECTION, FIELD,
} from '../../scripts/swap-homepage-testimonial.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../../agents/ad-studio/health-claims.js';

const STYLE = '<style>.rsc-testimonial{background:#eef3e8}</style>';
const COUNTS = '<p class="rsc-testimonial__count">380+ verified reviews · 290+ five-star ratings</p>';
const LINK = '<a class="rsc-testimonial__link" href="https://judge.me/reviews/stores/realskincare-com">Read more reviews →</a>';

const markup = (quote, attr) => `${STYLE}<div class="rsc-testimonial"><div class="rsc-testimonial__inner">${COUNTS}`
  + `<p class="rsc-testimonial__quote">${quote}</p><p class="rsc-testimonial__attr">${attr}</p>${LINK}</div></div>`;

const templateWith = (m) => ({ sections: { [SECTION]: { type: 'custom-liquid', settings: { [FIELD]: m } } } });
const liveTemplate = () => templateWith(markup(OLD_QUOTE, OLD_ATTR));
const fieldOf = (t) => t.sections[SECTION].settings[FIELD];

test('the OLD quote genuinely trips both gates — this swap was necessary', () => {
  const plain = OLD_QUOTE.replace(/&[lr]dquo;/g, '"');
  const g = checkSeoCopyFields({ testimonial: plain });
  assert.equal(g.ok, false);
  const cats = new Set(g.blocking.map((v) => v.category));
  assert.ok(cats.has('disease'), 'expected disease (eczema)');
  assert.ok(cats.has('drug'), 'expected drug (prescription/steroids)');
  assert.ok(hasHealthClaim(plain), 'ad-studio gate should also reject it');
});

test('the replacement passes both gates', () => {
  assert.equal(checkSeoCopyFields({ testimonial: REPLACEMENT.body }).ok, true);
  assert.equal(hasHealthClaim(REPLACEMENT.body), false);
});

test('the replacement carries no disease, drug or condition vocabulary', () => {
  for (const word of ['eczema', 'steroid', 'prescription', 'OTC', 'cure', 'heal', 'treat']) {
    assert.doesNotMatch(REPLACEMENT.body, new RegExp(word, 'i'), `should not contain "${word}"`);
  }
});

test('the quote is used VERBATIM — the endorsement is not edited', () => {
  // An advertiser may not put words in an endorser's mouth. NEW_QUOTE must be
  // the review body plus typographic quote entities and nothing else.
  assert.equal(NEW_QUOTE, `&ldquo;${REPLACEMENT.body}&rdquo;`);
  assert.equal(NEW_QUOTE.replace(/&[lr]dquo;/g, ''), REPLACEMENT.body);
});

test('provenance is recorded and the review qualifies for a hero slot', () => {
  assert.equal(REPLACEMENT.rating, 5);
  assert.equal(REPLACEMENT.verified, 'verified-purchase');
  assert.ok(Number.isInteger(REPLACEMENT.reviewId));
  assert.match(REPLACEMENT.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('no reviewer PII is carried into the page or the plan', () => {
  const blob = JSON.stringify(REPLACEMENT) + NEW_QUOTE + NEW_ATTR;
  assert.doesNotMatch(blob, /@/, 'no email');
  assert.doesNotMatch(blob, /\b\d{10,}\b/, 'no phone or reviewer id digits run');
  // surname is reduced to an initial, matching the section's existing convention
  assert.doesNotMatch(blob, /Hoopman/);
  assert.match(NEW_ATTR, /^— \w+ \w\., verified customer$/);
});

test('the swap replaces the quote and attribution', () => {
  const { template, changed } = swapTestimonial(liveTemplate());
  assert.equal(changed, true);
  const f = fieldOf(template);
  assert.ok(f.includes(NEW_QUOTE));
  assert.ok(f.includes(NEW_ATTR));
  assert.ok(!f.includes(OLD_QUOTE));
  assert.ok(!f.includes(OLD_ATTR));
});

test('the style block, review counters and reviews link survive byte-identical', () => {
  const { template } = swapTestimonial(liveTemplate());
  const f = fieldOf(template);
  for (const part of [STYLE, COUNTS, LINK]) assert.ok(f.includes(part), `lost: ${part.slice(0, 40)}`);
});

test('re-running is a no-op', () => {
  const once = swapTestimonial(liveTemplate()).template;
  const again = swapTestimonial(once);
  assert.equal(again.changed, false);
  assert.equal(again.why, 'already applied');
  assert.equal(fieldOf(again.template), fieldOf(once));
});

test('markup matching neither BEFORE nor AFTER is SKIPPED, never overwritten', () => {
  const drifted = markup('&ldquo;Someone edited this by hand.&rdquo;', '— Anon');
  const { template, changed, why } = swapTestimonial(templateWith(drifted));
  assert.equal(changed, false);
  assert.equal(why, 'live markup matches neither BEFORE nor AFTER');
  assert.equal(fieldOf(template), drifted);
});

test('a missing section is reported, not thrown', () => {
  const { changed, why } = swapTestimonial({ sections: {} });
  assert.equal(changed, false);
  assert.equal(why, 'section not found');
});

test('the input template is never mutated', () => {
  const input = liveTemplate();
  const snapshot = JSON.stringify(input);
  swapTestimonial(input);
  assert.equal(JSON.stringify(input), snapshot);
});
