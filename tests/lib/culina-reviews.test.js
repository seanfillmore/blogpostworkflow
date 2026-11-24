import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReviews } from '../../lib/culina-reviews.js';
import { renderMonthly } from '../../lib/culina-report-render.js';

const raw = {
  A: { positive: [{ topic: 'Ease Of Use', mentions: 2, snippets: ['Easy to use'] }], negative: [{ topic: 'Leak-Proof', mentions: 1, snippets: ['Spilled — all over'] }] },
  B: { positive: [{ topic: 'Ease Of Use', mentions: 1, snippets: ['easy'] }], negative: [{ topic: 'Leak-Proof', mentions: 2, snippets: ['leaked'] }, { topic: 'Size', mentions: 1, snippets: ['Small'] }] },
  C: { error: 'down' },
};
const label = (a) => ({ A: 'Soap', B: '2-pack' }[a] || a);

test('complaints sorted by mentions, repeated topics across listings, praise merged', () => {
  const r = summarizeReviews(raw, label);
  assert.deepEqual(r.complaints.map((c) => `${c.label}:${c.topic}`), ['2-pack:Leak-Proof', 'Soap:Leak-Proof', '2-pack:Size']);
  assert.deepEqual(r.repeated, [{ topic: 'Leak-Proof', labels: ['2-pack', 'Soap'] }]);
  assert.deepEqual(r.praise[0], { topic: 'Ease Of Use', mentions: 3, listings: 2, snippet: 'Easy to use' });
  assert.deepEqual(r.asinsFailed, ['C']);
  assert.equal(r.asinsWithTopics, 2);
});

test('em dashes in customer quotes become hyphens', () => {
  assert.equal(summarizeReviews(raw, label).complaints[1].snippets[0], 'Spilled - all over');
});

test('NEW marks only quotes absent from last month', () => {
  const prev = { complaints: [{ snippets: ['LEAKED'] }] };
  const r = summarizeReviews(raw, label, prev);
  assert.deepEqual(r.complaints[0].newSnippets, []);
  assert.deepEqual(r.complaints[2].newSnippets, ['Small']);
  assert.deepEqual(summarizeReviews(raw, label).complaints[2].newSnippets, [], 'no previous month: nothing is NEW');
});

test('renderer: section after Goal progress, escaped, no em dash, text version', () => {
  const reviews = { ...summarizeReviews({ A: { positive: [], negative: [{ topic: 'Leak', mentions: 1, snippets: ['<b>bad</b>'] }] } }, label, { complaints: [] }), hasPrevious: true };
  const { html, text } = renderMonthly({ month: '2026-10', reviews });
  assert.ok(html.indexOf('>What customers say<') > html.indexOf('>Goal progress<'));
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
  assert.match(html, />NEW</);
  assert.ok(!html.includes('—') && !text.includes('—'));
  assert.match(text, /WHAT CUSTOMERS SAY\n- Soap, Leak \(1\): NEW "<b>bad<\/b>"/);
  assert.ok(!renderMonthly({ month: '2026-10' }).html.includes('What customers say'), 'no reviews model: no section');
});
