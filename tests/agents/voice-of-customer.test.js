import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTERNAL_QUERIES,
  REDDIT_DOMAINS,
  emptyCorpusFailure,
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

// Every quote here is verbatim from CORPUS below — runAnalysis now rejects a
// quote it cannot find in the corpus it handed the model.
const SOURCED = 'Great lotion.';

function fixtureAnalysis(quote = SOURCED) {
  return {
    personas: [
      {
        id: 'low', name: 'Low', summary: 's', evidence_count: 1, emotional_intensity: 1,
        angles: [{
          id: 'a1', label: 'A1', awareness: 'problem-aware', objection_addressed: 'o',
          proof: 'p', hook_examples: ['h'], source_quotes: [quote],
        }],
      },
      {
        id: 'high', name: 'High', summary: 's', evidence_count: 30, emotional_intensity: 9,
        angles: [{
          id: 'a2', label: 'A2', awareness: 'solution-aware', objection_addressed: 'o',
          proof: 'p', hook_examples: ['h'], source_quotes: [quote],
        }],
      },
    ],
    objections: [{ text: 't', evidence_count: 1, quote }],
    golden_nugget_phrases: [{ text: 't', evidence_count: 1, quote }],
    trigger_points: [{ text: 't', evidence_count: 1, quote }],
    not_for: [{ text: 't', evidence_count: 1, quote }],
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

test('EXTERNAL_QUERIES covers the skin cluster and is scoped by domain, not by the word "reddit"', () => {
  assert.ok(EXTERNAL_QUERIES.length >= 4);
  // Regression: "reddit <query>" is a search term, not a filter — it returned
  // the Reddit Wikipedia page and the Reddit App Store listing.
  assert.ok(
    EXTERNAL_QUERIES.every((q) => !/\breddit\b/i.test(q)),
    'the domain filter replaces the "reddit" keyword',
  );
  assert.deepEqual(REDDIT_DOMAINS, ['reddit.com']);
});

test('collectCorpus scopes the Tavily queries to reddit.com', async () => {
  const seen = [];
  await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x', TAVILY_API_KEY: 'tvly-test' },
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async (_key, query, opts) => { seen.push({ query, opts }); return stubTavilyResults(); },
      fetchSerp: async () => stubSerpResult(),
    },
  });
  assert.equal(seen.length, EXTERNAL_QUERIES.length);
  for (const call of seen) {
    assert.deepEqual(call.opts.includeDomains, ['reddit.com'], `unscoped query: ${call.query}`);
  }
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

test('buildAnalysisPrompt explains every source label a record can carry', () => {
  const prompt = buildAnalysisPrompt(CORPUS);
  for (const label of ['judgeme', 'reddit', 'web', 'serp']) {
    assert.match(prompt, new RegExp(`\\s${label}\\s+—`), `legend is missing ${label}`);
  }
});

// Provenance is structural, not a matter of the model having obeyed the prompt.
test('runAnalysis rejects an analysis containing a quote that is not in the corpus', async () => {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(fixtureAnalysis('This lotion cured my eczema overnight.')) }],
        };
      },
    },
  };
  await assert.rejects(() => runAnalysis({ corpus: CORPUS, client }), /unsourced quote/i);
  assert.equal(calls, 2, 'an unsourced quote gets the same retry-once-then-throw path as a validation failure');
});

test('runAnalysis accepts on the retry when the second attempt sources its quotes', async () => {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        const payload = calls === 1 ? fixtureAnalysis('Invented out of thin air.') : fixtureAnalysis();
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] };
      },
    },
  };
  const { analysis } = await runAnalysis({ corpus: CORPUS, client });
  assert.equal(calls, 2);
  assert.equal(analysis.objections[0].quote, SOURCED);
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
  // collectCorpus falls back to process.env.TAVILY_API_KEY, so the test has to
  // own that variable rather than assume the developer has not exported it.
  const saved = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
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
  } finally {
    if (saved === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = saved;
  }
});

// Regression: lib/tavily.js catches every failure internally and returns [] —
// a dead key, a 401 and a network outage all look identical to "no results".
// Without counting records the corpus claimed to be complete while holding zero
// external friction, which is the one thing the spec says must never happen.
test('collectCorpus sets partial:true when Tavily silently returns [] for every query', async () => {
  const corpus = await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x', TAVILY_API_KEY: 'tvly-expired' },
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async () => [],           // exactly what lib/tavily.js does on failure
      fetchSerp: async () => stubSerpResult(),
    },
  });
  assert.equal(corpus.partial, true);
  assert.ok(!corpus.records.some((r) => r.source === 'reddit' || r.source === 'web'));
  assert.ok(corpus.records.some((r) => r.source === 'judgeme'));
});

test('collectCorpus still sets partial:true when Tavily throws for every query', async () => {
  const corpus = await collectCorpus({
    env: { JUDGEME_API_TOKEN: 'x', TAVILY_API_KEY: 'tvly-test' },
    deps: {
      fetchReviews: async () => stubReviews(),
      searchTavily: async () => { throw new Error('tavily down'); },
      fetchSerp: async () => stubSerpResult(),
    },
  });
  assert.equal(corpus.partial, true);
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

// ── empty-corpus guard ──────────────────────────────────────────────────────
// Regression: a broken JUDGEME_API_TOKEN used to make the monthly run a silent
// no-op — exit 0, "✓ complete" in the scheduler log, notify() never called.
test('emptyCorpusFailure returns null when the corpus has Judge.me reviews', () => {
  assert.equal(emptyCorpusFailure(CORPUS), null);
});

test('emptyCorpusFailure fires when the corpus has no Judge.me reviews, and names the likely cause', () => {
  const corpus = { ...CORPUS, records: CORPUS.records.filter((r) => r.source !== 'judgeme') };
  const failure = emptyCorpusFailure(corpus);
  assert.ok(failure, 'an empty review corpus must be reported as a failure');
  assert.match(failure.subject, /FAILED/);
  assert.match(failure.body, /ZERO Judge\.me reviews/);
  assert.match(failure.body, /JUDGEME_API_TOKEN/, 'must name the likely cause');
  assert.match(failure.body, /NOT refreshed/);
});

test('emptyCorpusFailure fires on a completely empty corpus', () => {
  assert.ok(emptyCorpusFailure({ records: [] }));
  assert.ok(emptyCorpusFailure({}));
});

test('the empty-corpus notification is sent with immediate:true, bypassing the digest', () => {
  // Errors must email now, not at 5 AM with the digest. Asserted against the
  // call site because main() is not importable without running the CLI.
  const src = readFileSync(new URL('../../agents/voice-of-customer/index.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/notify\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
  const errorCalls = calls.filter((c) => /status: 'error'/.test(c) || /emptyFailure/.test(c));
  assert.ok(errorCalls.length >= 2, `expected both error notify() calls, found ${errorCalls.length}`);
  for (const call of errorCalls) assert.match(call, /immediate: true/);
});

// Regression: writeArtifacts used to render-and-write one file at a time, so a
// throw in the second renderer left personas.json fresh and the two markdown
// files from last month — three artifacts that must agree, silently skewed.
test('writeArtifacts writes nothing when a later renderer throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const stale = join(root, 'data', 'context', 'personas.json');
  writeFileSync(stale, '{"personas":"LAST MONTH"}', 'utf8');

  // personas render fine; the voice-of-customer markdown blows up on a null entry.
  const analysis = { ...fixtureAnalysis(), objections: [null] };
  assert.throws(() => writeArtifacts({ analysis, corpus: CORPUS, root }));

  assert.equal(readFileSync(stale, 'utf8'), '{"personas":"LAST MONTH"}', 'personas.json must not be half-updated');
  assert.equal(existsSync(join(root, 'data', 'context', 'personas.md')), false);
  assert.equal(existsSync(join(root, 'data', 'context', 'voice-of-customer.md')), false);
});

// ── health claims never reach the persona artifacts ──────────────────────────
//
// personas.json is copy input: four agents paste its persona and angle prose into ad-copy
// prompts, and personas[0].angles[0] is the documented default angle. The corpus this agent
// reads is full of reviewers saying "eczema", "psoriasis" and "the steroids my doctor gave
// me", and on 2026-07-27 the model carried that language straight into every copy-facing
// field of the top-ranked persona.
//
// Removal, not rewriting, and no retry: runAnalysis's retry re-sends the SAME prompt with no
// feedback, so a re-roll at Opus prices has no reason to come back clean, and snipping the
// offending clause (or asking a model to) would be this agent inventing research.

function dirtyAnalysis(over = {}) {
  const base = fixtureAnalysis();
  return { ...base, personas: base.personas.map((p) => ({ ...p })), ...over };
}

test('writeArtifacts deletes an angle whose copy-facing field carries a health claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const analysis = dirtyAnalysis();
  analysis.personas[1] = {
    ...analysis.personas[1],
    angles: [
      { ...analysis.personas[1].angles[0], id: 'a2', proof: 'A reviewer with severe eczema.' },
      { id: 'a3', label: 'Clean', awareness: 'solution-aware', objection_addressed: 'o',
        proof: 'p', hook_examples: ['h'], source_quotes: [SOURCED] },
    ],
  };

  const paths = writeArtifacts({ analysis, corpus: CORPUS, root });
  const json = JSON.parse(readFileSync(paths.personasJsonPath, 'utf8'));
  const high = json.personas.find((p) => p.id === 'high');
  assert.deepEqual(high.angles.map((a) => a.id), ['a3'], 'the eczema angle must not be written');
  assert.equal(json.health_claim_drops.length, 1, 'and the loss is recorded in the artifact itself');
  assert.equal(json.health_claim_drops[0].angleId, 'a2');
  assert.equal(json.health_claim_drops[0].category, 'disease');

  // personas.md is rendered from the SAME sanitized set — the two must never disagree.
  assert.doesNotMatch(readFileSync(paths.personasMdPath, 'utf8'), /eczema/i);
  assert.equal(paths.drops.length, 1);
});

test('writeArtifacts deletes a persona whose own name or summary carries a health claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const analysis = dirtyAnalysis();
  analysis.personas[1] = { ...analysis.personas[1], name: 'The Eczema-Exhausted Parent' };

  const paths = writeArtifacts({ analysis, corpus: CORPUS, root });
  const json = JSON.parse(readFileSync(paths.personasJsonPath, 'utf8'));
  assert.deepEqual(json.personas.map((p) => p.id), ['low'], 'a disease cannot be the audience');
  assert.equal(json.personas.length, paths.personaCount);
});

test('writeArtifacts keeps source_quotes verbatim — they are evidence, not copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  // The real 2026-08-16 quote. It must survive intact: findUnsourcedQuotes matches it
  // against the corpus, and no consumer feeds source_quotes to a copy writer.
  const quote = 'I have tried prescription strength lotions, steroids, you name it.';
  const analysis = dirtyAnalysis();
  analysis.personas[1] = {
    ...analysis.personas[1],
    angles: [{ ...analysis.personas[1].angles[0], source_quotes: [quote] }],
  };

  const paths = writeArtifacts({ analysis, corpus: CORPUS, root });
  const json = JSON.parse(readFileSync(paths.personasJsonPath, 'utf8'));
  assert.deepEqual(json.personas.find((p) => p.id === 'high').angles[0].source_quotes, [quote]);
  assert.deepEqual(json.health_claim_drops, []);
});

test('writeArtifacts refuses to write an empty persona set rather than blanking the context files', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });
  writeFileSync(join(root, 'data', 'context', 'personas.json'), '{"personas":"LAST MONTH"}', 'utf8');

  const analysis = dirtyAnalysis();
  analysis.personas = analysis.personas.map((p) => ({ ...p, summary: 'Burned through prescription steroids.' }));

  assert.throws(() => writeArtifacts({ analysis, corpus: CORPUS, root }), /health claim/i);
  assert.equal(readFileSync(join(root, 'data', 'context', 'personas.json'), 'utf8'), '{"personas":"LAST MONTH"}',
    'last month\'s artifacts stay in place');
});

test('the analysis prompt tells the model the rule before it costs a call to enforce it', () => {
  const prompt = buildAnalysisPrompt(CORPUS);
  assert.match(prompt, /HEALTH-CLAIM RULE/);
  assert.match(prompt, /eczema/, 'name the disease words so the model can avoid them');
  assert.match(prompt, /steroids/, 'and the drug words');
  assert.match(prompt, /source_quotes` is the ONE exception/, 'without this it would launder quotes to comply');
});
