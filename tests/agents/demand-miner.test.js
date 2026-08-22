// tests/agents/demand-miner.test.js
//
// Smoke test with every dependency injected: no network, no LLM, no filesystem writes.
// Importing agents/*/index.js RUNS the agent in this codebase unless it is guarded —
// this file existing and passing is also the proof that guard is in place.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemandMiner, classifyStages, realApplyPersonaOverlay, parseLimitArg } from '../../agents/demand-miner/index.js';

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
        questions: [{ index: 1, stage: stages[0] }],
      }) }],
    }),
  },
});

function collectWrites() {
  const written = {};
  return { written, writeArtifacts: (files) => Object.assign(written, files) };
}

function collectNotify() {
  const calls = [];
  return { calls, notify: async (opts) => { calls.push(opts); } };
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

test('every seed failing writes nothing, notifies (deferred), and stays partial', async () => {
  const { written, writeArtifacts } = collectWrites();
  const { calls, notify } = collectNotify();
  const alwaysFails = async () => { throw new Error('DataForSEO 502'); };
  const result = await runDemandMiner({
    getSerpResults: alwaysFails,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    notify,
    now: 'x',
  });
  assert.equal(result.partial, true, 'every seed failing makes the run partial');
  assert.equal(result.questions.length, 0);
  assert.deepEqual(written, {}, 'no seeds survived — must not overwrite a good artifact with nothing');
  assert.equal(calls.length, 1, 'the degraded-harvest guard notifies');
  assert.equal(calls[0].status, 'error');
  assert.ok(!calls[0].immediate, 'a degraded cycle waits for the 5 AM digest, not an instant email');
});

test('every SERP call succeeding with zero PAA/related results writes nothing, notifies, and stays non-partial', async () => {
  const { written, writeArtifacts } = collectWrites();
  const { calls, notify } = collectNotify();
  const emptySerp = async () => ({ organic: [], serpFeatures: [], paa: [], relatedSearches: [] });
  const result = await runDemandMiner({
    getSerpResults: emptySerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    notify,
    now: 'x',
  });
  // The whole point of this variant: nothing errored, so nothing else would have set
  // partial. A run that "looks clean" must still be caught before it wipes the artifact.
  assert.equal(result.partial, false, 'no seed failed and no source was missing');
  assert.equal(result.questions.length, 0);
  assert.deepEqual(written, {}, 'an all-empty harvest must not overwrite a good artifact with nothing');
  assert.equal(calls.length, 1, 'the degraded-harvest guard notifies even though nothing errored');
  assert.equal(calls[0].status, 'error');
  assert.ok(!calls[0].immediate, 'a degraded cycle waits for the 5 AM digest, not an instant email');
});

test('malformed LLM output is retried exactly once, then succeeds', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const flakyLlm = { messages: { create: async () => {
    calls += 1;
    return calls === 1
      ? { content: [{ type: 'text', text: 'not json at all' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ questions: [{ index: 1, stage: 'problem-aware' }] }) }] };
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

// --- Fix wave: item 1 — max_tokens must throw naming truncation, and never retry ---
//
// 4000 was sized against a one-question test fixture; a real 40-seed run harvests
// ~200-400 questions and would truncate mid-response, after all 40 paid SERP calls
// were already spent. Truncated JSON cannot become valid on a retry with the same
// input and the same ceiling, so unlike a parse failure this must NOT retry.

test('a stop_reason: max_tokens response throws naming truncation, and does not retry', async () => {
  let calls = 0;
  const truncatingLlm = { messages: { create: async () => {
    calls += 1;
    // A real truncation cuts off mid-JSON; the exact body doesn't matter here because
    // the max_tokens check must fire before JSON.parse is ever attempted.
    return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"questions": [ {"index": 1, "st' }] };
  } } };
  await assert.rejects(
    () => classifyStages({ anthropic: truncatingLlm, records: [{ text: 'Does coconut oil clog pores?' }] }),
    /max_tokens|truncat/i,
    'the thrown error must name truncation, not blame the model\'s JSON formatting',
  );
  assert.equal(calls, 1, 'a max_tokens response must not be retried into the same wall');
});

// --- Fix wave: item 4 — merge by [n] index, never by echoed question text ---
//
// The old merge keyed on `q.text.trim().toLowerCase()`. If the model kept the `[1] `
// prompt prefix, normalized a curly apostrophe to a straight one, or dropped
// punctuation, every lookup missed — the retry produced the identical miss, and the
// run threw after the money was spent. The new schema asks for `index` only; these
// tests prove the merge no longer depends on the model echoing text at all.

test('the merge is positional by index — a mangled/echoed text field on the response is ignored', async () => {
  const records = [
    // A curly apostrophe, exactly the case cited as the trigger for the old bug.
    { text: 'Doesn’t coconut oil clog pores?', origin: 'gsc_leak', seed: 'x', seed_origin: 'gsc_leak', persona_id: null, seen_count: 1 },
    { text: 'Is coconut oil good for skin?', origin: 'gsc_leak', seed: 'x', seed_origin: 'gsc_leak', persona_id: null, seen_count: 1 },
  ];
  const mangledLlm = { messages: { create: async () => ({
    content: [{ type: 'text', text: JSON.stringify({
      questions: [
        // Straight apostrophe (normalized) AND the "[1] " prompt prefix retained —
        // either alone would have missed a text-keyed lookup against records[0].text.
        { index: 1, stage: 'problem-aware', text: "[1] doesn't coconut oil clog pores?" },
        // Punctuation dropped entirely — would also have missed a text-keyed lookup.
        { index: 2, stage: 'unaware', text: 'is coconut oil good for skin' },
      ],
    }) }],
  }) } };
  const result = await classifyStages({ anthropic: mangledLlm, records });
  assert.equal(result[0].stage, 'problem-aware');
  assert.equal(result[1].stage, 'unaware');
  // The original text is untouched — only `stage` was merged on.
  assert.equal(result[0].text, 'Doesn’t coconut oil clog pores?');
});

test('an out-of-range index is schema-invalid, retried once, then throws', async () => {
  let calls = 0;
  const badIndexLlm = { messages: { create: async () => {
    calls += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ questions: [{ index: 99, stage: 'problem-aware' }] }) }] };
  } } };
  await assert.rejects(() => classifyStages({ anthropic: badIndexLlm, records: [{ text: 'q' }] }));
  assert.equal(calls, 2, 'one attempt plus one retry, then give up — not an infinite loop');
});

// --- Fix wave: item 2 — this agent is a FIFTH reader of personas.json and must apply
// the operator overlay before sanitizePersonas, exactly like the other four
// (agents/ad-brief, the dashboard's ad-brief route, agents/ad-studio's non-brief path,
// agents/creative-packager's loadPersonas). Skipping it means a retired angle still
// consumes a paid seed while an operator-authored replacement is never seeded at all —
// the exact failure that went unnoticed 2026-08-18 to 2026-08-21 on the other two.

test('runDemandMiner applies the injected persona overlay BEFORE deriving seeds', async () => {
  const RAW_PERSONAS = { personas: [{ id: 'p2', angles: [{ objection_addressed: 'retired objection text' }] }] };
  const OVERLAID_PERSONAS = { personas: [{ id: 'p2', angles: [{ objection_addressed: 'authored replacement objection' }] }] };
  let overlayCalledWith;

  // Seed-aware stub: the harvested PAA text encodes which seed produced it, so the
  // test can tell whether the persona seed that reached getSerpResults carried the
  // raw or the overlaid objection text.
  const seedAwareSerp = async (seedText) => ({
    organic: [], serpFeatures: [],
    paa: [{ question: `Question about: ${seedText}`, source: 'paa' }],
    relatedSearches: [],
  });

  const { written, writeArtifacts } = collectWrites();
  await runDemandMiner({
    getSerpResults: seedAwareSerp,
    anthropic: {
      messages: { create: async ({ messages }) => {
        // Classify every question present in the prompt as problem-aware — content
        // doesn't matter here, only that every harvested question round-trips.
        const count = (messages[0].content.match(/^\[\d+\]/gm) || []).length;
        return { content: [{ type: 'text', text: JSON.stringify({
          questions: Array.from({ length: count }, (_, i) => ({ index: i + 1, stage: 'problem-aware' })),
        }) }] };
      } },
    },
    readJson: (p) => (p.includes('impression-leaks') ? null : RAW_PERSONAS),
    applyPersonaOverlay: (data) => { overlayCalledWith = data; return OVERLAID_PERSONAS; },
    writeArtifacts,
    now: 'x',
  });

  assert.deepEqual(overlayCalledWith, RAW_PERSONAS, 'the overlay function receives the raw personas.json read');
  const parsed = JSON.parse(written.json);
  const seededTexts = parsed.questions.map((q) => q.seed);
  assert.ok(
    seededTexts.some((s) => s === 'authored replacement objection'),
    'a seed came from the OVERLAID objection text',
  );
  assert.ok(
    !seededTexts.some((s) => s === 'retired objection text'),
    'the raw (pre-overlay) objection text must never reach a seed',
  );
});

test('runDemandMiner defaults applyPersonaOverlay to identity — existing callers are unaffected', async () => {
  // No applyPersonaOverlay passed: this pins that the parameter is additive and every
  // pre-existing test/caller that doesn't know about it keeps working unchanged.
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.ok(written.json);
  assert.equal(result.questions.length, 1);
});

test('realApplyPersonaOverlay: overlay runs BEFORE sanitizePersonas — retired angle drops, authored angle survives (concrete p2a2/p2a4 case)', () => {
  const root = mkdtempSync(join(tmpdir(), 'demand-miner-overlay-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'context', 'operator-angles.json'),
    JSON.stringify({
      retired: [{ id: 'p2a2' }],
      angles: [{
        personaId: 'p2',
        id: 'p2a4',
        label: '112 ingredients, or one',
        objection_addressed: 'I have never thought about how many ingredients I put on my skin in a morning',
        proof: 'The average adult uses 12 personal care products a day, made with as many as 112 unique '
          + 'chemical ingredients, per an EWG / Morning Consult survey of 2,200 U.S. adults in 2023.',
      }],
    }),
  );

  const personasData = {
    personas: [{
      id: 'p2',
      angles: [
        { id: 'p2a2', objection_addressed: 'retired: a stale ingredient-count claim' },
        { id: 'p2a1', objection_addressed: 'does the fragrance actually last all day' },
      ],
    }],
  };

  const result = realApplyPersonaOverlay(personasData, root);
  const ids = result.personas[0].angles.map((a) => a.id);
  assert.ok(!ids.includes('p2a2'), 'the retired angle must not survive the overlay');
  assert.ok(ids.includes('p2a4'), 'the operator-authored replacement must be seeded');
  assert.ok(ids.includes('p2a1'), 'an angle the overlay does not touch survives unchanged');
});

test('realApplyPersonaOverlay: an authored angle is sanitized the same as a mined one — order is overlay THEN sanitize, never the reverse', () => {
  const root = mkdtempSync(join(tmpdir(), 'demand-miner-overlay-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'context', 'operator-angles.json'),
    JSON.stringify({
      retired: [],
      angles: [{
        personaId: 'p3',
        id: 'p3a-bad',
        label: 'a violating authored angle',
        // "cures" is a disallowed health-claim verb — this angle must NOT reach the
        // copy prompt / seed derivation just because a human, not the LLM, wrote it.
        objection_addressed: 'does this cream cure dry skin for good',
        proof: 'Yes, it cures dry skin permanently.',
      }],
    }),
  );

  const personasData = {
    personas: [
      { id: 'p3', angles: [] },
      { id: 'p4', angles: [{ id: 'p4a1', objection_addressed: 'does it actually last all day' }] },
    ],
  };
  const result = realApplyPersonaOverlay(personasData, root);
  // p3 had no angles before the overlay; the overlay adds the violating authored
  // angle, THEN sanitize runs and drops it for the health claim, leaving p3 with an
  // angle list that HAD content and lost all of it — sanitizePersona's documented
  // behavior for that case is to drop the whole persona, not just the angle. That IS
  // the expected outcome, not a bug: an authored angle gets no exemption from the
  // gate an LLM-mined one would face.
  const ids = result.personas.map((p) => p.id);
  assert.ok(!ids.includes('p3'), 'p3 must not survive once its only angle is health-claim-dropped');
  assert.ok(ids.includes('p4'), 'an untouched persona is unaffected by another persona\'s drop');
});

test('realApplyPersonaOverlay: null/missing personas.json passes through untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'demand-miner-overlay-'));
  assert.equal(realApplyPersonaOverlay(null, root), null);
});

// --- Fix wave: item 5 — a cheap way to rehearse a first run at 5 seeds ---

test('parseLimitArg reads --limit <n> from argv', () => {
  assert.equal(parseLimitArg(['node', 'index.js', '--limit', '5']), 5);
});

test('parseLimitArg returns undefined when --limit is absent', () => {
  assert.equal(parseLimitArg(['node', 'index.js']), undefined);
});

test('parseLimitArg throws on a non-positive-integer value rather than failing open', () => {
  assert.throws(() => parseLimitArg(['node', 'index.js', '--limit', '0']), /positive integer/);
  assert.throws(() => parseLimitArg(['node', 'index.js', '--limit', '-3']), /positive integer/);
  assert.throws(() => parseLimitArg(['node', 'index.js', '--limit', 'abc']), /positive integer/);
  assert.throws(() => parseLimitArg(['node', 'index.js', '--limit', '2.5']), /positive integer/);
});

test('runDemandMiner honors `limit` by trimming the derived seed list', async () => {
  const manyLeaks = {
    leaks: Array.from({ length: 30 }, (_, i) => ({ query: `coconut oil lotion query ${i}`, impressions: 30 - i, clicks: 0, position: 5 })),
  };
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? manyLeaks : null),
    writeArtifacts,
    limit: 3,
    now: 'x',
  });
  assert.equal(result.seedCount, 3, '--limit trims the seed list before harvesting, so only 3 paid SERP calls happen');
  assert.ok(written.json);
});

test('runDemandMiner clamps `limit` to SEED_CAP rather than letting it raise the ceiling', async () => {
  const manyLeaks = {
    leaks: Array.from({ length: 60 }, (_, i) => ({ query: `coconut oil lotion query ${i}`, impressions: 60 - i, clicks: 0, position: 5 })),
  };
  const { writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? manyLeaks : null),
    writeArtifacts,
    limit: 1000,
    now: 'x',
  });
  assert.equal(result.seedCount, 40, 'a --limit above SEED_CAP must never raise the ceiling above 40');
});

// --- Fix wave: item 3 — a throwing persona overlay (a dangling personaId in
// data/context/operator-angles.json, typically from a monthly voice-of-customer
// renumbering) must degrade this run to leaks-only, not kill it. The overlay's throw
// stays correct and unchanged for the other four readers (agents/ad-brief, the
// dashboard's ad-brief route, agents/ad-studio, agents/creative-packager) — they are
// copy-facing and a silent skip there would hide the operator's replacement copy. This
// agent only SEEDS questions from personas.json, never quotes it as copy, and runs
// unattended monthly from cron right alongside the run that causes the renumbering —
// so an unrelated config error in a sibling agent's file must not take down the leak
// half of this one too.

test('a throwing persona overlay degrades the run to leaks-only, sets partial, and notifies naming operator-angles.json', async () => {
  const { written, writeArtifacts } = collectWrites();
  const { calls, notify } = collectNotify();
  const throwingOverlay = () => {
    throw new Error(
      'operator-angles: angle(s) [p9a1] in data/context/operator-angles.json name persona "p9", '
      + 'which is not in personas.json (known personas: p1, p2).',
    );
  };

  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    applyPersonaOverlay: throwingOverlay,
    writeArtifacts,
    notify,
    now: 'x',
  });

  assert.equal(result.partial, true, 'a failed overlay must mark the run partial');
  assert.ok(written.json, 'the run still completes on the leak seed alone — it must not throw');
  const parsed = JSON.parse(written.json);
  assert.ok(
    parsed.questions.every((q) => q.seed_origin === 'gsc_leak'),
    'no persona-objection seeds can appear once the overlay failed — personas were dropped for this run',
  );

  assert.equal(calls.length, 1, 'exactly one notify for the overlay failure');
  assert.match(calls[0].subject + calls[0].body, /operator-angles\.json/, 'must name operator-angles.json as the cause');
  assert.equal(calls[0].status, 'error');
  assert.ok(!calls[0].immediate, 'deferred to the 5 AM digest, not an instant email — the run itself already recovered');
});

test('a throwing persona overlay still lets a zero-leak-seed run report cleanly (no seeds at all is the pre-existing "nothing to do" path, not a second failure)', async () => {
  const { written, writeArtifacts } = collectWrites();
  const { calls, notify } = collectNotify();
  const throwingOverlay = () => { throw new Error('operator-angles: dangling personaId'); };

  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: () => null,   // leaks feed also missing — nothing to seed from either source
    applyPersonaOverlay: throwingOverlay,
    writeArtifacts,
    notify,
    now: 'x',
  });

  assert.equal(result.questions.length, 0);
  assert.deepEqual(written, {}, 'no seeds is not an error, and must not write an empty artifact');
  // Still exactly one notify — the overlay-failure notify — even though the run then
  // also finds zero seeds; the zero-seeds path itself returns early without a second
  // notify (see the "both sources missing" test above).
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject + calls[0].body, /operator-angles\.json/);
});

test('runDemandMiner with no `limit` behaves exactly as before (full SEED_CAP applies)', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.seedCount, 2, 'unaffected: one leak seed + one persona seed, same as before this fix wave');
  assert.ok(written.json);
});
