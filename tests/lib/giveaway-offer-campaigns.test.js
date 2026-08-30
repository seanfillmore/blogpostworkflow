// tests/lib/giveaway-offer-campaigns.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFER_SENDS, checkOfferEmail, sendTimeFor } from '../../lib/giveaway/offer-campaigns.js';
import { OPENS_AT, CLOSES_AT, TIERS, ANCHOR_TIER } from '../../lib/giveaway/consolation-offer.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'giveaway', 'nurture');
const read = (f) => readFileSync(join(DIR, f), 'utf8');

test('all three shipped offer emails pass every gate', () => {
  for (const send of OFFER_SENDS) {
    assert.deepEqual(checkOfferEmail(read(send.file)), [], `${send.file} must pass`);
  }
});

test('REGRESSION: a cart link with the WRONG bar count for its code is rejected', () => {
  // The single most expensive way these emails can be wrong, and it is silent:
  // a BXGY discounts min(get, what is left after the prerequisite), so the 9+9
  // code against a 12-bar cart hands over THREE free bars instead of nine. No
  // error, no warning — just a worse offer than the email advertised, to every
  // confirmed entrant at once.
  const broken = read('10-offer-drawday.html').replace(':18?discount=GIVEAWAY9X9', ':12?discount=GIVEAWAY9X9');
  const problems = checkOfferEmail(broken);
  assert.ok(problems.some((p) => /preloads 12 bars, expected 18/.test(p)), problems.join('; '));
});

test('swapping the two tiers\' quantities is rejected in both directions', () => {
  const swapped = read('10-offer-drawday.html')
    .replace(':18?discount=GIVEAWAY9X9', ':12?discount=GIVEAWAY9X9')
    .replace(':12?discount=GIVEAWAY6X6', ':18?discount=GIVEAWAY6X6');
  const problems = checkOfferEmail(swapped);
  assert.equal(problems.filter((p) => /expected (18|12)/.test(p)).length, 2, problems.join('; '));
});

test('an email that drops the anchor tier is rejected', () => {
  // Losing the 9+9 leaves the 6+6 reading as the price rather than the modest
  // option, which is the whole reason the anchor exists.
  const noAnchor = read('10-offer-drawday.html')
    .replace(/https:\/\/www\.realskincare\.com\/cart\/\d+:18\?discount=GIVEAWAY9X9/g, 'https://www.realskincare.com')
    .replace(/\$99/g, '$66');
  const problems = checkOfferEmail(noAnchor);
  assert.ok(problems.some((p) => /no cart link for GIVEAWAY9X9/.test(p)), problems.join('; '));
});

test('an unknown discount code is rejected', () => {
  const wrong = read('10-offer-drawday.html').replace('discount=GIVEAWAY6X6', 'discount=SUMMER10');
  assert.ok(checkOfferEmail(wrong).some((p) => /unknown discount SUMMER10/.test(p)));
});

test('an email with no cart link at all cannot sell anything', () => {
  const none = read('10-offer-drawday.html').replace(/\/cart\/\d+:\d+\?discount=[A-Za-z0-9_-]+/g, '/collections/all');
  assert.ok(checkOfferEmail(none).some((p) => /cannot sell anything/.test(p)));
});

test('a link to the wrong variant is rejected', () => {
  const wrong = read('10-offer-drawday.html').replace('45828179951786:18', '44179485655210:18');
  assert.ok(checkOfferEmail(wrong).some((p) => /points at variant 44179485655210/.test(p)));
});

test('a deadline that drifts from the discount object is rejected', () => {
  const drifted = read('10-offer-drawday.html').replaceAll('September 23, 2026', 'September 30, 2026');
  assert.ok(checkOfferEmail(drifted).some((p) => /deadline/.test(p)));
});

test('compliance lines are each required', () => {
  const base = read('10-offer-drawday.html');
  assert.ok(checkOfferEmail(base.replace(/\{%\s*unsubscribe\s*%\}/, '#')).some((p) => /unsubscribe/.test(p)));
  assert.ok(checkOfferEmail(base.replace(/No purchase necessary/i, 'Buy now')).some((p) => /No-purchase-necessary/.test(p)));
});

test('a sweepstakes email asking for a sale must clarify purchases never earned entries', () => {
  const stripped = read('10-offer-drawday.html')
    .replace(/A purchase did not and does not improve[^<]*/i, 'Enjoy.')
    .replace(/purchases never earned entries\./i, '');
  assert.ok(checkOfferEmail(stripped).some((p) => /purchases did not earn entries/.test(p)));
});

test('the three sends sit inside the offer window, in order', () => {
  const opens = Date.parse(OPENS_AT);
  const closes = Date.parse(CLOSES_AT);
  let prev = -Infinity;
  for (const send of OFFER_SENDS) {
    const t = Date.parse(sendTimeFor(send, OPENS_AT));
    assert.ok(t >= opens, `${send.file} must not send before the offer opens`);
    assert.ok(t < closes, `${send.file} must not send after the offer closes`);
    assert.ok(t > prev, `${send.file} must send after the previous one`);
    prev = t;
  }
});

test('the final send lands the same day the offer closes, so "tonight" is true', () => {
  const final = OFFER_SENDS.at(-1);
  const t = new Date(sendTimeFor(final, OPENS_AT));
  const closes = new Date(CLOSES_AT);
  const hoursBefore = (closes - t) / 3600000;
  assert.ok(hoursBefore > 0 && hoursBefore < 24,
    `final send should be within 24h of close, got ${hoursBefore.toFixed(1)}h`);
});

test('every tier\'s quantity is sourced from the tier, not a literal', () => {
  // If a tier's totalBars changes, the gate and the emails must move together.
  for (const tier of TIERS) {
    const broken = read('10-offer-drawday.html')
      .replace(`:${tier.totalBars}?discount=${tier.code}`, `:${tier.totalBars - 1}?discount=${tier.code}`);
    assert.ok(
      checkOfferEmail(broken).some((p) => new RegExp(`expected ${tier.totalBars}`).test(p)),
      `${tier.code} quantity must be pinned to the tier`,
    );
  }
  assert.equal(ANCHOR_TIER.totalBars, 18);
});

test('every price named in a subject or preview is a real tier price', () => {
  // Subject/preview drift is the same class as deadline drift: the email
  // advertises a number the offer does not honour, and nothing errors. The
  // first version of these sends led with $66 while the page led with the $99
  // anchor, which quietly undoes the anchor before the reader ever opens it.
  const tierPrices = new Set(TIERS.map((t) => `$${t.priceUsd}`));
  for (const send of OFFER_SENDS) {
    for (const field of ['subject', 'preview']) {
      for (const [price] of `${send[field]}`.matchAll(/\$\d+/g)) {
        assert.ok(tierPrices.has(price), `${send.file} ${field} names ${price}, which is not a tier price`);
      }
    }
  }
});

test('the two urgency sends lead with the ANCHOR price', () => {
  // The draw-day send leads with the story ("it wasn't you"), so it names no
  // price. The reminders do name one, and it must be the anchor.
  for (const send of OFFER_SENDS.filter((x) => /\$/.test(x.subject))) {
    assert.match(send.subject, new RegExp(`\\$${ANCHOR_TIER.priceUsd}\\b`),
      `${send.file} subject should lead with the anchor $${ANCHOR_TIER.priceUsd}`);
  }
});
