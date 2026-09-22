import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSubmission, planReview, buildRevisionComment, quoteAround,
  summarizePerformance, renderDigest, MAX_REVISIONS_PER_RUN,
} from '../../lib/trybe-review.js';

const sub = (over = {}) => ({
  id: `submission_${over.trybe_id || 'x'}`,
  trybe_id: 'abc12345',
  status: 'pending',
  media_type: 'video',
  creator: { id: 'creator_1', name: 'Zena' },
  products: [{ id: 'p1', name: 'Coconut Moisturizer | 4oz' }],
  transcript: null,
  created_at: '2026-09-22T00:00:00Z',
  ...over,
});
const said = (text, over) => sub({ transcript: { language: 'en', text }, ...over });

test('a claim in the transcript is sent back for revision', () => {
  for (const line of [
    'I have eczema and this is the only lotion that works.',
    'This cleared up my psoriasis in a week.',
    'It heals my cracked heels overnight.',
    'Our antiperspirant keeps me dry all day.',
    'This toothpaste strengthens enamel.',
    'Dermatologist recommended and clinically proven.',
  ]) {
    const d = decideSubmission(said(line));
    assert.equal(d.action, 'revise', line);
    assert.ok(d.comment.includes(line), `comment quotes the line: ${line}`);
  }
});

test('what the creator brief allows passes', () => {
  for (const line of [
    'I use it on my dry, rough, sensitive skin every morning.',
    'My skin feels so soft, and it is safe for my kids.',
    'It is not an antiperspirant, it is a deodorant.',
    'Only six ingredients, no toxic chemicals.',
  ]) {
    assert.equal(decideSubmission(said(line)).action, 'review', line);
  }
});

test('no transcript is UNCHECKED, never clean', () => {
  const silent = decideSubmission(sub());
  assert.equal(silent.action, 'unchecked');
  assert.match(silent.reason, /no transcript/);
  assert.equal(decideSubmission(said('   ')).action, 'unchecked');
  assert.match(decideSubmission(sub({ media_type: 'image' })).reason, /nothing spoken/);
});

test('a submission somebody already reviewed is skipped', () => {
  for (const status of ['approved', 'rejected', 'revision_requested']) {
    assert.equal(decideSubmission(said('this cures eczema', { status })).action, 'skip');
  }
});

test('the revision comment names the reason, quotes the line and carries no em dash', () => {
  const text = 'Love the texture. It totally healed my eczema. Smells great too.';
  const d = decideSubmission(said(text));
  assert.equal(d.action, 'revise');
  assert.match(d.comment, /cosmetics/);
  assert.match(d.comment, /"It totally healed my eczema\."/);
  assert.ok(!d.comment.includes('Love the texture'), 'only the offending sentence is quoted');
  assert.ok(!d.comment.includes('—'), 'no em dash in copy a creator reads');
});

test('quoteAround windows an unpunctuated transcript instead of quoting all of it', () => {
  const text = `${'so '.repeat(60)}this heals my skin ${'and '.repeat(60)}`;
  const q = quoteAround(text, 'heals');
  assert.ok(q.includes('heals'));
  assert.ok(q.length < 160);
  assert.ok(q.startsWith('...') && q.endsWith('...'));
});

test('buildRevisionComment caps quotes at three', () => {
  const text = 'It heals. It cures. It treats. It prevents acne.';
  const c = buildRevisionComment(text, [
    { category: 'therapeutic', match: 'heals' },
    { category: 'therapeutic', match: 'cures' },
    { category: 'therapeutic', match: 'treats' },
    { category: 'therapeutic', match: 'prevents' },
  ]);
  assert.equal((c.match(/^"/gm) || []).length, 3);
});

test('planReview spends the revision cap oldest-first and defers the rest', () => {
  const subs = Array.from({ length: MAX_REVISIONS_PER_RUN + 2 }, (_, i) =>
    said('this cured my eczema', { id: `s${i}`, trybe_id: `t${i}`, created_at: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  const plan = planReview([...subs].reverse());
  assert.equal(plan.revise.length, MAX_REVISIONS_PER_RUN);
  assert.equal(plan.deferred.length, 2);
  assert.equal(plan.revise[0].submission.id, 's0');
  assert.deepEqual(plan.deferred.map((r) => r.submission.id), ['s10', 's11']);
});

test('summarizePerformance totals the roster and lists only active creators', () => {
  const perf = summarizePerformance([
    { creator: { name: 'A' }, performance: { start_date: '2026-08-23', end_date: '2026-09-21', trybe_gmv_cents: 5000, trybe_conversions: 1, earnings_cents: 1000 } },
    { creator: { name: 'B' }, performance: { trybe_gmv_cents: 0 } },
  ]);
  assert.equal(perf.creators, 2);
  assert.equal(perf.active.length, 1);
  assert.equal(perf.totals.trybe_gmv_cents, 5000);
  assert.deepEqual(perf.window, { start: '2026-08-23', end: '2026-09-21' });
});

test('renderDigest separates unchecked from reviewable and says when it is a dry run', () => {
  const plan = planReview([said('this cured my eczema', { id: 'a', trybe_id: 'aaa' }), sub({ id: 'b', trybe_id: 'bbb' }), said('so soft', { id: 'c', trybe_id: 'ccc' })]);
  const dry = renderDigest({ plan, perf: summarizePerformance([]), apply: false });
  assert.match(dry.body, /DRY RUN/);
  assert.match(dry.body, /Not checked, review by eye/);
  assert.match(dry.body, /Ready for your review/);
  assert.match(dry.subject, /2 awaiting review · 1 claim revision/);

  const failed = [{ ...plan.revise[0], error: 'HTTP 500' }];
  const live = renderDigest({ plan, revised: [], failed, perf: null, apply: true });
  assert.ok(!/DRY RUN/.test(live.body));
  assert.match(live.subject, /1 FAILED/);
  assert.match(live.body, /could not be read/);
});
