import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTERNAL_QUERIES,
  buildAnalysisPrompt,
  runAnalysis,
  writeArtifacts,
} from '../../agents/voice-of-customer/index.js';

function fixtureAnalysis() {
  return {
    personas: [
      {
        id: 'low', name: 'Low', summary: 's', evidence_count: 1, emotional_intensity: 1,
        angles: [{
          id: 'a1', label: 'A1', awareness: 'problem-aware', objection_addressed: 'o',
          proof: 'p', hook_examples: ['h'], source_quotes: ['q'],
        }],
      },
      {
        id: 'high', name: 'High', summary: 's', evidence_count: 30, emotional_intensity: 9,
        angles: [{
          id: 'a2', label: 'A2', awareness: 'solution-aware', objection_addressed: 'o',
          proof: 'p', hook_examples: ['h'], source_quotes: ['q'],
        }],
      },
    ],
    objections: [{ text: 't', evidence_count: 1, quote: 'q' }],
    golden_nugget_phrases: [{ text: 't', evidence_count: 1, quote: 'q' }],
    trigger_points: [{ text: 't', evidence_count: 1, quote: 'q' }],
    not_for: [{ text: 't', evidence_count: 1, quote: 'q' }],
  };
}

function stubClient(payload, { stopReason = 'end_turn' } = {}) {
  return {
    messages: {
      create: async () => ({
        stop_reason: stopReason,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
    },
  };
}

const CORPUS = {
  generated_at: '2026-08-01T00:00:00Z',
  cluster: 'skin',
  partial: false,
  records: [
    { source: 'judgeme', id: 'judgeme:1', url: null, handle: 'coconut-lotion', rating: 5, text: 'Great lotion.' },
    { source: 'reddit', id: 'reddit:x', url: 'https://reddit.com/x', handle: null, rating: null, text: 'Broke me out.' },
  ],
};

test('EXTERNAL_QUERIES covers Reddit friction for the skin cluster', () => {
  assert.ok(EXTERNAL_QUERIES.length >= 4);
  assert.ok(EXTERNAL_QUERIES.some((q) => /reddit/i.test(q)));
});

test('buildAnalysisPrompt includes every corpus record and labels its source', () => {
  const prompt = buildAnalysisPrompt(CORPUS);
  assert.match(prompt, /Great lotion\./);
  assert.match(prompt, /Broke me out\./);
  assert.match(prompt, /judgeme/);
  assert.match(prompt, /reddit/);
});

test('buildAnalysisPrompt tells the model not to invent quotes', () => {
  assert.match(buildAnalysisPrompt(CORPUS), /verbatim/i);
});

test('runAnalysis returns the parsed analysis on a valid response', async () => {
  const { analysis } = await runAnalysis({ corpus: CORPUS, client: stubClient(fixtureAnalysis()) });
  assert.equal(analysis.personas.length, 2);
});

test('runAnalysis throws when the model hits the token cap', async () => {
  const client = stubClient(fixtureAnalysis(), { stopReason: 'max_tokens' });
  await assert.rejects(
    () => runAnalysis({ corpus: CORPUS, client }),
    /max_tokens/,
  );
});

test('runAnalysis retries once then throws on schema-invalid output', async () => {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ personas: [] }) }] };
      },
    },
  };
  await assert.rejects(() => runAnalysis({ corpus: CORPUS, client }), /validation/i);
  assert.equal(calls, 2, 'should attempt exactly twice');
});

test('writeArtifacts writes all three files with personas rank-ordered', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const paths = writeArtifacts({ analysis: fixtureAnalysis(), corpus: CORPUS, root });

  const json = JSON.parse(readFileSync(paths.personasJsonPath, 'utf8'));
  assert.equal(json.personas[0].id, 'high', 'personas must be rank-ordered');
  assert.equal(json.cluster, 'skin');
  assert.equal(json.partial, false);
  assert.equal(json.status, undefined, 'no approval gate — status must not be written');

  const personasMd = readFileSync(paths.personasMdPath, 'utf8');
  assert.ok(personasMd.indexOf('High') < personasMd.indexOf('Low'));

  const vocMd = readFileSync(paths.vocMdPath, 'utf8');
  assert.match(vocMd, /## Objections/);
});

test('writeArtifacts carries the partial flag into personas.json and the markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const corpus = { ...CORPUS, partial: true };
  const paths = writeArtifacts({ analysis: fixtureAnalysis(), corpus, root });

  assert.equal(JSON.parse(readFileSync(paths.personasJsonPath, 'utf8')).partial, true);
  assert.match(readFileSync(paths.vocMdPath, 'utf8'), /generated without external friction data/);
});
