import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingSubmissions, renderCreatorReviewSection } from '../../lib/digest-creator-review.js';

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Shape of the real 2026-10-04 trybe-review body, shortened.
const BODY = `Awaiting your response (2):
  - Creator A · image · Moisturizing Coconut Soap | 3.4oz (a5341de3)
      Visual: LOOKS READY. The bar matches the reference.
      Image text: "Gentle enough for every day"
      Preview: https://cdn.example.com/a.jpg
  - Creator A · image · Non-Toxic Body Lotion (9f533fb1)
      Visual: NEEDS CHANGES. Wrong product shown.
      · packaging: A jar, but the reference is a flip-cap bottle.
      Suggested note: "Please swap the jar for the real bottle."
      Preview: https://cdn.example.com/b.jpg

Creators: 40 on the roster, 5 active.`;
const row = (ts, body, subject = 'Trybe creators: 2 awaiting review') => ({ ts, status: 'info', subject, body, category: 'creators' });

test('parses one card per submission and stops at the end of the block', () => {
  const { items } = awaitingSubmissions([row('2026-10-04T12:55:00Z', BODY)]);
  assert.equal(items.length, 2);
  assert.match(items[1].title, /Non-Toxic Body Lotion/);
  assert.equal(items[1].lines.length, 4);
  assert.ok(!items.flatMap((i) => i.lines).some((l) => /roster/.test(l)));
});

test('the NEWEST trybe-review row wins', () => {
  const older = row('2026-10-03T12:55:00Z', 'Awaiting your response (1):\n  - Old one\n      Visual: LOOKS READY. x.');
  const { items } = awaitingSubmissions([row('2026-10-04T12:55:00Z', BODY), older]);
  assert.equal(items.length, 2);
});

test('renders verdicts, the paste-ready note and a preview link; counts only NEEDS CHANGES', () => {
  const html = renderCreatorReviewSection([row('2026-10-04T12:55:00Z', BODY)], esc);
  assert.match(html, /Creator submissions to review &mdash; 2 waiting, 1 need changes/);
  assert.match(html, /<a href="https:\/\/cdn\.example\.com\/b\.jpg">view<\/a>/);
  assert.match(html, /Please swap the jar/);
});

test('nothing awaiting, or no trybe row, renders nothing', () => {
  assert.equal(renderCreatorReviewSection([row('2026-10-04T12:55:00Z', 'Creators: 40 on the roster.')], esc), '');
  assert.equal(renderCreatorReviewSection([{ ts: 'x', subject: 'Other agent', body: BODY }], esc), '');
});
