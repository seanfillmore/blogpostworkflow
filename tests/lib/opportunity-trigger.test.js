import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleFromUrl,
  keywordForItem,
  agentForOpportunityItem,
  buildTriggerCommand,
} from '../../agents/dashboard/lib/opportunity-trigger.js';

// ── handleFromUrl ────────────────────────────────────────────────────────────
test('handleFromUrl extracts the last path segment', () => {
  assert.equal(handleFromUrl('https://www.realskincare.com/collections/unscented-lotion'), 'unscented-lotion');
  assert.equal(handleFromUrl('https://www.realskincare.com/blogs/news/best-soap-for-tattoos'), 'best-soap-for-tattoos');
  assert.equal(handleFromUrl('https://www.realskincare.com/collections/unscented-lotion/'), 'unscented-lotion');
  assert.equal(handleFromUrl('https://www.realskincare.com/collections/x?foo=1#h'), 'x');
  assert.equal(handleFromUrl(''), null);
});

// ── keywordForItem ───────────────────────────────────────────────────────────
test('keywordForItem prefers target_keyword, then title, then signal keywords', () => {
  assert.equal(keywordForItem({ target_keyword: 'a', title: 'SEO opportunity: b' }), 'a');
  assert.equal(keywordForItem({ title: 'SEO opportunity: coconut oil body lotion' }), 'coconut oil body lotion');
  assert.equal(keywordForItem({ signal_source: { keywords: ['fallback kw'] } }), 'fallback kw');
  assert.equal(keywordForItem({}), null);
});

// ── agentForOpportunityItem ──────────────────────────────────────────────────
test('agentForOpportunityItem derives from page URL + action', () => {
  const coll = { recommended_action: 'rank_push', signal_source: { page: 'https://www.realskincare.com/collections/coconut-oil-lotion' } };
  assert.equal(agentForOpportunityItem(coll), 'collection-linker');
  const collRefresh = { recommended_action: 'refresh', signal_source: { page: 'https://www.realskincare.com/collections/unscented-lotion' } };
  assert.equal(agentForOpportunityItem(collRefresh), 'collection-content-optimizer');
  const blog = { recommended_action: 'rank_push', signal_source: { page: 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos' } };
  assert.equal(agentForOpportunityItem(blog), 'refresh-runner');
});

test('agentForOpportunityItem re-derives, ignoring a stale/buggy stored recommended_agent', () => {
  // legacy blog item wrongly tagged collection-linker under old routing → must re-derive to refresh-runner
  const stale = {
    recommended_agent: 'collection-linker',
    recommended_action: 'rank_push',
    signal_source: { page: 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos' },
  };
  assert.equal(agentForOpportunityItem(stale), 'refresh-runner');
});

// ── buildTriggerCommand ──────────────────────────────────────────────────────
test('buildTriggerCommand: collection refresh → collection-content-optimizer --handle --queue', () => {
  const item = {
    recommended_action: 'refresh',
    title: 'SEO opportunity: unscented lotion',
    signal_source: { page: 'https://www.realskincare.com/collections/unscented-lotion' },
  };
  const cmd = buildTriggerCommand(item);
  assert.equal(cmd.agent, 'collection-content-optimizer');
  assert.equal(cmd.script, 'agents/collection-content-optimizer/index.js');
  assert.deepEqual(cmd.args, ['--handle', 'unscented-lotion', '--queue']);
});

test('buildTriggerCommand: collection push → collection-linker --url --keyword --apply', () => {
  const item = {
    recommended_action: 'rank_push',
    title: 'SEO opportunity: coconut oil body lotion',
    signal_source: { page: 'https://www.realskincare.com/collections/coconut-oil-lotion' },
  };
  const cmd = buildTriggerCommand(item);
  assert.equal(cmd.agent, 'collection-linker');
  assert.equal(cmd.script, 'agents/collection-linker/index.js');
  assert.deepEqual(cmd.args, [
    '--url', 'https://www.realskincare.com/collections/coconut-oil-lotion',
    '--keyword', 'coconut oil body lotion',
    '--apply',
  ]);
});

test('buildTriggerCommand: blog content → refresh-runner <slug>', () => {
  const item = {
    recommended_action: 'rank_push',
    title: 'SEO opportunity: best soap for tattoos',
    signal_source: { page: 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos' },
  };
  const cmd = buildTriggerCommand(item);
  assert.equal(cmd.agent, 'refresh-runner');
  assert.equal(cmd.script, 'agents/refresh-runner/index.js');
  assert.deepEqual(cmd.args, ['best-soap-for-tattoos']);
});

test('buildTriggerCommand throws when it cannot derive the target', () => {
  // collection push with no keyword anywhere
  assert.throws(() => buildTriggerCommand({
    recommended_action: 'rank_push',
    signal_source: { page: 'https://www.realskincare.com/collections/x' },
  }), /keyword/i);
  // no page at all → cannot derive a slug
  assert.throws(() => buildTriggerCommand({
    recommended_action: 'refresh',
    signal_source: {},
  }), /derive/i);
});
