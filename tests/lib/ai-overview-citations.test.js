import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDomain,
  extractAiOverview,
  organicRankOf,
  summarizeQueryRuns,
  summarizeReport,
  renderMarkdown,
} from '../../lib/ai-overview-citations.js';

/**
 * Every fixture below is the SHAPE returned by a live
 * /v3/serp/google/organic/live/advanced pull on 2026-09-06, trimmed. The two
 * details that matter — `domain` carrying a `www.` prefix, and references
 * appearing at BOTH the item level and the element level — are properties of the
 * real response, not of a convenient stub.
 */
const liveItems = [
  {
    type: 'ai_overview',
    rank_group: 1,
    asynchronous_ai_overview: false,
    items: [
      {
        type: 'ai_overview_element',
        title: null,
        text: 'Yes, you can use coconut oil as a natural deodorant.',
        references: [
          {
            type: 'ai_overview_reference',
            source: 'www.realskincare.com',
            domain: 'www.realskincare.com',
            url: 'https://www.realskincare.com/blogs/news/coconut-oil-deodorant',
            title: 'Coconut Oil as Deodorant: Does It Actually Work?',
          },
        ],
      },
      {
        type: 'ai_overview_element',
        title: 'How It Works',
        text: 'Kills bacteria: Coconut oil contains lauric acid.',
        references: [
          { type: 'ai_overview_reference', source: 'Healthline', domain: 'www.healthline.com', url: 'https://www.healthline.com/x' },
        ],
      },
    ],
    references: [
      { type: 'ai_overview_reference', source: 'www.realskincare.com', domain: 'www.realskincare.com', url: 'https://www.realskincare.com/blogs/news/coconut-oil-deodorant' },
      { type: 'ai_overview_reference', source: 'Healthline', domain: 'www.healthline.com', url: 'https://www.healthline.com/x' },
    ],
  },
  { type: 'organic', rank_group: 1, domain: 'www.healthline.com', url: 'https://www.healthline.com/x' },
  { type: 'organic', rank_group: 5, domain: 'www.realskincare.com', url: 'https://www.realskincare.com/blogs/news/coconut-oil-deodorant' },
  { type: 'people_also_ask', items: [] },
];

test('normalizeDomain strips the www. the API actually returns', () => {
  // The whole measurement turns on this: DataForSEO reports `www.realskincare.com`
  // and a naive equality against `realskincare.com` reports zero citations
  // forever, which is indistinguishable from a real zero.
  assert.equal(normalizeDomain('www.realskincare.com'), 'realskincare.com');
  assert.equal(normalizeDomain('realskincare.com'), 'realskincare.com');
  assert.equal(normalizeDomain('WWW.RealSkinCare.com.'), 'realskincare.com');
  assert.equal(normalizeDomain('https://www.realskincare.com/blogs/news/x'), 'realskincare.com');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
  // A subdomain that is not `www` is a DIFFERENT host and must stay one.
  assert.equal(normalizeDomain('health.clevelandclinic.org'), 'health.clevelandclinic.org');
});

test('extractAiOverview reads presence, references and text off a live item', () => {
  const aio = extractAiOverview(liveItems);
  assert.equal(aio.present, true);
  assert.equal(aio.asynchronous, false);
  assert.deepEqual(aio.domains, ['realskincare.com', 'healthline.com']);
  assert.match(aio.text, /natural deodorant/);
  assert.match(aio.text, /lauric acid/, 'element texts are joined, not just the first');
  assert.equal(aio.references[0].domain, 'realskincare.com');
  assert.equal(aio.references[0].raw_domain, 'www.realskincare.com', 'the API value is kept verbatim beside the normalized one');
});

test('extractAiOverview unions item-level and element-level references', () => {
  // On the two live pulls the top-level array was the complete union, but the
  // element-level arrays are where the API documents them, so a reference
  // present in only one place must still count.
  const itemsElementOnly = [{
    type: 'ai_overview',
    asynchronous_ai_overview: false,
    items: [{ type: 'ai_overview_element', text: 'x', references: [{ domain: 'www.realskincare.com' }] }],
    references: [],
  }];
  assert.deepEqual(extractAiOverview(itemsElementOnly).domains, ['realskincare.com']);

  const itemsTopOnly = [{
    type: 'ai_overview',
    asynchronous_ai_overview: false,
    items: [{ type: 'ai_overview_element', text: 'x', references: null }],
    references: [{ domain: 'www.realskincare.com' }],
  }];
  assert.deepEqual(extractAiOverview(itemsTopOnly).domains, ['realskincare.com']);
});

test('extractAiOverview reports NO OVERVIEW and AN UNDELIVERED one as different states', () => {
  const none = extractAiOverview([{ type: 'organic', rank_group: 1, domain: 'x.com' }]);
  assert.equal(none.present, false);
  assert.equal(none.resolved, false);
  assert.deepEqual(none.domains, []);

  // The live shape of an overview Google loaded asynchronously, on a request
  // that did NOT ask for it: every content field is null. Counting that as "an
  // overview with no references" manufactures a false zero.
  const undelivered = extractAiOverview([{ type: 'ai_overview', asynchronous_ai_overview: true, markdown: null, items: null, references: null }]);
  assert.equal(undelivered.present, true);
  assert.equal(undelivered.asynchronous, true);
  assert.equal(undelivered.resolved, false);
  assert.deepEqual(undelivered.domains, []);

  assert.equal(extractAiOverview([]).present, false);
  assert.equal(extractAiOverview(null).present, false);
});

test('THE ASYNC FLAG IS NOT THE TEST — content delivered is', () => {
  // With `load_async_ai_overview: true` on the request, the SAME item comes back
  // carrying its content and the flag STILL reads true. Keying "unresolved" off
  // the flag threw away 46% of a live 90-run sample that was in fact readable —
  // and the discarded queries were not random (toothpaste and long-tail), so it
  // biased the rate rather than merely thinning it.
  const loaded = extractAiOverview([{
    type: 'ai_overview',
    asynchronous_ai_overview: true,
    markdown: '...',
    items: [{ type: 'ai_overview_element', text: 'x', references: null }],
    references: [{ domain: 'www.realskincare.com' }, { domain: 'www.reddit.com' }],
  }]);
  assert.equal(loaded.asynchronous, true);
  assert.equal(loaded.resolved, true, 'the flag says HOW it loaded, not WHETHER we got it');
  assert.deepEqual(loaded.domains, ['realskincare.com', 'reddit.com']);

  // An overview that genuinely cites nobody arrives as an empty ARRAY, and that
  // is a measured zero rather than a missing measurement.
  const empty = extractAiOverview([{ type: 'ai_overview', asynchronous_ai_overview: false, items: [], references: [] }]);
  assert.equal(empty.resolved, true);
  assert.deepEqual(empty.domains, []);
});

test('organicRankOf finds our rank through the www prefix, or reports null', () => {
  assert.equal(organicRankOf(liveItems, 'realskincare.com'), 5);
  assert.equal(organicRankOf(liveItems, 'healthline.com'), 1);
  assert.equal(organicRankOf(liveItems, 'nowhere.example'), null);
  assert.equal(organicRankOf([], 'realskincare.com'), null);
});

test('summarizeQueryRuns rates citations against RESOLVED overviews, not against runs', () => {
  const runs = [
    { present: true, resolved: true, asynchronous: false, domains: ['realskincare.com', 'healthline.com'], organic_rank: 5 },
    { present: true, resolved: true, asynchronous: false, domains: ['healthline.com'], organic_rank: 5 },
    { present: false, resolved: false, asynchronous: false, domains: [], organic_rank: 6 },
  ];
  const s = summarizeQueryRuns(runs, 'realskincare.com');
  assert.equal(s.runs, 3);
  assert.equal(s.overviews_resolved, 2, 'the run with no overview is not a chance to be cited');
  assert.equal(s.cited_runs, 1);
  assert.equal(s.overview_rate, 2 / 3, 'presence is rated over ALL runs');
  assert.equal(s.citation_rate, 0.5, 'citation is rated over runs that HAD an overview');
  assert.equal(s.ever_cited, true);
  assert.equal(s.organic_rank, 5, 'the best rank seen across runs');
});

test('summarizeQueryRuns excludes an unresolved overview from the denominator', () => {
  const s = summarizeQueryRuns([
    { present: true, resolved: false, asynchronous: true, domains: [], organic_rank: null },
    { present: true, resolved: true, asynchronous: false, domains: ['realskincare.com'], organic_rank: null },
  ], 'realskincare.com');
  assert.equal(s.overviews_resolved, 1);
  assert.equal(s.citation_rate, 1, 'not 0.5 — the pending one was never a chance to be cited');
  assert.equal(s.overviews_unresolved, 1);
});

test('summarizeQueryRuns returns a null rate rather than a zero when nothing resolved', () => {
  // A rate of 0 says "measured, never cited". A null says "not measured". The
  // whole point of the task is a rate with an n behind it, so the two must not
  // collapse — the same reason a stale seo-impact report disarms a gate loudly
  // instead of reading as a clean run.
  const s = summarizeQueryRuns([{ present: false, resolved: false, asynchronous: false, domains: [], organic_rank: null }], 'realskincare.com');
  assert.equal(s.overviews_resolved, 0);
  assert.equal(s.citation_rate, null);
  assert.equal(s.ever_cited, false);
});

test('summarizeQueryRuns handles zero runs without dividing by zero', () => {
  const s = summarizeQueryRuns([], 'realskincare.com');
  assert.equal(s.runs, 0);
  assert.equal(s.overview_rate, null);
  assert.equal(s.citation_rate, null);
});

test('summarizeReport rates over QUERIES and counts who else is cited', () => {
  const queries = [
    { query: 'a', impressions: 700, withheld: null, summary: { runs: 3, overviews_resolved: 3, cited_runs: 3, citation_rate: 1, overview_rate: 1, ever_cited: true, organic_rank: 5, overviews_unresolved: 0 }, cited_domains: { 'realskincare.com': 3, 'healthline.com': 2 } },
    { query: 'b', impressions: 300, withheld: null, summary: { runs: 3, overviews_resolved: 3, cited_runs: 0, citation_rate: 0, overview_rate: 1, ever_cited: false, organic_rank: null, overviews_unresolved: 0 }, cited_domains: { 'healthline.com': 3, 'reddit.com': 1 } },
    { query: 'c', impressions: 100, withheld: 'diy', summary: { runs: 3, overviews_resolved: 0, cited_runs: 0, citation_rate: null, overview_rate: 0, ever_cited: false, organic_rank: null, overviews_unresolved: 0 }, cited_domains: {} },
  ];
  const r = summarizeReport(queries);
  assert.equal(r.queries, 3);
  assert.equal(r.queries_measurable, 2, 'query c never produced an overview and cannot be rated');
  assert.equal(r.queries_ever_cited, 1);
  assert.equal(r.citation_rate_by_query, 0.5);
  assert.equal(r.total_runs, 9);
  // Rate over runs, which is the honest n: 3 cited of 6 resolved.
  assert.equal(r.citation_rate_by_run, 0.5);
  assert.equal(r.top_cited_domains[0].domain, 'healthline.com', 'ranked by how many overviews cited them');
  assert.equal(r.top_cited_domains[0].overviews, 5);
  // The feed's withheld classes are reported SEPARATELY rather than dropped:
  // whether Google cites us on a DIY query is a real finding, but it is not the
  // commercial rate.
  assert.equal(r.commercial.queries, 2);
  assert.equal(r.withheld.queries, 1);
});

test('renderMarkdown states the n beside every rate', () => {
  const md = renderMarkdown({
    generated_at: '2026-09-06T00:00:00.000Z',
    target_domain: 'realskincare.com',
    runs_per_query: 3,
    report: summarizeReport([
      { query: 'can you use coconut oil as deodorant', impressions: 719, withheld: null, summary: { runs: 3, overviews_resolved: 3, cited_runs: 3, citation_rate: 1, overview_rate: 1, ever_cited: true, organic_rank: 5, overviews_unresolved: 0 }, cited_domains: { 'realskincare.com': 3 } },
    ]),
    queries: [
      { query: 'can you use coconut oil as deodorant', impressions: 719, withheld: null, summary: { runs: 3, overviews_resolved: 3, cited_runs: 3, citation_rate: 1, overview_rate: 1, ever_cited: true, organic_rank: 5, overviews_unresolved: 0 }, cited_domains: { 'realskincare.com': 3 } },
    ],
  });
  assert.match(md, /can you use coconut oil as deodorant/);
  assert.match(md, /3\/3/, 'a rate without its n is the defect this task exists to fix');
  assert.match(md, /719/);
});
