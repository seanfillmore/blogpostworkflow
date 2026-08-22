// tests/lib/demand-questions.test.js
//
// The pure brain. No I/O, no network, no LLM — everything here is a plain function
// over plain data, which is why it can be tested exhaustively and cheaply.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SEED_CAP, deriveSeeds } from '../../lib/demand-questions.js';

const leak = (query, impressions) => ({ query, impressions, clicks: 0, position: 10 });

const personas = [
  { id: 'p1', angles: [{ objection_addressed: 'will it stain my shirts' }, { objection_addressed: 'does it actually work' }] },
  { id: 'p2', angles: [{ objection_addressed: 'is it safe for eczema-prone skin' }] },
];

test('SEED_CAP is 40 — the hard ceiling on paid SERP calls per run', () => {
  assert.equal(SEED_CAP, 40);
});

test('seeds come from both origins, each labelled', () => {
  const { seeds } = deriveSeeds({ leaks: [leak('coconut oil acne', 900)], personas });
  const origins = new Set(seeds.map((s) => s.origin));
  assert.deepEqual([...origins].sort(), ['gsc_leak', 'persona_objection']);
  const fromLeak = seeds.find((s) => s.origin === 'gsc_leak');
  assert.equal(fromLeak.text, 'coconut oil acne');
  assert.equal(fromLeak.personaId, null, 'a leak has no persona');
  const fromPersona = seeds.find((s) => s.origin === 'persona_objection');
  assert.ok(fromPersona.personaId, 'a persona objection carries its persona id');
});

test('GSC leaks are taken highest-impression first', () => {
  const { seeds } = deriveSeeds({
    leaks: [leak('small', 60), leak('huge', 5000), leak('mid', 300)],
    personas: [],
  });
  assert.deepEqual(seeds.map((s) => s.text), ['huge', 'mid', 'small']);
});

test('never more than SEED_CAP seeds, however much input arrives', () => {
  const many = Array.from({ length: 500 }, (_, i) => leak(`q${i}`, 1000 - i));
  const { seeds } = deriveSeeds({ leaks: many, personas });
  assert.equal(seeds.length, SEED_CAP);
});

test('persona objections round-robin, so one persona cannot monopolise the budget', () => {
  // p1 has 30 angles, p2 has 30. A naive concat would spend the whole budget on p1.
  const greedy = [
    { id: 'p1', angles: Array.from({ length: 30 }, (_, i) => ({ objection_addressed: `p1-${i}` })) },
    { id: 'p2', angles: Array.from({ length: 30 }, (_, i) => ({ objection_addressed: `p2-${i}` })) },
  ];
  const { seeds } = deriveSeeds({ leaks: [], personas: greedy });
  const p1 = seeds.filter((s) => s.personaId === 'p1').length;
  const p2 = seeds.filter((s) => s.personaId === 'p2').length;
  assert.equal(seeds.length, SEED_CAP);
  assert.ok(Math.abs(p1 - p2) <= 1, `expected an even split, got p1=${p1} p2=${p2}`);
});

test('missing personas degrades to leaks only and reports partial', () => {
  const { seeds, partial } = deriveSeeds({ leaks: [leak('q', 100)], personas: null });
  assert.equal(partial, true);
  assert.deepEqual(seeds.map((s) => s.origin), ['gsc_leak']);
});

test('missing leaks degrades to personas only and reports partial', () => {
  const { seeds, partial } = deriveSeeds({ leaks: null, personas });
  assert.equal(partial, true);
  assert.ok(seeds.every((s) => s.origin === 'persona_objection'));
});

test('both sources present is not partial', () => {
  const { partial } = deriveSeeds({ leaks: [leak('q', 100)], personas });
  assert.equal(partial, false);
});

test('both sources absent yields no seeds and is not an error', () => {
  const { seeds, partial } = deriveSeeds({ leaks: [], personas: [] });
  assert.deepEqual(seeds, []);
  assert.equal(partial, true);
});

test('blank and duplicate objections are dropped before they cost a SERP call', () => {
  const dupes = [{ id: 'p1', angles: [
    { objection_addressed: 'same thing' },
    { objection_addressed: 'same thing' },
    { objection_addressed: '   ' },
    { objection_addressed: null },
  ] }];
  const { seeds } = deriveSeeds({ leaks: [], personas: dupes });
  assert.deepEqual(seeds.map((s) => s.text), ['same thing']);
});
