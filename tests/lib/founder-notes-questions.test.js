import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekId, pickReviews, pickNews, pickUpcoming, buildSources, templateQuestion,
  renderEmail, MAX_QUESTIONS, MIN_QUESTIONS,
} from '../../lib/founder-notes-questions.js';

const body = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const rev = (over = {}) => ({
  product_external_id: '1', rating: 5, reviewer: 'Jenna Smith', body: body(15),
  verified: true, created_at: '2026-10-20T10:00:00Z', ...over,
});

test('weekId gives the ISO week', () => {
  assert.equal(weekId(new Date('2026-10-26T15:35Z')), '2026-W44');
  assert.equal(weekId(new Date('2027-01-01T00:00Z')), '2026-W53');
});

test('pickReviews filters short and asked, prefers extremes, newest first', () => {
  const short = rev({ body: 'too short here', reviewer: 'A' });
  const asked = rev({ reviewer: 'B' });
  const four = rev({ rating: 4, reviewer: 'C', created_at: '2026-10-21T10:00:00Z' });
  const two = rev({ rating: 2, reviewer: 'D', created_at: '2026-10-19T10:00:00Z' });
  const five = rev({ rating: 5, reviewer: 'E', created_at: '2026-10-18T10:00:00Z' });
  const out = pickReviews([short, asked, four, two, five], { asked: new Set([`${asked.created_at}|B`]) });
  assert.deepEqual(out.map((r) => r.reviewer), ['D', 'E']);
  assert.equal(pickReviews([four, two, five], { asked: new Set(), max: 3 })[2].reviewer, 'C');
});

test('pickNews takes the first unasked result with a title', () => {
  const r = [{ url: 'https://example.com/a', title: 'A', content: 'x' }, { url: 'https://example.com/b', title: '', content: '' }, { url: 'https://example.com/c', title: 'C', content: 'y' }];
  assert.equal(pickNews(r, { askedUrls: new Set(['https://example.com/a']) }).url, 'https://example.com/c');
  assert.equal(pickNews([], { askedUrls: new Set() }), null);
});

test('pickUpcoming window is 7 to 21 days, earliest wins', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const items = [
    { slug: 'near', publish_date: '2026-10-26' },
    { slug: 'far', publish_date: '2026-11-20' },
    { slug: 'ok2', publish_date: '2026-11-05' },
    { slug: 'ok1', publish_date: '2026-10-30' },
  ];
  assert.equal(pickUpcoming(items, { now, asked: new Set() }).slug, 'ok1');
  assert.equal(pickUpcoming(items, { now, asked: new Set(['ok1']) }).slug, 'ok2');
  assert.equal(pickUpcoming([items[0], items[1]], { now, asked: new Set() }), null);
});

test('buildSources orders and caps', () => {
  const reviews = [rev({ reviewer: 'A' }), rev({ reviewer: 'B' }), rev({ reviewer: 'C' })];
  const s = buildSources({
    reviews, news: { url: 'https://example.com/n', title: 'T', content: 'c' },
    upcoming: { slug: 'sl', keyword: 'kw', title: 'Post' },
  });
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((x) => x.type), ['review', 'review', 'world', 'upcoming']);
  assert.equal(s[2].ref, 'https://example.com/n');
  assert.equal(s[3].ref, 'sl');
  assert.equal(s[0].ref, `${reviews[0].created_at}|A`);
  assert.ok(s.length <= MAX_QUESTIONS && MIN_QUESTIONS === 2 && MAX_QUESTIONS === 4);
  for (const x of s) assert.ok(templateQuestion(x).length > 10);
});

test('renderEmail subject, numbering, first name, no dashes', () => {
  const sources = buildSources({
    reviews: [rev()], news: { url: 'https://example.com/n', title: 'A — title', content: 'c' }, upcoming: null,
  });
  const questions = sources.map((s) => ({ text: 'What do you think — really?', source: s }));
  const { subject, text } = renderEmail({ week: '2026-W44', questions, now: new Date('2026-10-26T15:35Z') });
  assert.match(subject, /^Founder notes, week of Oct 26 \[FN-2026-W44\]$/);
  assert.ok(text.startsWith('Reply under each number. Skip any you like.'));
  assert.ok(text.includes('1.') && text.includes('2.'));
  assert.ok(!/[—–]/.test(text));
  assert.ok(text.includes('(Jenna, 5 stars)'));
  assert.ok(!text.includes('Smith'));
  assert.ok(text.includes('https://example.com/n'));
});

const render = (source) => renderEmail({ week: '2026-W44', questions: [{ text: 'Q?', source }], now: new Date('2026-10-26T15:35Z') }).text;

test('renderEmail: missing or blank reviewer renders A customer', () => {
  const s = buildSources({ reviews: [rev({ reviewer: undefined })] })[0];
  assert.ok(render(s).includes('(A customer, 5 stars)'));
  const b = buildSources({ reviews: [rev({ reviewer: '  ' })] })[0];
  assert.ok(render(b).includes('(A customer, 5 stars)'));
  assert.ok(!render(s).includes('undefined'));
});

test('renderEmail: missing or non-integer rating omits stars', () => {
  for (const rating of [undefined, null, 4.5, 'x']) {
    const t = render(buildSources({ reviews: [rev({ rating })] })[0]);
    assert.ok(t.includes('(Jenna)'), String(rating));
    assert.ok(!/stars|undefined|null/.test(t));
  }
});

test('renderEmail: a title with a newline stays on one line', () => {
  const t = render(buildSources({ reviews: [], news: { url: 'https://example.com/n', title: 'Line one\nLine two', content: '' } })[0]);
  assert.ok(t.includes('   Line one Line two\n   https://example.com/n'));
});

test('renderEmail: upcoming block renders its title, never raw context', () => {
  const t = render(buildSources({ reviews: [], upcoming: { slug: 'sl', keyword: 'kw', title: 'Post Title', publish_date: '2026-10-30' } })[0]);
  assert.ok(t.includes('Upcoming post: Post Title'));
  assert.ok(!t.includes('keyword:'));
});
