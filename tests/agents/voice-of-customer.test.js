import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTERNAL_QUERIES,
  buildAnalysisPrompt,
  collectCorpus,
  runAnalysis,
  writeArtifacts,
} from '../../agents/voice-of-customer/index.js';

// Stubs mirror the REAL return shapes of the libs collectCorpus depends on:
//   fetchAllReviews -> array of { id, product_handle, rating, body, created_at }
//   searchWeb       -> array of { url, title, content }
//   getSerpResults  -> { organic: [{ position, url, title, description }], serpFeatures }
function stubReviews(handle = 'coconut-lotion') {
  return [{ id: 1, product_handle: handle, rating: 5, body: 'Great lotion.', created_at: '2026-01-01' }];
}

function stubTavilyResults() {
  return [{ url: 'https://reddit.com/x', title: 'Broke me out', content: 'my skin broke out' }];
}

function stubSerpResult() {
  return {
    organic: [{ position: 1, url: 'https://example.com/review', title: 'Lotion review', description: 'It works great for dry skin.' }],
    serpFeatures: [],
  };
}

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

// Regression: getSerpResults() returns { organic, serpFeatures }, not a bare array.
// A live run against the real lib surfaced `(items || []).map is not a function`
// because collectCorpus originally treated the whole result as the array.
test('collectCorpus reads the .organic array out of the real getSerpResults shape', async () => {
  const corpus = await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x', TAVILY_API_KEY: 'tvly-test' },
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async () => stubTavilyResults(),
      fetchSerp: async () => stubSerpResult(),
    },
  });
  assert.ok(corpus.records.some((r) => r.source === 'serp'), 'expected at least one serp record');
  assert.equal(corpus.partial, false);
});

test('collectCorpus sets partial:true when a fetchSerp call throws, without aborting other sources', async () => {
  const corpus = await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x', TAVILY_API_KEY: 'tvly-test' },
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async () => stubTavilyResults(),
      fetchSerp: async () => { throw new Error('dataforseo down'); },
    },
  });
  assert.equal(corpus.partial, true);
  assert.ok(corpus.records.some((r) => r.source === 'judgeme'), 'judge.me records should still be present');
  assert.ok(corpus.records.some((r) => r.source === 'reddit'), 'tavily records should still be present');
});

test('collectCorpus sets partial:true and still returns Judge.me records when TAVILY_API_KEY is missing', async () => {
  const corpus = await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x' }, // no TAVILY_API_KEY
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async () => stubTavilyResults(),
      fetchSerp: async () => stubSerpResult(),
    },
  });
  assert.equal(corpus.partial, true);
  assert.ok(corpus.records.some((r) => r.source === 'judgeme'), 'judge.me records should still be present');
});

test('collectCorpus yields partial:false when all three sources succeed', async () => {
  const corpus = await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x', TAVILY_API_KEY: 'tvly-test' },
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async () => stubTavilyResults(),
      fetchSerp: async () => stubSerpResult(),
    },
  });
  assert.equal(corpus.partial, false);
});
