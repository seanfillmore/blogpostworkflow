import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScoredSuggestions, summarizeSuggestionFailures } from '../../lib/llm-json-suggestions.js';

const msg = (text, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text }] });

test('parses a plain JSON array and filters by score', () => {
  const r = parseScoredSuggestions(msg('[{"score":9},{"score":2}]'), { minScore: 5 });
  assert.equal(r.failure, null);
  assert.deepEqual(r.suggestions, [{ score: 9 }]);
});

test('strips ```json fences', () => {
  const r = parseScoredSuggestions(msg('```json\n[{"score":7}]\n```'), { minScore: 5 });
  assert.equal(r.failure, null);
  assert.equal(r.suggestions.length, 1);
});

test('an empty array is SUCCESS, not a failure — the model genuinely found nothing', () => {
  const r = parseScoredSuggestions(msg('[]'));
  assert.equal(r.failure, null);
  assert.deepEqual(r.suggestions, []);
});

// ── the three cases the old `catch { return [] }` made indistinguishable ───────

test('max_tokens is reported as truncated, not as "found nothing"', () => {
  const r = parseScoredSuggestions(msg('[{"score":9},{"sco', 'max_tokens'));
  assert.deepEqual(r.suggestions, []);
  assert.equal(r.failure.reason, 'truncated');
});

test('malformed JSON is reported as unparseable', () => {
  const r = parseScoredSuggestions(msg('Sure! Here are some ideas:'));
  assert.deepEqual(r.suggestions, []);
  assert.equal(r.failure.reason, 'unparseable');
  assert.match(r.failure.detail, /Sure! Here are/);
});

test('valid JSON that is not an array is reported', () => {
  const r = parseScoredSuggestions(msg('{"score":9}'));
  assert.equal(r.failure.reason, 'not_an_array');
});

test('a missing response or text block is reported rather than thrown', () => {
  assert.equal(parseScoredSuggestions(null).failure.reason, 'no_response');
  assert.equal(parseScoredSuggestions({ content: [] }).failure.reason, 'no_text');
});

test('suggestions is always an array, so an old-style caller is unaffected', () => {
  for (const m of [null, { content: [] }, msg('nope'), msg('x', 'max_tokens')]) {
    assert.ok(Array.isArray(parseScoredSuggestions(m).suggestions));
  }
});

test('non-object entries are dropped rather than crashing the score filter', () => {
  const r = parseScoredSuggestions(msg('[null, 3, {"score":9}]'), { minScore: 1 });
  assert.deepEqual(r.suggestions, [{ score: 9 }]);
});

test('an entry with no score counts as 0', () => {
  assert.deepEqual(parseScoredSuggestions(msg('[{"a":1}]'), { minScore: 1 }).suggestions, []);
  assert.equal(parseScoredSuggestions(msg('[{"a":1}]'), { minScore: 0 }).suggestions.length, 1);
});

// ── summary line ──────────────────────────────────────────────────────────────

test('summarizeSuggestionFailures is empty when nothing failed', () => {
  assert.equal(summarizeSuggestionFailures([]), '');
  assert.equal(summarizeSuggestionFailures(null), '');
});

test('summarizeSuggestionFailures counts by reason and says what it means', () => {
  const s = summarizeSuggestionFailures([
    { reason: 'truncated', detail: '' }, { reason: 'truncated', detail: '' }, { reason: 'unparseable', detail: '' },
  ]);
  assert.match(s, /3 suggestion call\(s\) failed/);
  assert.match(s, /truncated×2/);
  assert.match(s, /unparseable×1/);
  assert.match(s, /not the same as finding none/);
});
