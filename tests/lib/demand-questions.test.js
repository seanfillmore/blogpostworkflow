// tests/lib/demand-questions.test.js
//
// The pure brain. No I/O, no network, no LLM — everything here is a plain function
// over plain data, which is why it can be tested exhaustively and cheaply.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SEED_CAP, deriveSeeds, normalizeHarvest, validateQuestions } from '../../lib/demand-questions.js';
import { renderDemandQuestionsMarkdown } from '../../lib/demand-questions.js';
import { AWARENESS_LEVELS } from '../../lib/voice-of-customer.js';

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

// --- Fix round 1: reserve-based cap so an abundant leak feed cannot starve personas ---
//
// Measured on the production server: a real gsc-query-miner run yields 253 impression
// leaks against this 40-seed cap. Leaks-first-then-cap gave leaks all 40 seeds on every
// real run — persona_objection seeds were starved to zero and the persona join
// (stage + persona_id) that this artifact exists for never populated. These cases pin
// the reserve-then-top-up fix.

test('production shape: 253 leaks (measured on-server) against 40 cap does not starve personas', () => {
  const manyLeaks = Array.from({ length: 253 }, (_, i) => leak(`leak-query-${i}`, 253 - i));
  const fivePersonas = Array.from({ length: 5 }, (_, p) => ({
    id: `persona-${p + 1}`,
    angles: Array.from({ length: 2 }, (_, a) => ({ objection_addressed: `persona-${p + 1}-objection-${a}` })),
  }));
  const { seeds } = deriveSeeds({ leaks: manyLeaks, personas: fivePersonas });
  const origins = new Set(seeds.map((s) => s.origin));
  assert.deepEqual([...origins].sort(), ['gsc_leak', 'persona_objection']);
  const personaCount = seeds.filter((s) => s.origin === 'persona_objection').length;
  const leakCount = seeds.filter((s) => s.origin === 'gsc_leak').length;
  assert.equal(personaCount, 10, 'all 10 persona objections should survive the cap');
  assert.equal(leakCount, 30, 'leaks top up the remainder after the persona reserve is honored');
  assert.equal(seeds.length, SEED_CAP);
});

test('leaks only: 253 leaks, no personas, uses the full cap', () => {
  const manyLeaks = Array.from({ length: 253 }, (_, i) => leak(`leak-query-${i}`, 253 - i));
  const { seeds } = deriveSeeds({ leaks: manyLeaks, personas: [] });
  assert.equal(seeds.length, SEED_CAP);
  assert.ok(seeds.every((s) => s.origin === 'gsc_leak'));
});

test('personas only: 100 objections, no leaks, uses the full cap', () => {
  const tenPersonas = Array.from({ length: 10 }, (_, p) => ({
    id: `persona-${p + 1}`,
    angles: Array.from({ length: 10 }, (_, a) => ({ objection_addressed: `persona-${p + 1}-objection-${a}` })),
  }));
  const { seeds } = deriveSeeds({ leaks: [], personas: tenPersonas });
  assert.equal(seeds.length, SEED_CAP);
  assert.ok(seeds.every((s) => s.origin === 'persona_objection'));
});

test('both thin: 5 leaks + 5 objections yields 10 seeds, no padding, no error', () => {
  const fewLeaks = Array.from({ length: 5 }, (_, i) => leak(`leak-query-${i}`, 5 - i));
  const onePersona = [{
    id: 'p1',
    angles: Array.from({ length: 5 }, (_, a) => ({ objection_addressed: `p1-objection-${a}` })),
  }];
  const { seeds } = deriveSeeds({ leaks: fewLeaks, personas: onePersona });
  assert.equal(seeds.length, 10);
});

// --- Task 4: normalizeHarvest / validateQuestions ---

const seedA = { text: 'coconut oil acne', origin: 'gsc_leak', personaId: null };
const seedB = { text: 'is it safe for eczema', origin: 'persona_objection', personaId: 'p2' };

test('PAA and related searches normalize into one record shape', () => {
  const out = normalizeHarvest([{
    seed: seedA,
    paa: [{ question: 'Does coconut oil clog pores?', source: 'paa' }],
    relatedSearches: [{ question: 'coconut oil for dry skin', source: 'related_search' }],
  }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    text: 'Does coconut oil clog pores?',
    source: 'paa',
    seed: 'coconut oil acne',
    seed_origin: 'gsc_leak',
    persona_id: null,
    seen_count: 1,
  });
  assert.equal(out[1].source, 'related_search');
});

test('the same question from two different seeds dedupes and increments seen_count', () => {
  const q = { question: 'Does coconut oil clog pores?', source: 'paa' };
  const out = normalizeHarvest([
    { seed: seedA, paa: [q], relatedSearches: [] },
    { seed: seedB, paa: [q], relatedSearches: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seen_count, 2);
});

test('dedup is case- and whitespace-insensitive but keeps the first spelling', () => {
  const out = normalizeHarvest([
    { seed: seedA, paa: [{ question: 'Does Coconut Oil Clog Pores?', source: 'paa' }], relatedSearches: [] },
    { seed: seedB, paa: [{ question: '  does coconut oil clog pores?  ', source: 'paa' }], relatedSearches: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Does Coconut Oil Clog Pores?');
  assert.equal(out[0].seen_count, 2);
});

test('the same question twice from the SAME seed counts once', () => {
  // seen_count means "how many distinct seeds surfaced this", not "how many times seen".
  const q = { question: 'same', source: 'paa' };
  const out = normalizeHarvest([{ seed: seedA, paa: [q, q], relatedSearches: [] }]);
  assert.equal(out[0].seen_count, 1);
});

test('the first seed to surface a question owns its attribution', () => {
  const q = { question: 'shared', source: 'paa' };
  const out = normalizeHarvest([
    { seed: seedB, paa: [q], relatedSearches: [] },
    { seed: seedA, paa: [q], relatedSearches: [] },
  ]);
  assert.equal(out[0].persona_id, 'p2');
  assert.equal(out[0].seed_origin, 'persona_objection');
});

test('an empty harvest is empty, not a throw', () => {
  assert.deepEqual(normalizeHarvest([]), []);
  assert.deepEqual(normalizeHarvest([{ seed: seedA, paa: [], relatedSearches: [] }]), []);
});

test('validateQuestions accepts every awareness level personas.json uses', () => {
  const qs = AWARENESS_LEVELS.map((stage, i) => ({ text: `q${i}`, stage }));
  assert.equal(validateQuestions(qs), qs);
});

test('validateQuestions rejects a stage outside the five levels', () => {
  assert.throws(
    () => validateQuestions([{ text: 'q', stage: 'considering' }]),
    /stage/i,
    'an invalid stage must throw — it would silently break the personas join',
  );
});

test('validateQuestions rejects a missing stage', () => {
  assert.throws(() => validateQuestions([{ text: 'q' }]), /stage/i);
});

// --- Task 5: renderDemandQuestionsMarkdown ---

const RENDER_INPUT = {
  generatedAt: '2026-08-21T00:00:00.000Z',
  cluster: 'skin',
  seedCount: 28,
  partial: false,
  questions: [
    { text: 'Why does my skin react to everything?', stage: 'unaware', source: 'paa', seed: 'sensitive skin', seed_origin: 'gsc_leak', persona_id: null, seen_count: 3 },
    { text: 'Does coconut oil clog pores?', stage: 'problem-aware', source: 'paa', seed: 'coconut oil acne', seed_origin: 'persona_objection', persona_id: 'p4', seen_count: 2 },
  ],
};

test('headings are stable and grouped by funnel stage with counts', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.match(md, /^# Demand questions/m);
  assert.match(md, /^## unaware \(1\)$/m);
  assert.match(md, /^## problem-aware \(1\)$/m);
});

test('only stages that have questions get a heading', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.ok(!md.includes('## most-aware'), 'an empty stage must not render an empty section');
});

test('stages render in funnel order, not alphabetical or insertion order', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.ok(md.indexOf('## unaware') < md.indexOf('## problem-aware'));
});

test('each entry is self-contained — one grep hit carries its own context', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  const line = md.split('\n').find((l) => l.includes('Does coconut oil clog pores?'));
  assert.ok(line.includes('paa'), 'carries its source');
  assert.ok(line.includes('coconut oil acne'), 'carries the seed that found it');
  assert.ok(line.includes('p4'), 'carries the persona it is attributed to');
  assert.ok(line.includes('2'), 'carries seen_count');
});

test('the header records provenance and the partial flag', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.ok(md.includes('2026-08-21'));
  assert.ok(md.includes('28'));
  assert.ok(/partial.*no/i.test(md));
});

test('a partial run says so prominently', () => {
  const md = renderDemandQuestionsMarkdown({ ...RENDER_INPUT, partial: true });
  assert.ok(/partial.*yes/i.test(md));
});

test('no questions still renders a valid document', () => {
  const md = renderDemandQuestionsMarkdown({ ...RENDER_INPUT, questions: [] });
  assert.match(md, /^# Demand questions/m);
  assert.ok(md.length > 0);
});
