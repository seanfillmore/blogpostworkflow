import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isQuestionQuery,
  dedupeKey,
  extractQuestions,
  assignQuestionsToProducts,
  formatQuestionAnswer,
  renderSupplementalTsv,
  MAX_PAIRS_PER_PRODUCT,
  MAX_SIDE_CHARS,
} from '../../lib/merchant-qa.js';

test('question detection takes an interrogative opener OR a question mark', () => {
  // Real rows from the 2026-09-02 GSC snapshot.
  assert.equal(isQuestionQuery('are coconut oil toothpastes effective for everyday use?'), true);
  assert.equal(isQuestionQuery('antibacterial soap with natural ingredients?'), true, 'no opener, but a mark');
  assert.equal(isQuestionQuery('is natural deodorant safe'), true, 'opener, no mark');
  assert.equal(isQuestionQuery('best natural deodorant'), false);
  assert.equal(isQuestionQuery(''), false);
  assert.equal(isQuestionQuery(null), false);
});

test('duplicate spellings collapse and their impressions sum', () => {
  // Both of these were in one real snapshot, differing only by U+2019 vs U+0027.
  const rows = [
    { query: "are natural bar soaps better for men's daily cleansing?", impressions: 40, clicks: 1 },
    { query: 'are natural bar soaps better for men’s daily cleansing?', impressions: 60, clicks: 0 },
    { query: 'best soap', impressions: 900, clicks: 9 },
  ];
  const out = extractQuestions(rows);

  assert.equal(out.length, 1, 'the non-question row is excluded');
  assert.equal(out[0].impressions, 100, 'impressions summed across spellings');
  assert.ok(out[0].query.includes('’'), 'keeps the higher-impression spelling verbatim');
});

test('dedupeKey normalises for matching only, never for output', () => {
  assert.equal(dedupeKey("Men's Soap?"), dedupeKey('men’s soap'));
  assert.notEqual(dedupeKey('is it safe'), dedupeKey('is it strong'));
});

test('questions rank by impressions, not clicks — unsatisfied demand is the target', () => {
  const rows = [
    { query: 'does it stain clothes?', impressions: 500, clicks: 0 },
    { query: 'is it aluminum free?', impressions: 100, clicks: 40 },
  ];
  const out = extractQuestions(rows);
  assert.equal(out[0].query, 'does it stain clothes?',
    'a question earning impressions and no clicks is the better candidate, not the worse');
});

test('questions route by cluster, and unclusterable ones are dropped and counted', () => {
  const questions = [
    { query: 'is coconut oil toothpaste effective?', impressions: 300 },
    { query: 'does natural deodorant work?', impressions: 200 },
    { query: 'who is real skin care?', impressions: 50 },
  ];
  const { byHandle, unassigned } = assignQuestionsToProducts(questions, {
    toothpaste: ['coconut-oil-toothpaste'],
    deodorant: ['coconut-oil-deodorant'],
  });

  assert.deepEqual([...byHandle.keys()].sort(), ['coconut-oil-deodorant', 'coconut-oil-toothpaste']);
  assert.equal(byHandle.get('coconut-oil-toothpaste').length, 1);
  // `brand` maps to null in the taxonomy on purpose, so a navigational query
  // never consumes a product's slot.
  assert.equal(unassigned.length, 1);
  assert.match(unassigned[0].query, /real skin care/);
});

test('a product is capped at 30 pairs, because Google caps the attribute there', () => {
  const questions = Array.from({ length: 45 }, (_, i) => ({
    query: `does natural deodorant work in case ${i}?`,
    impressions: 100 - i,
  }));
  const { byHandle } = assignQuestionsToProducts(questions, { deodorant: ['d'] });
  assert.equal(byHandle.get('d').length, MAX_PAIRS_PER_PRODUCT);
  assert.match(byHandle.get('d')[0].query, /case 0\?/, 'the cap keeps the strongest, not an arbitrary slice');
});

test('a double quote can never break the delimiter', () => {
  // The hazard: a straight quote would close its own field and silently corrupt
  // every pair after it. Google documents no escape sequence.
  const out = formatQuestionAnswer([
    { question: 'What does "natural" mean?', answer: 'It means one ingredient: coconut oil.' },
    { question: 'Is it safe?', answer: 'Yes.' },
  ]);

  assert.ok(!out.includes('"natural"'), 'straight quotes inside a field are converted');
  assert.ok(out.includes('“natural”'), 'converted to curly, which reads correctly to a human');
  assert.equal(out.split('", "').length, 2, 'both pairs survive as separate fields');
  assert.match(out, /^"What does/);
});

test('each side is capped at 1,000 characters', () => {
  const out = formatQuestionAnswer([{ question: 'Q?', answer: 'x'.repeat(1500) }]);
  const answer = out.slice(out.indexOf(':"') + 2, -1);
  assert.equal(answer.length, MAX_SIDE_CHARS);
});

test('the supplemental feed carries id and the one column, and nothing else', () => {
  // A supplemental feed that restates title or price silently overwrites the
  // primary feed's live values with whatever stale copy is in here.
  const tsv = renderSupplementalTsv([
    { id: 'coconut-oil-deodorant', questionAndAnswer: '"Q?":"A."' },
  ]);
  const [header, row] = tsv.trim().split('\n');
  assert.equal(header, 'id\tquestion_and_answer');
  assert.equal(header.split('\t').length, 2, 'exactly two columns');
  assert.equal(row.split('\t').length, 2);
});

test('a tab or newline inside a value cannot shift the columns', () => {
  const tsv = renderSupplementalTsv([
    { id: 'x', questionAndAnswer: '"Q?":"line one\tstill\nsame field"' },
  ]);
  const rows = tsv.trim().split('\n');
  assert.equal(rows.length, 2, 'header plus exactly one row');
  assert.equal(rows[1].split('\t').length, 2);
});

test('paraphrases of one question collapse to one slot, with impressions summed', () => {
  // Verbatim from the first live --apply run, which spent EIGHT of ten slots on
  // one question and produced eight near-identical answers.
  const paraphrases = [
    'can you use coconut oil as deodorant',
    'can coconut oil be used as deodorant',
    'can i use coconut oil as deodorant',
    'does coconut oil work as deodorant',
    'is coconut oil a good deodorant',
    'can you use coconut oil for deodorant',
  ];
  const out = extractQuestions(paraphrases.map((q, i) => ({ query: q, impressions: 100 - i, clicks: 0 })));

  assert.equal(out.length, 1, 'six phrasings of one question take one slot');
  assert.equal(out[0].query, 'can you use coconut oil as deodorant', 'the highest-impression phrasing survives');
  assert.equal(out[0].impressions, 585, 'demand is summed onto it — 100+99+98+97+96+95');
});

test('genuinely different questions are NOT merged', () => {
  const distinct = [
    'can you use coconut oil as deodorant',
    'how to select a deodorant with a clean formula free from parabens, phthalates, and aluminum?',
    'are there natural deodorants safe for sensitive underarms?',
    'is antibacterial soap good for body odor',
  ];
  const out = extractQuestions(distinct.map((q, i) => ({ query: q, impressions: 100 - i, clicks: 0 })));
  assert.equal(out.length, 4, 'over-merging would waste a real question, which is the failure that matters');
});
