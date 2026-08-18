// tests/lib/giveaway-cohort.test.js
// The whole point of this module is a denominator that does not lie early in a
// campaign, so most of these tests are about WHO is counted, not the arithmetic.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeEntryPurchaseCohort, entryValue } from '../../lib/giveaway/cohort.js';

const NOW = new Date('2026-12-01T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const entrant = (email, enteredDaysAgo) => ({ email, properties: { gv_entered_at: daysAgo(enteredDaysAgo) } });
const order = (email, atDaysAgo, total, extra = {}) => ({
  id: Math.floor(Math.random() * 1e9), email, created_at: daysAgo(atDaysAgo),
  total_price: String(total), source_name: 'web', landing_site: '/', ...extra,
});

test('an entrant whose window has not elapsed is excluded from that window entirely', async () => {
  // The trap: counting them as a non-purchaser drives the rate toward zero
  // exactly when the data cannot say anything yet.
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 5)], [], { now: NOW });
  assert.equal(c.windows[30].matured, 0, 'a 5-day-old entrant is not a 30-day data point');
  assert.equal(c.windows[30].rate, null, 'no rate is reported rather than a misleading 0%');
  assert.match(c.windows[30].note, /not .*30 days old|no entrant is 30 days old yet/);
});

test('a matured entrant who did not buy IS counted — that is a real zero', async () => {
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 45)], [], { now: NOW });
  assert.equal(c.windows[30].matured, 1);
  assert.equal(c.windows[30].purchasers, 0);
  assert.equal(c.windows[30].rate, 0, 'a matured non-buyer is a genuine 0%, not a null');
});

test('a purchase inside the window counts; the same purchase outside it does not', async () => {
  const entered = entrant('a@b.com', 90);
  // Bought on day 40 after entry: inside 60d and 90d, outside 30d.
  const o = [order('a@b.com', 50, 40)];
  const c = computeEntryPurchaseCohort([entered], o, { now: NOW });
  assert.equal(c.windows[30].purchasers, 0, 'day-40 purchase is not a 30-day conversion');
  assert.equal(c.windows[60].purchasers, 1);
  assert.equal(c.windows[90].purchasers, 1);
  assert.equal(c.windows[60].revenue, 40);
});

test('a purchase BEFORE entry never counts — an existing customer who enters is not a conversion', async () => {
  // Otherwise every existing customer who enters the giveaway reads as an
  // instant win and the rate becomes a measure of the current list, not the ad.
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 40)], [order('a@b.com', 60, 99)], { now: NOW });
  assert.equal(c.windows[30].purchasers, 0);
  assert.equal(c.sinceEntry.purchasers, 0);
  assert.equal(c.sinceEntry.revenue, 0);
});

test('multiple orders from one entrant are one purchaser but all the revenue', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('a@b.com', 40)],
    [order('a@b.com', 30, 25), order('a@b.com', 20, 35)],
    { now: NOW },
  );
  assert.equal(c.windows[30].purchasers, 1, 'a person converts once');
  assert.equal(c.windows[30].revenue, 60, 'but every dollar counts');
  assert.equal(c.windows[30].revenuePerEntrant, 60);
});

test('emails are matched case- and whitespace-insensitively', async () => {
  const c = computeEntryPurchaseCohort(
    [{ email: ' A@B.com ', properties: { gv_entered_at: daysAgo(40) } }],
    [order('a@b.COM', 30, 50)],
    { now: NOW },
  );
  assert.equal(c.windows[30].purchasers, 1, 'a case mismatch must not read as a non-conversion');
});

test('an entrant with no gv_entered_at is reported separately, never as a non-purchaser', async () => {
  // Silently folding these into the denominator would understate the rate with
  // no visible reason.
  const c = computeEntryPurchaseCohort(
    [{ email: 'old@b.com', properties: {} }, entrant('new@b.com', 40)],
    [],
    { now: NOW },
  );
  assert.equal(c.entrantsUndated, 1);
  assert.equal(c.entrantsDated, 1);
  assert.equal(c.windows[30].matured, 1, 'only the dated entrant is in the denominator');
});

test('orders with no email or an unparseable date are counted as unjoinable, not dropped silently', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('a@b.com', 40)],
    [{ created_at: daysAgo(30), total_price: '10' }, { email: 'a@b.com', created_at: 'nonsense', total_price: '10' }],
    { now: NOW },
  );
  assert.equal(c.unjoinableOrders, 2, 'the count is visible so a broken join cannot hide');
  assert.equal(c.windows[30].purchasers, 0);
});

test('rates are percentages and revenue-per-entrant divides by the MATURED denominator', async () => {
  const profiles = [entrant('a@b.com', 40), entrant('b@b.com', 40), entrant('c@b.com', 5)];
  const c = computeEntryPurchaseCohort(profiles, [order('a@b.com', 30, 100)], { now: NOW });
  assert.equal(c.windows[30].matured, 2, 'the 5-day-old entrant is excluded');
  assert.equal(c.windows[30].rate, 50, '1 of 2 matured');
  assert.equal(c.windows[30].revenuePerEntrant, 50, '100 over 2 matured, not over 3 entrants');
});

test('entryValue prefers the widest matured window and says which basis it used', async () => {
  const profiles = [entrant('a@b.com', 100), entrant('b@b.com', 100)];
  const c = computeEntryPurchaseCohort(profiles, [order('a@b.com', 20, 80)], { now: NOW });
  const v = entryValue(c, { segment: 'blended' });
  assert.equal(v.basis, '90d', 'the widest matured window is the most complete picture');
  assert.equal(v.value, 40, '80 over 2 matured entrants');
});

test('entryValue falls back to since-entry when nothing has matured, and labels it', async () => {
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 3)], [order('a@b.com', 1, 20)], { now: NOW });
  const v = entryValue(c, { segment: 'blended' });
  assert.match(v.basis, /no window matured/, 'the caller must not mistake this for a 90-day figure');
  assert.equal(v.value, 20);
});

test('an empty campaign returns nulls rather than NaN or 0%', async () => {
  const c = computeEntryPurchaseCohort([], [], { now: NOW });
  assert.equal(c.sinceEntry.rate, null);
  assert.equal(c.windows[30].rate, null);
  assert.equal(c.windows[90].revenuePerEntrant, null);
});


// ── existing customers ───────────────────────────────────────────────────────
// A giveaway advertised to a warm audience always pulls in people who have
// already bought. They repurchase at the brand's ~18-22.5% baseline whether or
// not they saw the ad, so blending them inflates the rate and corrupts CAC —
// paying to "acquire" an existing customer is not acquisition.

test('an entrant with a prior order is segmented as existing, not new', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('old@b.com', 40), entrant('fresh@b.com', 40)],
    [order('old@b.com', 200, 50)],
    { now: NOW },
  );
  assert.equal(c.segments.existing.entrants, 1);
  assert.equal(c.segments.new.entrants, 1);
});

test('the blended rate hides what the segments show — this is the whole point', async () => {
  // Existing customer buys after entering (they were going to anyway); the new
  // entrant does not. Blended reads 50%; acquisition is actually 0%.
  const c = computeEntryPurchaseCohort(
    [entrant('old@b.com', 40), entrant('fresh@b.com', 40)],
    [order('old@b.com', 200, 50), order('old@b.com', 20, 60)],
    { now: NOW },
  );
  assert.equal(c.windows[30].rate, 50, 'blended looks like a 50% conversion rate');
  assert.equal(c.segments.new.windows[30].rate, 0, 'but nobody NEW converted');
  assert.equal(c.segments.existing.windows[30].rate, 100);
});

test('entryValue defaults to the NEW segment, because that is what sets a CAC ceiling', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('old@b.com', 40), entrant('fresh@b.com', 40)],
    [order('old@b.com', 200, 50), order('old@b.com', 20, 60)],
    { now: NOW },
  );
  assert.equal(entryValue(c).segment, 'new');
  assert.equal(entryValue(c).value, 0, 'a returning buyer must not inflate the acquisition value');
  assert.equal(entryValue(c, { segment: 'blended' }).value, 30, '60 over 2 blended entrants');
});

test('a prior order beyond the lookback does not mark someone existing, and the bound is published', async () => {
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 1)], [order('a@b.com', 900, 40)], { now: NOW });
  assert.equal(c.segments.existing.entrants, 0, '900 days is past the 730-day lookback');
  assert.equal(c.segments.new.entrants, 1);
  assert.equal(c.priorLookbackDays, 730, 'the boundary must never be invisible');
});

// ── junk orders ──────────────────────────────────────────────────────────────
// Raw Shopify orders include admin previews, TEST-discount orders, cancellations
// and $0 orders. lib/order-attribution.js states counting them is never allowed.

test('a cancelled order is not a conversion', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('a@b.com', 40)],
    [order('a@b.com', 30, 50, { cancelled_at: daysAgo(29) })],
    { now: NOW },
  );
  assert.equal(c.windows[30].purchasers, 0);
  assert.equal(c.excludedJunkOrders, 1, 'excluded visibly, not silently');
});

test('a $0 order is not a conversion', async () => {
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 40)], [order('a@b.com', 30, 0)], { now: NOW });
  assert.equal(c.windows[30].purchasers, 0);
  assert.equal(c.excludedJunkOrders, 1);
});

test('an admin-preview order is not a conversion', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('a@b.com', 40)],
    [order('a@b.com', 30, 50, { landing_site: '/online_store_preview?x=1' })],
    { now: NOW },
  );
  assert.equal(c.windows[30].purchasers, 0);
  assert.equal(c.excludedJunkOrders, 1);
});

test('a junk order before entry does not make someone an existing customer either', async () => {
  const c = computeEntryPurchaseCohort(
    [entrant('a@b.com', 40)],
    [order('a@b.com', 200, 0)],
    { now: NOW },
  );
  assert.equal(c.segments.existing.entrants, 0, 'a $0 order is not a purchase history');
  assert.equal(c.segments.new.entrants, 1);
});

test('contact_email and customer.email are joined when the top-level email is absent', async () => {
  const base = order('x@b.com', 30, 40);
  delete base.email;
  base.contact_email = 'a@b.com';
  const c = computeEntryPurchaseCohort([entrant('a@b.com', 40)], [base], { now: NOW });
  assert.equal(c.windows[30].purchasers, 1, 'Shopify does not always populate the top-level email');
});
