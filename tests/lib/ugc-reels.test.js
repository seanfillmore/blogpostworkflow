import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleVideos, pickNext, chooseHookStyle, captionFormatCheck, composeCaption,
  styleStats, insightsDue, learningsForPrompt, HOOK_STYLE_KEYS, MIN_RECYCLE_DAYS,
  MIN_MEASURED_PER_STYLE, MAX_PUBLISH_FAILURES,
} from '../../lib/ugc-reels.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T20:00:00Z');

const sub = (id, over = {}) => ({
  id,
  trybe_id: id,
  status: 'approved',
  media_type: 'video',
  version: 1,
  revision_of: null,
  creator: { id: 'c1', name: 'Kaci Smith' },
  products: [{ id: 'p1', name: 'Coconut Moisturizer | 4oz' }],
  transcript: { language: 'en', text: 'I love how soft my skin feels with this coconut moisturizer every morning.' },
  asset: { url: `https://cdn.example/${id}.mp4` },
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

const post = (submission_id, over = {}) => ({
  submission_id,
  product_key: 'Coconut Moisturizer | 4oz',
  hook_style: 'question',
  body: 'Ever wonder why your skin feels tight?',
  caption: 'Ever wonder why your skin feels tight?\n\n🎥 Kaci',
  posted_at: new Date(NOW - 10 * DAY).toISOString(),
  media_id: `m_${submission_id}`,
  ...over,
});

// ── eligibility ──────────────────────────────────────────────────────────────

test('eligibleVideos: only approved videos, latest version only', () => {
  const v1 = sub('a');
  const v2 = sub('a2', { revision_of: 'a', version: 2 });
  const img = sub('img', { media_type: 'image' });
  const pend = sub('p', { status: 'pending' });
  const { eligible } = eligibleVideos([v1, v2, img, pend]);
  assert.deepEqual(eligible.map((s) => s.id), ['a2']);
});

test('eligibleVideos: a silent video is skipped as UNCHECKED, never treated as clean', () => {
  const { eligible, skipped } = eligibleVideos([sub('s', { transcript: null })]);
  assert.equal(eligible.length, 0);
  assert.match(skipped[0].reason, /unchecked/);
});

test('eligibleVideos: a transcript with a health claim is skipped and names the words', () => {
  const { eligible, skipped } = eligibleVideos([sub('c', { transcript: { text: 'This lotion cured my eczema in a week.' } })]);
  assert.equal(eligible.length, 0);
  assert.match(skipped[0].reason, /claim in transcript/);
});

test('eligibleVideos: repeated Instagram refusals retire a video', () => {
  const failures = Array.from({ length: MAX_PUBLISH_FAILURES }, () => ({ submission_id: 'f', error: 'x' }));
  const { eligible, skipped } = eligibleVideos([sub('f')], { failures });
  assert.equal(eligible.length, 0);
  assert.match(skipped[0].reason, /refused/);
});

// ── order ────────────────────────────────────────────────────────────────────

test('pickNext: every video posts once, oldest first, before any repeat', () => {
  const a = sub('a', { created_at: '2026-10-01T00:00:00Z' });
  const b = sub('b', { created_at: '2026-10-02T00:00:00Z' });
  const r = pickNext([a, b], { posts: [post('a')] }, NOW);
  assert.equal(r.submission.id, 'b');
  assert.equal(r.cycle, 1);
});

test('pickNext: avoids the same product twice in a row when another is waiting', () => {
  const a = sub('a', { created_at: '2026-10-01T00:00:00Z' });
  const b = sub('b', { created_at: '2026-10-02T00:00:00Z', products: [{ name: 'Foaming Liquid Coconut Oil Soap | 8oz' }] });
  const r = pickNext([a, b], { posts: [post('z')] }, NOW);
  assert.equal(r.submission.id, 'b');
});

test('pickNext: recycles the longest-rested video with its history, never inside the rest period', () => {
  const a = sub('a');
  const b = sub('b');
  const ledger = { posts: [
    post('a', { posted_at: new Date(NOW - 9 * DAY).toISOString() }),
    post('b', { posted_at: new Date(NOW - 12 * DAY).toISOString() }),
  ] };
  const r = pickNext([a, b], ledger, NOW);
  assert.equal(r.submission.id, 'b');
  assert.equal(r.cycle, 2);
  assert.equal(r.previous.length, 1);

  const recent = { posts: [post('a', { posted_at: new Date(NOW - (MIN_RECYCLE_DAYS - 1) * DAY).toISOString() })] };
  const none = pickNext([a], recent, NOW);
  assert.equal(none.submission, null);
  assert.match(none.reason, /within the last/);
});

// ── the experiment ───────────────────────────────────────────────────────────

test('chooseHookStyle: explores the least-tried style first', () => {
  const ledger = { posts: [post('a', { hook_style: 'question' })] };
  const r = chooseHookStyle(ledger, [], { now: NOW });
  assert.notEqual(r.style, 'question');
  assert.match(r.why, /exploring/);
});

test('chooseHookStyle: a repeat never reuses the style that video ran with last', () => {
  const previous = [post('a', { hook_style: 'pov' })];
  for (let i = 0; i < 20; i++) {
    assert.notEqual(chooseHookStyle({ posts: previous }, previous, { now: NOW, rand: () => i / 20 }).style, 'pov');
  }
});

test('chooseHookStyle: once every style is measured, exploits the best median views', () => {
  const posts = [];
  for (const style of HOOK_STYLE_KEYS) {
    for (let i = 0; i < MIN_MEASURED_PER_STYLE; i++) {
      posts.push(post(`${style}${i}`, { hook_style: style, insights: { views: style === 'pov' ? 900 : 100, reach: 50, total_interactions: 5 } }));
    }
  }
  const r = chooseHookStyle({ posts }, [], { now: NOW, rand: () => 0.9 });
  assert.equal(r.style, 'pov');
  assert.match(r.why, /exploiting/);
  // one time in three it still explores
  assert.match(chooseHookStyle({ posts }, [], { now: NOW, rand: () => 0.1 }).why, /exploring/);
});

test('styleStats: posts younger than 48h do not count as measured', () => {
  const young = post('y', { posted_at: new Date(NOW - 3_600_000).toISOString(), insights: { views: 10 } });
  const s = styleStats({ posts: [young] }, NOW).find((r) => r.style === 'question');
  assert.equal(s.n, 0);
  assert.equal(s.tried, 1);
});

// ── caption checks ───────────────────────────────────────────────────────────

const fmtHits = (caption, opts) => captionFormatCheck(opts).check({ caption }).map((h) => h.why);

test('captionFormatCheck: em dashes, links, offers and hashtag spam are refused', () => {
  assert.ok(fmtHits('Soft skin — finally').some((w) => /dash/.test(w)));
  assert.ok(fmtHits('Shop at realskincare.com').some((w) => /link/.test(w)));
  assert.ok(fmtHits('Get 20% off today').some((w) => /price|discount/.test(w)));
  assert.ok(fmtHits('#a #b #c #d #e #f').some((w) => /hashtags/.test(w)));
  assert.deepEqual(fmtHits('Soft skin, finally. Link in bio. #realskincare'), []);
});

test('captionFormatCheck: a quote must be words the creator actually says', () => {
  const transcript = 'I love how soft my skin feels with this coconut moisturizer every morning.';
  assert.deepEqual(fmtHits('"I love how soft my skin feels" Link in bio.', { transcript }), []);
  assert.ok(fmtHits('"This changed my whole life" Link in bio.', { transcript }).some((w) => /does not say/.test(w)));
});

test('captionFormatCheck: recycled copy must differ from every earlier caption for that video', () => {
  const previous = [{ caption: 'Ever wonder why your skin feels tight after a shower? Link in bio.' }];
  assert.ok(fmtHits('Ever wonder why your skin feels so tight after a shower? Link in bio.', { previous }).some((w) => /repeats/.test(w)));
  assert.deepEqual(fmtHits('POV: you finally found a lotion with six ingredients. Link in bio.', { previous }), []);
});

test('composeCaption: the code appends the creator credit by first name', () => {
  assert.equal(composeCaption('Hello. Link in bio.', sub('a')), 'Hello. Link in bio.\n\n🎥 Kaci');
});

// ── insights ─────────────────────────────────────────────────────────────────

test('insightsDue: not before 24h, re-read after 20h, never after the final read', () => {
  const young = post('y', { posted_at: new Date(NOW - 2 * 3_600_000).toISOString() });
  const due = post('d', { posted_at: new Date(NOW - 2 * DAY).toISOString() });
  const fresh = post('f', { posted_at: new Date(NOW - 2 * DAY).toISOString(), insights_at: new Date(NOW - 3_600_000).toISOString() });
  const final = post('x', { insights_final: true });
  assert.deepEqual(insightsDue({ posts: [young, due, fresh, final] }, NOW).map((p) => p.submission_id), ['d']);
});

test('learningsForPrompt: says nothing until there are enough measured posts', () => {
  assert.equal(learningsForPrompt({ posts: [post('a', { insights: { views: 5 } })] }, NOW), '');
  const posts = Array.from({ length: 6 }, (_, i) => post(`p${i}`, { insights: { views: i * 10, total_interactions: i } }));
  assert.match(learningsForPrompt({ posts }, NOW), /Best:[\s\S]*Weakest:/);
});
