import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIN_CLUSTER_HANDLES,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  dedupeRecords,
  filterSkinCluster,
  AWARENESS_LEVELS,
  validateAnalysis,
  rankPersonas,
  renderPersonasMarkdown,
  renderVoiceOfCustomerMarkdown,
} from '../../lib/voice-of-customer.js';

// ── cluster definition ──────────────────────────────────────────────────────
test('SKIN_CLUSTER_HANDLES is the exact five-handle list', () => {
  assert.deepEqual([...SKIN_CLUSTER_HANDLES].sort(), [
    'body-lotion-1',
    'coconut-lotion',
    'coconut-moisturizer',
    'coconut-soap',
    'organic-foaming-hand-soap',
  ]);
});

// ── normalization ───────────────────────────────────────────────────────────
test('normalizeJudgemeReview maps a Judge.me review onto the record shape', () => {
  const rec = normalizeJudgemeReview({
    id: 991,
    product_handle: 'coconut-lotion',
    rating: 5,
    body: '  Cleared up my eczema in a week.  ',
  });
  assert.equal(rec.source, 'judgeme');
  assert.equal(rec.id, 'judgeme:991');
  assert.equal(rec.handle, 'coconut-lotion');
  assert.equal(rec.rating, 5);
  assert.equal(rec.text, 'Cleared up my eczema in a week.');
  assert.equal(rec.url, null);
});

test('normalizeTavilyResult keys on the URL and joins title + content', () => {
  const rec = normalizeTavilyResult({
    url: 'https://reddit.com/r/SkincareAddiction/comments/abc/',
    title: 'Does coconut oil clog pores?',
    content: 'It broke me out badly.',
  });
  assert.equal(rec.source, 'reddit');
  assert.equal(rec.url, 'https://reddit.com/r/SkincareAddiction/comments/abc/');
  assert.match(rec.text, /Does coconut oil clog pores\?/);
  assert.match(rec.text, /broke me out badly/);
  assert.equal(rec.handle, null);
  assert.equal(rec.rating, null);
});

test('normalizeSerpItem maps a DataForSEO organic item', () => {
  const rec = normalizeSerpItem({
    url: 'https://example.com/coconut-oil-review',
    title: 'Coconut Oil Lotion Review',
    description: 'Greasy and slow to absorb.',
  });
  assert.equal(rec.source, 'serp');
  assert.equal(rec.url, 'https://example.com/coconut-oil-review');
  assert.match(rec.text, /Greasy and slow to absorb/);
});

// ── dedup ───────────────────────────────────────────────────────────────────
test('dedupeRecords collapses the same URL arriving via Tavily and SERP', () => {
  const shared = 'https://reddit.com/r/SkincareAddiction/comments/abc/';
  const out = dedupeRecords([
    normalizeTavilyResult({ url: shared, title: 'T', content: 'body' }),
    normalizeSerpItem({ url: shared, title: 'T', description: 'body' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords ignores a trailing slash and querystring when comparing URLs', () => {
  const out = dedupeRecords([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/abc/', title: 'T', content: 'b' }),
    normalizeSerpItem({ url: 'https://reddit.com/r/x/abc?utm_source=g', title: 'T', description: 'b' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords keeps distinct Judge.me reviews that have no URL', () => {
  const out = dedupeRecords([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-lotion', rating: 4, body: 'b' }),
  ]);
  assert.equal(out.length, 2);
});

test('dedupeRecords keeps distinct Tavily results with no URL and different text', () => {
  const out = dedupeRecords([
    normalizeTavilyResult({ url: null, title: 'First discussion', content: 'Great product' }),
    normalizeTavilyResult({ url: null, title: 'Second discussion', content: 'Terrible experience' }),
  ]);
  assert.equal(out.length, 2);
});

test('dedupeRecords collapses Tavily results with no URL but identical text', () => {
  const result = { url: null, title: 'Same discussion', content: 'Same feedback' };
  const out = dedupeRecords([
    normalizeTavilyResult(result),
    normalizeTavilyResult(result),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords keeps distinct SERP items with no URL and different text', () => {
  const out = dedupeRecords([
    normalizeSerpItem({ url: null, title: 'Article A', description: 'Content A' }),
    normalizeSerpItem({ url: null, title: 'Article B', description: 'Content B' }),
  ]);
  assert.equal(out.length, 2);
});

// ── cluster filter ──────────────────────────────────────────────────────────
test('filterSkinCluster keeps skin handles and drops other clusters', () => {
  const out = filterSkinCluster([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-oil-toothpaste', rating: 4, body: 'b' }),
    normalizeJudgemeReview({ id: 3, product_handle: 'coconut-breeze', rating: 5, body: 'c' }),
  ]);
  assert.deepEqual(out.map((r) => r.handle), ['coconut-lotion']);
});

test('filterSkinCluster keeps handle-less external records', () => {
  const out = filterSkinCluster([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/1', title: 'T', content: 'b' }),
  ]);
  assert.equal(out.length, 1);
});

function validAngle(overrides = {}) {
  return {
    id: 'steroid-cream-off-ramp',
    label: 'The steroid-cream off-ramp',
    awareness: 'problem-aware',
    objection_addressed: 'Will a natural lotion actually do anything?',
    proof: '97 reviews at 4.91 stars',
    hook_examples: ['Off the steroid cream in three weeks'],
    source_quotes: ['I finally stopped using hydrocortisone.'],
    ...overrides,
  };
}

function validPersona(overrides = {}) {
  return {
    id: 'eczema-flare-parent',
    name: 'The eczema flare parent',
    summary: 'Buys for a child whose skin reacts to everything.',
    evidence_count: 23,
    emotional_intensity: 8.4,
    angles: [validAngle()],
    ...overrides,
  };
}

function validAnalysis(overrides = {}) {
  return {
    personas: [validPersona()],
    objections: [{ text: 'Worried it will feel greasy', evidence_count: 12, quote: 'Too greasy for me.' }],
    golden_nugget_phrases: [{ text: 'like butter for your skin', evidence_count: 3, quote: 'It is like butter for your skin.' }],
    trigger_points: [{ text: 'A winter flare-up', evidence_count: 7, quote: 'My hands cracked in January.' }],
    not_for: [{ text: 'People who want a fragrance-free gel', evidence_count: 4, quote: 'I wanted a gel, not a balm.' }],
    ...overrides,
  };
}

// ── validation ──────────────────────────────────────────────────────────────
test('validateAnalysis accepts a well-formed analysis', () => {
  const res = validateAnalysis(validAnalysis());
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.deepEqual(res.errors, []);
});

test('validateAnalysis rejects a persona with zero angles', () => {
  const res = validateAnalysis(validAnalysis({ personas: [validPersona({ angles: [] })] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /at least one angle/i);
});

test('validateAnalysis rejects an angle with no source_quotes', () => {
  const persona = validPersona({ angles: [validAngle({ source_quotes: [] })] });
  const res = validateAnalysis(validAnalysis({ personas: [persona] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /source_quotes/);
});

test('validateAnalysis rejects an awareness value outside the allowed set', () => {
  const persona = validPersona({ angles: [validAngle({ awareness: 'vaguely-curious' })] });
  const res = validateAnalysis(validAnalysis({ personas: [persona] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /awareness/);
  assert.ok(AWARENESS_LEVELS.includes('problem-aware'));
});

test('validateAnalysis rejects an analysis with no personas', () => {
  const res = validateAnalysis(validAnalysis({ personas: [] }));
  assert.equal(res.ok, false);
});

test('validateAnalysis rejects a voice-of-customer entry with no quote', () => {
  const res = validateAnalysis(validAnalysis({
    objections: [{ text: 'Too greasy', evidence_count: 2, quote: '' }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /quote/);
});

// ── ranking ─────────────────────────────────────────────────────────────────
test('rankPersonas orders by evidence_count x emotional_intensity, highest first', () => {
  const low = validPersona({ id: 'low', evidence_count: 40, emotional_intensity: 2 });   // 80
  const high = validPersona({ id: 'high', evidence_count: 12, emotional_intensity: 9 }); // 108
  assert.deepEqual(rankPersonas([low, high]).map((p) => p.id), ['high', 'low']);
});

test('rankPersonas does not mutate its input', () => {
  const input = [
    validPersona({ id: 'a', evidence_count: 1, emotional_intensity: 1 }),
    validPersona({ id: 'b', evidence_count: 10, emotional_intensity: 10 }),
  ];
  rankPersonas(input);
  assert.deepEqual(input.map((p) => p.id), ['a', 'b']);
});

// ── rendering ───────────────────────────────────────────────────────────────
test('renderVoiceOfCustomerMarkdown emits the five stable headings', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  for (const heading of [
    '## Objections',
    '## Golden-nugget phrases',
    '## Trigger points',
    "## Who we're not for",
    '## Source notes',
  ]) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
});

test('renderVoiceOfCustomerMarkdown flags a partial corpus in Source notes', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: true });
  assert.match(md, /generated without external friction data/);
});

test('renderVoiceOfCustomerMarkdown puts evidence count and quote on every entry', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  assert.match(md, /Worried it will feel greasy/);
  assert.match(md, /12 mentions/);
  assert.match(md, /Too greasy for me\./);
});

test('renderPersonasMarkdown lists personas in rank order with their angles', () => {
  const analysis = validAnalysis({
    personas: [
      validPersona({ id: 'low', name: 'Low persona', evidence_count: 1, emotional_intensity: 1 }),
      validPersona({ id: 'high', name: 'High persona', evidence_count: 50, emotional_intensity: 9 }),
    ],
  });
  const md = renderPersonasMarkdown(analysis);
  assert.ok(md.indexOf('High persona') < md.indexOf('Low persona'));
  assert.match(md, /problem-aware/);
  assert.match(md, /steroid-cream-off-ramp/);
});
