import { strict as assert } from 'node:assert';
import { buildConsolidationPrompt, validateConsolidation, consolidateTactics } from '../../lib/marketing-learner.js';

const candidate = (i, claim) => ({
  claim,
  mechanism: 'm',
  evidence: 'e',
  rscFit: { score: 7, reasoning: 'r' },
  verdict: 'adopt',
  targetSkill: { name: 'marketing-offer-construction', action: 'edit', description: 'Use when …' },
  chunk: { index: i, label: `part ${i + 1} of 3` },
});

const CANDIDATES = [
  candidate(0, 'Bill weekly'),
  candidate(1, 'Use four-week cycles'),
  candidate(2, 'Waive the setup fee'),
];

const group = (claim, idxs) => ({
  claim,
  mechanism: 'm',
  evidence: 'e',
  rscFit: { score: 8, reasoning: 'r' },
  verdict: 'adopt',
  stage: null,
  targetSkill: { name: 'marketing-offer-construction', action: 'edit', description: 'Use when …' },
  mergedFrom: idxs.map((i) => ({ candidateIndex: i, label: CANDIDATES[i].chunk.label })),
});

// ── a legitimate merge passes ───────────────────────────────────────────────
{
  const ok = { tactics: [group('Bill every four weeks', [0, 1]), group('Waive the setup fee', [2])] };
  assert.equal(validateConsolidation(CANDIDATES, ok), ok);
}

// ── a dropped candidate throws and names it ─────────────────────────────────
{
  const dropped = { tactics: [group('Bill every four weeks', [0, 1])] };
  assert.throws(() => validateConsolidation(CANDIDATES, dropped),
    /dropped 1 candidate.*Waive the setup fee/s);
}

// ── a double-claimed candidate throws ───────────────────────────────────────
{
  const doubled = { tactics: [group('A', [0, 1]), group('B', [1, 2])] };
  assert.throws(() => validateConsolidation(CANDIDATES, doubled),
    /double-claimed.*Use four-week cycles/s);
}

// ── structural failures throw ───────────────────────────────────────────────
{
  assert.throws(() => validateConsolidation(CANDIDATES, {}), /tactics must be an array/);
  assert.throws(
    () => validateConsolidation(CANDIDATES, { tactics: [{ ...group('A', [0]), mergedFrom: [] }] }),
    /has no mergedFrom/);
  assert.throws(
    () => validateConsolidation(CANDIDATES, {
      tactics: [group('A', [0]), group('B', [1]), { ...group('C', [2]), mergedFrom: [{ candidateIndex: 9 }] }],
    }),
    /candidateIndex 9/);
}

// ── the prompt carries every candidate, indexed ─────────────────────────────
{
  const p = buildConsolidationPrompt({
    candidates: CANDIDATES,
    source: { title: 'Book', creator: 'A', sourceType: 'file' },
  });
  for (let i = 0; i < CANDIDATES.length; i++) assert.ok(p.includes(`[${i}]`), `candidate ${i} is indexed`);
  assert.ok(p.includes('Bill weekly') && p.includes('Waive the setup fee'));
  assert.ok(/mergedFrom/.test(p), 'the required output field is named');
  assert.ok(/every candidate.*exactly one/is.test(p), 'the no-drop rule is stated');
}

// Consolidation streams (the SDK rejects a non-streaming call at this max_tokens),
// so the stub exposes stream().finalMessage(), not create().
const streamingClient = (message) => ({
  messages: { stream: () => ({ finalMessage: async () => message }) },
});

// ── consolidateTactics: refuses truncated output ────────────────────────────
{
  const client = streamingClient({ stop_reason: 'max_tokens', content: [] });
  await assert.rejects(
    () => consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client }),
    /hit max_tokens/);
}

// ── consolidateTactics: happy path returns validated output ─────────────────
{
  const payload = { tactics: [group('Bill every four weeks', [0, 1]), group('Waive the setup fee', [2])] };
  const client = streamingClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] });
  const out = await consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client });
  assert.equal(out.tactics.length, 2);
  assert.deepEqual(out.tactics[0].mergedFrom.map((m) => m.candidateIndex), [0, 1]);
}

// ── consolidateTactics: guard trip carries the payload for inspection ───────
{
  const bad = { tactics: [group('only one', [0])] };
  const client = streamingClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(bad) }] });
  await assert.rejects(
    () => consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client }),
    (e) => /dropped 2 candidate/.test(e.message) && e.offendingPayload?.tactics?.length === 1);
}

// ── consolidateTactics: budgeted for a whole book ───────────────────────────
// Output scales with candidate count, because the no-drop guard makes every
// candidate land in a group and every group carry a full tactic object. 37
// candidates once overflowed 16k; $100M Money Models produced 172 across 11
// chunks and overflowed 32k. 128k is claude-opus-5's output ceiling, so there is
// no budget raise after this one — if a book overflows it, consolidation has to
// be batched rather than made bigger.
{
  let sent = null;
  const capturing = {
    messages: {
      stream: (req) => {
        sent = req;
        return {
          finalMessage: async () => ({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({ tactics: [group('a', [0, 1, 2])] }) }],
          }),
        };
      },
    },
  };
  await consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client: capturing });
  assert.ok(sent.max_tokens >= 64000, 'consolidation budgets for book-scale candidate counts');
}

// ── consolidateTactics: transient overload is retried ───────────────────────
// Consolidation is the single call standing between 11 cached chunk extractions
// and a saved report. An overloaded_error here discards nothing, but it does mean
// a manual re-run, and the same sustained window that hit extraction hits this.
{
  let calls = 0;
  const flaky = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('Overloaded');
            err.status = 529;
            throw err;
          }
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({ tactics: [group('a', [0, 1, 2])] }) }],
          };
        },
      }),
    },
  };
  const out = await consolidateTactics({
    candidates: CANDIDATES,
    source: { title: 'B', creator: 'A' },
    client: flaky,
    retryOptions: { delayMs: 1 },
  });
  assert.equal(calls, 2, 'a 529 is retried rather than discarding the run');
  assert.equal(out.tactics.length, 1);
}

// Truncation is deterministic — retrying a 128k overflow would pay for four of
// the most expensive calls in the pipeline to reach the identical error.
{
  let calls = 0;
  const truncating = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          return { stop_reason: 'max_tokens', content: [] };
        },
      }),
    },
  };
  await assert.rejects(
    () => consolidateTactics({
      candidates: CANDIDATES,
      source: { title: 'B', creator: 'A' },
      client: truncating,
      retryOptions: { delayMs: 1 },
    }),
    /hit max_tokens/);
  assert.equal(calls, 1, 'truncation is not retried');
}

console.log('✓ consolidateTactics tests pass');
