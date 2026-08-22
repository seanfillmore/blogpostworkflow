// tests/agents/demand-miner.test.js
//
// Smoke test with every dependency injected: no network, no LLM, no filesystem writes.
// Importing agents/*/index.js RUNS the agent in this codebase unless it is guarded —
// this file existing and passing is also the proof that guard is in place.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runDemandMiner } from '../../agents/demand-miner/index.js';

const LEAKS = { leaks: [{ query: 'coconut oil acne', impressions: 900, clicks: 0, position: 12 }] };
const PERSONAS = { personas: [{ id: 'p1', angles: [{ objection_addressed: 'is it safe for eczema' }] }] };

const stubSerp = async () => ({
  organic: [],
  serpFeatures: ['people_also_ask'],
  paa: [{ question: 'Does coconut oil clog pores?', source: 'paa' }],
  relatedSearches: [],
});

/** Returns whatever the LLM is supposed to return: the questions, stage-classified. */
const stubAnthropic = (stages = ['problem-aware']) => ({
  messages: {
    create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        questions: [{ text: 'Does coconut oil clog pores?', stage: stages[0] }],
      }) }],
    }),
  },
});

function collectWrites() {
  const written = {};
  return { written, writeArtifacts: (files) => Object.assign(written, files) };
}

test('a full run writes both artifacts', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: '2026-08-21T00:00:00.000Z',
  });

  assert.equal(result.partial, false);
  assert.ok(written.json, 'demand-questions.json rendered');
  assert.ok(written.md, 'demand-questions.md rendered');
  const parsed = JSON.parse(written.json);
  assert.equal(parsed.cluster, 'skin');
  assert.equal(parsed.questions[0].stage, 'problem-aware');
  assert.equal(parsed.questions[0].seed_origin, 'gsc_leak');
});

test('missing personas sets partial and still writes', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : null),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.partial, true);
  assert.ok(written.json);
});

test('missing leaks sets partial and still writes', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? null : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.partial, true);
  assert.ok(written.json);
});

test('both sources missing writes nothing and does not throw', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: () => null,
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.questions.length, 0);
  assert.deepEqual(written, {}, 'no seeds is not an error, and must not write an empty artifact');
});

test('a SERP failure skips that seed, sets partial, and continues', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('DataForSEO 502');
    return stubSerp();
  };
  const result = await runDemandMiner({
    getSerpResults: flaky,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.partial, true, 'a skipped seed makes the run partial');
  assert.ok(written.json, 'the run still completes');
});

test('malformed LLM output is retried exactly once, then succeeds', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const flakyLlm = { messages: { create: async () => {
    calls += 1;
    return calls === 1
      ? { content: [{ type: 'text', text: 'not json at all' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ questions: [{ text: 'Does coconut oil clog pores?', stage: 'problem-aware' }] }) }] };
  } } };
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: flakyLlm,
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(calls, 2, 'exactly one retry');
  assert.ok(written.json, 'the retry succeeded and the artifact was written');
  assert.equal(result.questions.length, 1);
});

test('malformed LLM output twice throws and writes nothing', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const brokenLlm = { messages: { create: async () => {
    calls += 1;
    return { content: [{ type: 'text', text: 'still not json' }] };
  } } };
  await assert.rejects(() => runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: brokenLlm,
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  }));
  assert.equal(calls, 2, 'one attempt plus one retry, then give up — not an infinite loop');
  assert.deepEqual(written, {}, 'no partial write');
});

test('the JSON envelope matches the artifact contract exactly', async () => {
  const { written, writeArtifacts } = collectWrites();
  await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: '2026-08-21T00:00:00.000Z',
  });
  const parsed = JSON.parse(written.json);
  assert.deepEqual(Object.keys(parsed).sort(), ['cluster', 'generated_at', 'partial', 'questions', 'seed_count']);
  assert.deepEqual(Object.keys(parsed.questions[0]).sort(),
    ['persona_id', 'seed', 'seed_origin', 'seen_count', 'source', 'stage', 'text'],
    'the funnel-matrix join depends on stage and persona_id being present under these exact names');
});

test('an invalid stage from the LLM throws rather than writing a broken artifact', async () => {
  const { written, writeArtifacts } = collectWrites();
  await assert.rejects(
    () => runDemandMiner({
      getSerpResults: stubSerp,
      anthropic: stubAnthropic(['considering']),   // not one of the five levels
      readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
      writeArtifacts,
      now: 'x',
    }),
    /stage/i,
  );
  assert.deepEqual(written, {}, 'no partial write on a validation failure');
});
