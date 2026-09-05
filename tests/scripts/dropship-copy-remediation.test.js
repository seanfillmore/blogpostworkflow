import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN,
  classifyEntry,
  applyEntry,
  gatePlan,
  decodeBasicEntities,
} from '../../scripts/remediate-dropship-era-shipping-copy.js';

const byId = (id) => PLAN.find((e) => e.id === id);

test('every entry carries a measured basis — a rewrite may never ride along on nothing', () => {
  for (const e of PLAN) {
    assert.ok(e.basis && e.basis.length > 40, `${e.id} has no basis`);
    assert.notEqual(e.before, e.after, `${e.id}: BEFORE and AFTER are identical`);
  }
});

test('every AFTER passes the SEO-copy health gate', () => {
  assert.equal(gatePlan(PLAN).ok, true, JSON.stringify(gatePlan(PLAN).failures));
});

test('no AFTER reintroduces a claim the orders disprove', () => {
  const banned = [
    /\b1[45]\s*(to|-)\s*2[15]\b/i, // "14 to 21" / "15-21" / "15-25" day windows
    /\b3\s*(to|-)\s*5\s*(working|business)\s*days\b/i,
    /\b4-7\s*days\b/i,
    /DHL/i,
    /fulfillment centers/i,
    /home beautiful/i,
    /team@realskincare/i, // the address no other live page uses
  ];
  for (const e of PLAN) {
    for (const re of banned) {
      assert.equal(re.test(e.after), false, `${e.id} AFTER still matches ${re}`);
    }
  }
});

test('the shipping-policy BEFORE keeps its non-breaking space', () => {
  // Sourced as an explicit  . Transcribing it as a plain space is what made the
  // first dry run report drift, and a later editor "cleaning up whitespace" would do
  // it again silently — at which point the entry can never match and never applies.
  const before = byId('shipping-policy-whole-body').before;
  assert.equal(before.charCodeAt(67), 0x00a0);
  assert.equal(/All orders are shipped within 3 to 5/.test(before), true);
});

test('no AFTER emits an HTML entity Shopify would decode on the way in', () => {
  // Shopify stores the decoded character, so an entity in the AFTER guarantees the
  // stored value never equals the literal and every later run reads as drift.
  for (const e of PLAN) {
    assert.equal(/&(ndash|mdash|rsquo|nbsp);/.test(e.after), false, `${e.id} emits an entity`);
  }
});

test('apply is byte-exact; already-applied tolerates entity decoding', () => {
  const e = byId('shipping-policy-whole-body');
  assert.equal(classifyEntry(e.before, e).action, 'apply');
  assert.equal(classifyEntry(e.after, e).action, 'already-applied');
  // What Shopify actually hands back: entities decoded.
  assert.equal(classifyEntry(decodeBasicEntities(e.after), e).action, 'already-applied');
  // A near-miss must NOT apply — one changed word means somebody edited the page.
  assert.equal(classifyEntry(e.before.replace('All orders', 'Most orders'), e).action, 'drift');
});

test('a hand-edited page is skipped, never overwritten', () => {
  for (const e of PLAN) {
    assert.equal(classifyEntry('<p>somebody rewrote this by hand</p>', e).action, 'drift');
    assert.equal(classifyEntry('', e).action, 'drift');
  }
});

test('the track-order edit preserves the AfterShip widget', () => {
  // A whole-body replacement there would silently delete a working tracking widget,
  // which is why that one entry is a substring edit.
  const e = byId('track-order-tracking-lag');
  assert.equal(e.kind, 'substring');
  const live =
    `<p>${e.before} Please insert your tracking number here.</p>\n` +
    '<div id="as-root"></div>\n<script>button.aftership.com</script>\n' +
    '<div class="as-track-button" data-domain="track.aftership.com"></div>';
  const next = applyEntry(live, e);
  assert.ok(next.includes('button.aftership.com'));
  assert.ok(next.includes('as-track-button'));
  assert.ok(next.includes(e.after));
  assert.equal(next.includes(e.before), false);
});

test('the FAQ AFTER defers on return shipping cost rather than inventing a promise', () => {
  // The live FAQ said "at your own expense"; the refund policy says "no questions
  // asked" and is silent on cost. We cannot measure which is true, so the FAQ points
  // at the policy page and asserts nothing — deliberately, not by omission.
  const after = byId('faq-whole-body').after;
  assert.equal(/your own expense/i.test(after), false);
  assert.equal(/free returns?/i.test(after), false);
  assert.ok(after.includes('/pages/refund-policy-1'));
});
