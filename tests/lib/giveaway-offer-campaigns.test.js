// tests/lib/giveaway-offer-campaigns.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFER_SENDS, checkOfferEmail, sendTimeFor } from '../../lib/giveaway/offer-campaigns.js';
import { OPENS_AT, CLOSES_AT, totalBars } from '../../lib/giveaway/consolation-offer.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'giveaway', 'nurture');
const read = (f) => readFileSync(join(DIR, f), 'utf8');

test('all three shipped offer emails pass every gate', () => {
  for (const send of OFFER_SENDS) {
    assert.deepEqual(checkOfferEmail(read(send.file)), [], `${send.file} must pass`);
  }
});

test('REGRESSION: a cart link preloading 6 bars is rejected', () => {
  // The single most expensive way this email can be wrong: a BXGY marks 6 of 12
  // free, it does not ADD the free six. A cart holding 6 shows $66 with no
  // discount and reads as a broken offer to 450 people at once.
  const broken = read('10-offer-drawday.html').replace(':12?discount=', ':6?discount=');
  const problems = checkOfferEmail(broken);
  assert.ok(problems.some((p) => /preloads 6 bars/.test(p)), problems.join('; '));
});

test('a wrong or missing discount code is rejected', () => {
  const wrong = read('10-offer-drawday.html').replace('discount=GIVEAWAY6X6', 'discount=SUMMER10');
  assert.ok(checkOfferEmail(wrong).some((p) => /carries discount SUMMER10/.test(p)));

  const none = read('10-offer-drawday.html').replace(/\/cart\/\d+:\d+\?discount=[A-Za-z0-9_-]+/g, '/collections/all');
  assert.ok(checkOfferEmail(none).some((p) => /cannot sell anything/.test(p)));
});

test('a link to the wrong variant is rejected', () => {
  const wrong = read('10-offer-drawday.html').replace('45828179951786:12', '44179485655210:12');
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
  const base = read('10-offer-drawday.html');
  const stripped = base
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

test('the offer quantity is sourced from one place', () => {
  // If totalBars() ever changes, the gate and the emails must move together —
  // this asserts the gate reads the shared constant rather than a literal 12.
  assert.equal(totalBars(), 12);
  const broken = read('10-offer-drawday.html').replace(':12?discount=', ':11?discount=');
  assert.ok(checkOfferEmail(broken).some((p) => new RegExp(`expected ${totalBars()}`).test(p)));
});
