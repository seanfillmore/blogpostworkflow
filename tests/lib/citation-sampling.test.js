import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateRuns,
  summarizeSources,
  runsForPrompt,
  samplingMeta,
} from '../../lib/citation-sampling.js';

const run = (over = {}) => ({
  cited: null,
  mentioned: false,
  citations: [],
  citation_urls: [],
  competitor_mentions: [],
  competitor_citations: [],
  ...over,
});

/**
 * The old inline aggregation, transcribed from agents/ai-citation-tracker as it
 * stood before repeated sampling. The whole safety argument for this change is
 * that at 1 run per cell nothing moves, so the test compares against the real
 * previous implementation rather than against numbers someone typed by hand.
 */
function legacySummarize(results, sourceNames) {
  const citationRate = {};
  const mentionRate = {};
  const competitorMentionCounts = {};
  const competitorCitationCounts = {};

  for (const source of sourceNames) {
    let citedCount = 0;
    let citedTotal = 0;
    let mentionedCount = 0;

    for (const r of results) {
      const resp = r.responses[source];
      if (!resp) continue;
      if (resp.cited !== null) {
        citedTotal++;
        if (resp.cited) citedCount++;
      }
      if (resp.mentioned) mentionedCount++;
      for (const comp of resp.competitor_mentions) {
        competitorMentionCounts[comp] = (competitorMentionCounts[comp] || 0) + 1;
      }
      for (const comp of resp.competitor_citations) {
        competitorCitationCounts[comp] = (competitorCitationCounts[comp] || 0) + 1;
      }
    }

    if (citedTotal > 0) citationRate[source] = parseFloat((citedCount / citedTotal).toFixed(4));
    mentionRate[source] = parseFloat((mentionedCount / results.length).toFixed(4));
  }

  return {
    citation_rate: citationRate,
    mention_rate: mentionRate,
    top_competitor_mentions: Object.fromEntries(
      Object.entries(competitorMentionCounts).sort((a, b) => b[1] - a[1])),
    top_competitor_citations: Object.fromEntries(
      Object.entries(competitorCitationCounts).sort((a, b) => b[1] - a[1])),
  };
}

test('at 1 run per cell every summary figure matches the pre-sampling implementation', () => {
  // A deliberately awkward corpus: a cited cell, an uncited-but-mentioned cell,
  // a cell with no citations at all (the null case the citation denominator
  // must exclude), and a hard error.
  const raw = [
    {
      prompt: 'best natural deodorant',
      responses: {
        openai: run({ cited: true, mentioned: true, citations: ['realskincare.com'], citation_urls: ['https://realskincare.com/a'], competitor_mentions: ['Native'] }),
        perplexity: run({ cited: false, mentioned: false, citations: ['native.com'], citation_urls: ['https://native.com/x'], competitor_mentions: ['Native'], competitor_citations: ['Native'] }),
      },
    },
    {
      prompt: 'best coconut oil toothpaste',
      responses: {
        openai: run({ cited: null, mentioned: true }),
        perplexity: run({ cited: null, mentioned: false, error: 'HTTP 429' }),
      },
    },
  ];

  const sources = ['openai', 'perplexity'];
  const legacy = legacySummarize(raw, sources);

  // Same corpus, each cell put through the one-run aggregation path.
  const wrapped = raw.map(r => ({
    prompt: r.prompt,
    responses: Object.fromEntries(
      Object.entries(r.responses).map(([s, resp]) => [s, aggregateRuns([resp])]),
    ),
  }));
  const now = summarizeSources(wrapped, sources);

  assert.deepEqual(now.citation_rate, legacy.citation_rate);
  assert.deepEqual(now.mention_rate, legacy.mention_rate);
  assert.deepEqual(now.top_competitor_mentions, legacy.top_competitor_mentions);
  assert.deepEqual(now.top_competitor_citations, legacy.top_competitor_citations);
});

test('aggregateRuns preserves the legacy per-source field names and meanings', () => {
  const agg = aggregateRuns([
    run({ cited: true, mentioned: true, citations: ['a.com'], citation_urls: ['https://a.com/1'], competitor_mentions: ['Native'] }),
    run({ cited: false, mentioned: false, citations: ['b.com'], citation_urls: ['https://b.com/2'], competitor_citations: ['Schmidt'] }),
    run({ cited: false, mentioned: true, citations: ['a.com'], citation_urls: ['https://a.com/1'] }),
  ]);

  // lib/pr-targets.js reads exactly these five fields — it must not need a change.
  assert.equal(agg.cited, true, 'cited is true when any run cited');
  assert.equal(agg.mentioned, true, 'mentioned is true when any run mentioned');
  assert.deepEqual(agg.citations, ['a.com', 'b.com'], 'domains unioned, first-seen order, deduped');
  assert.deepEqual(agg.citation_urls, ['https://a.com/1', 'https://b.com/2']);
  assert.deepEqual(agg.competitor_mentions, ['Native']);
  assert.deepEqual(agg.competitor_citations, ['Schmidt']);

  assert.equal(agg.runs, 3);
  assert.equal(agg.cited_runs, 1);
  assert.equal(agg.mentioned_runs, 2);
});

test('a rate over runs reports the split a single run would have hidden', () => {
  // The whole point: 1-of-3 and 3-of-3 are different findings that a single
  // observation reports identically (as a bare "true").
  const thin = aggregateRuns([
    run({ cited: true, mentioned: true, citations: ['x.com'] }),
    run({ cited: false, mentioned: false, citations: ['y.com'] }),
    run({ cited: false, mentioned: false, citations: ['y.com'] }),
  ]);
  const solid = aggregateRuns([
    run({ cited: true, mentioned: true, citations: ['x.com'] }),
    run({ cited: true, mentioned: true, citations: ['x.com'] }),
    run({ cited: true, mentioned: true, citations: ['x.com'] }),
  ]);

  assert.equal(thin.cited, solid.cited, 'the legacy boolean cannot tell them apart');

  const summary = summarizeSources([
    { prompt: 'p1', responses: { openai: thin } },
    { prompt: 'p2', responses: { openai: solid } },
  ], ['openai']);

  assert.equal(summary.citation_rate.openai, 0.6667, '4 cited runs of 6 with citations');
  assert.equal(summary.citation_rate_n.openai, 6, 'the denominator travels with the rate');
  assert.equal(summary.mention_rate.openai, 0.6667);
  assert.equal(summary.mention_rate_n.openai, 6);
});

test('a cell where every run errored reproduces the legacy error record', () => {
  const agg = aggregateRuns([
    run({ error: 'HTTP 429' }),
    run({ error: 'HTTP 429' }),
  ]);

  assert.equal(agg.cited, null);
  assert.equal(agg.mentioned, false);
  assert.deepEqual(agg.citations, []);
  assert.equal(agg.error, 'HTTP 429');
  assert.equal(agg.runs_ok, 0);
  // The old error path omitted citation_urls entirely; a consumer testing for
  // its presence must not start seeing an empty array where there was nothing.
  assert.ok(!('citation_urls' in agg), 'citation_urls stays absent on the all-error path');
});

test('a partially failing cell keeps the runs that succeeded', () => {
  // The ChatGPT source is currently 429/quota-blocked, so this is the live shape.
  const agg = aggregateRuns([
    run({ error: 'HTTP 429' }),
    run({ cited: true, mentioned: true, citations: ['realskincare.com'] }),
    run({ error: 'HTTP 429' }),
  ]);

  assert.equal(agg.cited, true);
  assert.equal(agg.runs, 3);
  assert.equal(agg.runs_ok, 1);
  assert.equal(agg.cited_runs, 1);
  assert.ok(!('error' in agg), 'a cell that answered once is not an errored cell');
});

test('the citation denominator excludes runs that returned no citations at all', () => {
  const agg = aggregateRuns([
    run({ cited: null, mentioned: true }),
    run({ cited: null, mentioned: true }),
    run({ cited: false, mentioned: true, citations: ['rival.com'] }),
  ]);

  assert.equal(agg.runs_with_citations, 1, 'only the run that produced citations counts');
  assert.equal(agg.cited, false, 'not null — one run could answer the question');

  const summary = summarizeSources([{ prompt: 'p', responses: { openai: agg } }], ['openai']);
  assert.equal(summary.citation_rate.openai, 0);
  assert.equal(summary.citation_rate_n.openai, 1, 'citation n is 1, mention n is 3');
  assert.equal(summary.mention_rate_n.openai, 3);
});

test('a cell where no run produced citations reports null, not false', () => {
  const agg = aggregateRuns([run({ cited: null }), run({ cited: null })]);
  assert.equal(agg.cited, null, '"we do not know" must not collapse into "we were not cited"');

  const summary = summarizeSources([{ prompt: 'p', responses: { openai: agg } }], ['openai']);
  assert.ok(!('openai' in summary.citation_rate), 'no citation rate is emitted at all');
});

test('competitor tallies count once per cell, not once per run', () => {
  // Counting per run would triple every count against history while nothing
  // changed in the world — the basis-drift this module exists to avoid.
  const threeRuns = aggregateRuns([
    run({ competitor_mentions: ['Native'] }),
    run({ competitor_mentions: ['Native'] }),
    run({ competitor_mentions: ['Native'] }),
  ]);
  const oneRun = aggregateRuns([run({ competitor_mentions: ['Native'] })]);

  const many = summarizeSources([{ prompt: 'p', responses: { openai: threeRuns } }], ['openai']);
  const one = summarizeSources([{ prompt: 'p', responses: { openai: oneRun } }], ['openai']);

  assert.deepEqual(many.top_competitor_mentions, one.top_competitor_mentions);
  assert.equal(many.top_competitor_mentions.Native, 1);
});

test('runsForPrompt repeats only the core prefix and is stable across weeks', () => {
  assert.equal(runsForPrompt(0, { runs: 3, coreSize: 20 }), 3);
  assert.equal(runsForPrompt(19, { runs: 3, coreSize: 20 }), 3);
  assert.equal(runsForPrompt(20, { runs: 3, coreSize: 20 }), 1, 'the tail is sampled once');
  assert.equal(runsForPrompt(74, { runs: 3, coreSize: 0 }), 3, 'coreSize 0 repeats everything');
  assert.equal(runsForPrompt(0, { runs: 1, coreSize: 20 }), 1, 'runs 1 disables repetition');
});

test('samplingMeta states the call cost before the run rather than after the bill', () => {
  // The real configuration: 75 prompts, 5 sources.
  const off = samplingMeta({ prompts: 75, sources: 5, runs: 1, coreSize: 0 });
  assert.equal(off.total_calls, 375, 'unchanged from the pre-sampling cost');
  assert.equal(off.runs_per_core_cell, 1);

  const all = samplingMeta({ prompts: 75, sources: 5, runs: 3, coreSize: 0 });
  assert.equal(all.total_calls, 1125, 'repeating everything is 3x');

  const core = samplingMeta({ prompts: 75, sources: 5, runs: 3, coreSize: 20 });
  assert.equal(core.total_calls, 575, '20 prompts x3 + 55 x1, all x5 sources');
  assert.equal(core.core_prompts, 20);
  assert.equal(core.tail_prompts, 55);
});

test('aggregateRuns refuses an empty run list rather than inventing a cell', () => {
  assert.throws(() => aggregateRuns([]), /at least one run/);
});
