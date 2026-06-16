import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHtmlComplete, externalLinksAdded, futureDatesAdded } from '../../lib/html-output-guards.js';

test('throws when the model stopped at max_tokens (truncated output)', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>fine</p>', stopReason: 'max_tokens' }),
    /max_tokens|truncat/i
  );
});

test('throws on an unclosed href attribute (truncated mid-link)', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>see <a href="https://x.com/best', stopReason: 'end_turn' }),
    /href/i
  );
});

test('passes for complete HTML that ended normally', () => {
  assert.doesNotThrow(() =>
    assertHtmlComplete({ html: '<p>see <a href="https://x.com/best">best</a></p>', stopReason: 'end_turn' })
  );
});

test('passes when stopReason is absent and HTML is well-formed', () => {
  assert.doesNotThrow(() => assertHtmlComplete({ html: '<p>hello</p>' }));
});

// ── fabricated-fact guards (content-remediator must not invent citations/dates) ──
const ORIG = '<p>PFAS in cosmetics. <a href="https://www.realskincare.com/x">internal</a></p>';

test('externalLinksAdded flags a newly-introduced off-site citation', () => {
  const rev = ORIG + '<p>See <a href="https://www.fda.gov/dead-404">FDA</a></p>';
  const added = externalLinksAdded(ORIG, rev);
  assert.equal(added.length, 1);
  assert.match(added[0], /fda\.gov/);
});
test('externalLinksAdded ignores unchanged content and added INTERNAL links', () => {
  assert.deepEqual(externalLinksAdded(ORIG, ORIG), []);
  assert.deepEqual(externalLinksAdded(ORIG, ORIG + '<a href="https://www.realskincare.com/y">i2</a>'), []);
});
test('futureDatesAdded flags a same-year future month and a future bare year', () => {
  const now = { year: 2026, month: 6 }; // June 2026
  assert.deepEqual(futureDatesAdded('the report', 'the report (December 2026)', now), ['december 2026']);
  assert.deepEqual(futureDatesAdded('x', 'published 2027', now), ['2027']);
});
test('futureDatesAdded ignores pre-existing, past, and earlier-this-year dates', () => {
  const now = { year: 2026, month: 6 };
  assert.deepEqual(futureDatesAdded('from December 2026', 'from December 2026', now), []); // already present
  assert.deepEqual(futureDatesAdded('x', 'study from March 2025', now), []);               // past
  assert.deepEqual(futureDatesAdded('x', 'in May 2026', now), []);                          // earlier this year
});
