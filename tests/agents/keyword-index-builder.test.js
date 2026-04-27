import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

import { aggregateGscWindow } from '../../lib/keyword-index/gsc-aggregator.js';
import { aggregateGa4Window } from '../../lib/keyword-index/ga4-aggregator.js';
import { parseSqpReport, mergeSqpReports } from '../../lib/keyword-index/amazon-sqp.js';
import { parseBaReportStream } from '../../lib/keyword-index/amazon-ba.js';
import { mergeSources } from '../../lib/keyword-index/merge.js';
import { rollUpCompetitorsByCluster } from '../../lib/keyword-index/competitors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'keyword-index');

test('keyword-index-builder agent exists', () => {
  assert.ok(existsSync('agents/keyword-index-builder/index.js'));
});

test('agent imports the expected lib modules', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes("lib/keyword-index/dump-readers"), 'imports dump-readers (Stage 1 source)');
  assert.ok(src.includes("lib/keyword-index/amazon-ba"), 'imports BA module (parseBaReportStream)');
  assert.ok(src.includes("lib/keyword-index/rsc-asins"), 'imports RSC ASIN extractor');
  assert.ok(src.includes("lib/keyword-index/gsc-aggregator"), 'imports GSC aggregator');
  assert.ok(src.includes("lib/keyword-index/ga4-aggregator"), 'imports GA4 aggregator');
  assert.ok(src.includes("lib/keyword-index/merge"), 'imports merger');
  assert.ok(src.includes("lib/keyword-index/competitors"), 'imports competitors');
  assert.ok(src.includes("lib/keyword-index/dataforseo-enricher"), 'imports enricher');
  assert.ok(src.includes("lib/notify.js"), 'imports notify');
});

test('agent does NOT call SP-API live (Stage 1 reads dumps only)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  // The orchestrator must NOT import the live SP-API client — that's the
  // explore scripts' responsibility (run on weekly cron).
  assert.ok(!src.includes("lib/amazon/sp-api-client"), 'orchestrator must not import the SP-API client');
  assert.ok(!src.includes('fetchSqpReportForAsin'), 'orchestrator must not call live SQP fetcher');
  assert.ok(!src.includes('fetchBaReport'), 'orchestrator must not call live BA fetcher');
});

test('agent supports --dry-run and --force flags', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes('--dry-run'), 'has --dry-run flag handling');
  assert.ok(src.includes('--force'), 'has --force flag handling');
});

test('agent has self-pace check (skips if < 14 days since last build)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(/built_at|last_built_at/.test(src), 'reads built_at from prior index');
  assert.ok(/14|REBUILD_DAYS/.test(src), 'has 14-day cadence threshold');
});

test('agent writes both output files atomically (temp-then-rename)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes('keyword-index.json'), 'writes keyword-index.json');
  assert.ok(src.includes('category-competitors.json'), 'writes category-competitors.json');
  assert.ok(/\.tmp-|renameSync/.test(src), 'uses temp-then-rename for atomicity');
});

test('integration: full build from fixtures produces well-formed outputs', async () => {
  // Stage 1: Amazon SQP
  const sqpRaw = JSON.parse(readFileSync(join(FIXTURES, 'sqp', 'sample-asin-report.json'), 'utf8'));
  const sqpPerAsin = parseSqpReport(sqpRaw);
  const amazonMap = mergeSqpReports([sqpPerAsin]);

  // Stage 2: Amazon BA
  const baCompetitors = await parseBaReportStream({
    filePath: join(FIXTURES, 'ba', 'sample-search-terms.jsonl'),
    rscAsins: new Set(['B0FAKERSC']),
  });

  // Merge BA into Amazon map
  for (const [key, ba] of Object.entries(baCompetitors)) {
    if (amazonMap[key]) {
      amazonMap[key].search_frequency_rank = ba.search_frequency_rank;
      amazonMap[key].competitors = ba.competitors;
    }
  }

  // Stage 3: GSC
  const gscMap = aggregateGscWindow({
    snapshotsDir: join(FIXTURES, 'gsc'),
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });

  // Stage 4: GA4
  const ga4Map = aggregateGa4Window({
    snapshotsDir: join(FIXTURES, 'ga4'),
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });

  // Stage 5: Merge all sources
  const entries = mergeSources({
    amazon: amazonMap,
    gsc: gscMap,
    ga4Map,
    clusters: { 'natural deodorant for women': 'deodorant' },
  });

  assert.ok(Object.keys(entries).length > 0, 'should produce at least one entry');

  // Find the natural-deodorant entry — should be amazon-validated, with GSC merged in if available, and BA competitors.
  const natural = Object.values(entries).find((e) => e.keyword === 'natural deodorant for women');
  assert.ok(natural, 'natural deodorant entry exists');
  assert.equal(natural.validation_source, 'amazon', 'validation source is amazon');
  assert.ok(natural.amazon, 'amazon data present');
  assert.equal(natural.amazon.purchases, 38, 'amazon purchases = 38 from SQP fixture');
  assert.ok(Array.isArray(natural.amazon.competitors), 'competitors is an array');
  assert.equal(natural.amazon.competitors.length, 2, 'competitors.length = 2 from BA fixture (B0NATIVE, B0DOVE)');
  assert.equal(natural.cluster, 'deodorant', 'cluster = deodorant');

  // Stage 6: Competitor roll-up
  const clusterCompetitors = rollUpCompetitorsByCluster(entries);
  assert.ok(clusterCompetitors.deodorant, 'deodorant cluster exists in roll-up');
  assert.equal(clusterCompetitors.deodorant.keyword_count, 1, 'deodorant cluster has 1 keyword');
  assert.ok(Array.isArray(clusterCompetitors.deodorant.competitors), 'competitors is an array');
  assert.ok(clusterCompetitors.deodorant.competitors.length > 0, 'deodorant cluster has at least 1 competitor');
  assert.ok(clusterCompetitors.deodorant.total_purchases > 0, 'deodorant cluster has total_purchases > 0');
});
