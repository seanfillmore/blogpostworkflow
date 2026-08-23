// tests/agents/seo-opportunity-queue-item-integration.test.js
//
// End-to-end check of the handoff a recent producer->consumer inventory flagged
// HIGH risk but could not test: agents/seo-opportunity-analyzer/index.js stages a
// queue item, and when a human approves it on the dashboard,
// agents/dashboard/lib/opportunity-trigger.js's buildTriggerCommand(item) reads it
// back to decide which executor agent to spawn and with what arguments. Extracting
// the shaping logic into queue-item.js (see
// tests/agents/seo-opportunity-analyzer-queue-item.test.js) is what makes this
// reachable without a live GSC + paid DataForSEO run.
//
// This mirrors tests/lib/demand-questions-leaks-integration.test.js on `main`: build
// the fixture from the REAL producing module's shape (lib/seo-opportunities.js's
// analyzeOpportunities), run the real producer shaping function and the real
// consumer, and assert real values survive the round trip — not a hand-written
// object shaped to match what each side's own unit tests already expect. That gap
// is exactly how a prior bug shipped here: a producer destructured a field the real
// row never carried, JSON.stringify silently dropped the resulting `undefined` key,
// and the consumer discarded everything — every unit test still passed because each
// side's fixtures were written from a plan, not from the other side's real output.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeOpportunities } from '../../lib/seo-opportunities.js';
import { buildOpportunityQueueItem } from '../../agents/seo-opportunity-analyzer/queue-item.js';
import { buildTriggerCommand, agentForOpportunityItem, keywordForItem } from '../../agents/dashboard/lib/opportunity-trigger.js';

const HOST = 'https://www.realskincare.com';
const NOW = '2026-08-21T00:00:00.000Z';

test('a rank_push collection opportunity survives staging and approval as collection-linker --url --keyword --apply', () => {
  // Real GSC row shape (keyword, page, impressions, clicks, ctr, position) plus
  // the volume enrichment main() adds before handing rows to analyzeOpportunities.
  const rows = [
    { keyword: 'unscented lotion for eczema', page: `${HOST}/collections/unscented-lotion`, impressions: 900, clicks: 5, ctr: 0.0055, position: 14, volume: 720 },
    { keyword: 'fragrance free lotion eczema', page: `${HOST}/collections/unscented-lotion`, impressions: 300, clicks: 1, ctr: 0.0033, position: 16, volume: 210 },
  ];
  const [opp] = analyzeOpportunities(rows, { productHandles: [] });
  assert.equal(opp.action, 'rank_push');
  assert.equal(opp.page_type, 'collection');

  // Producer: exactly what main() passes to writeItem(...).
  const item = buildOpportunityQueueItem(opp, { host: HOST, now: NOW });

  // Consumer: exactly what the dashboard runs when a human approves this item.
  assert.equal(agentForOpportunityItem(item), 'collection-linker');
  assert.equal(keywordForItem(item), 'unscented lotion for eczema', 'target_keyword must survive to the consumer');

  const cmd = buildTriggerCommand(item);
  assert.equal(cmd.agent, 'collection-linker');
  assert.equal(cmd.script, 'agents/collection-linker/index.js');
  assert.deepEqual(cmd.args, [
    '--url', `${HOST}/collections/unscented-lotion`,
    '--keyword', 'unscented lotion for eczema',
    '--apply',
  ]);
});

test('a refresh collection opportunity survives staging and approval as collection-content-optimizer --handle --queue', () => {
  const rows = [
    { keyword: 'deep collection query', page: `${HOST}/collections/refresh-me`, impressions: 500, clicks: 1, ctr: 0.002, position: 35, volume: 300 },
  ];
  const [opp] = analyzeOpportunities(rows, { productHandles: [] });
  assert.equal(opp.action, 'refresh');

  const item = buildOpportunityQueueItem(opp, { host: HOST, now: NOW });

  assert.equal(agentForOpportunityItem(item), 'collection-content-optimizer');
  const cmd = buildTriggerCommand(item);
  assert.equal(cmd.agent, 'collection-content-optimizer');
  assert.equal(cmd.script, 'agents/collection-content-optimizer/index.js');
  assert.deepEqual(cmd.args, ['--handle', 'refresh-me', '--queue']);
});

test('the consumer re-derives the agent from signal_source.page + recommended_action rather than trusting the stored recommended_agent — the producer\'s value still matches, pinning that the two stay in sync', () => {
  const rows = [
    { keyword: 'unscented lotion for eczema', page: `${HOST}/collections/unscented-lotion`, impressions: 900, clicks: 5, ctr: 0.0055, position: 14, volume: 720 },
  ];
  const [opp] = analyzeOpportunities(rows, { productHandles: [] });
  const item = buildOpportunityQueueItem(opp, { host: HOST, now: NOW });

  assert.equal(item.recommended_agent, agentForOpportunityItem(item), 'producer and consumer must agree on which agent runs this item');
});

test('the full key set written by the producer is exactly what the consumer + performance-queue UI expect — nothing silently dropped', () => {
  const rows = [
    { keyword: 'unscented lotion for eczema', page: `${HOST}/collections/unscented-lotion`, impressions: 900, clicks: 5, ctr: 0.0055, position: 14, volume: 720 },
  ];
  const [opp] = analyzeOpportunities(rows, { productHandles: [] });
  const item = buildOpportunityQueueItem(opp, { host: HOST, now: NOW });

  assert.deepEqual(Object.keys(item).sort(), [
    'created_at', 'recommended_action', 'recommended_agent', 'resource_type',
    'signal_source', 'slug', 'status', 'summary', 'target_keyword', 'title', 'trigger',
  ]);
  // The two fields buildTriggerCommand actually reads off signal_source.
  assert.deepEqual(Object.keys(item.signal_source).sort(), [
    'cluster_volume', 'impressions', 'keywords', 'page', 'page_type', 'position', 'type',
  ]);
  assert.ok('page' in item.signal_source, 'buildTriggerCommand reads signal_source.page — must not be dropped');
});
