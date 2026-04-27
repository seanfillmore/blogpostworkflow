import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRelatedKeywords, buildResearchIndexContext } from '../../agents/content-researcher/lib/index-context.js';

test('mergeRelatedKeywords dedupes case-insensitively, preserves order, respects max', () => {
  const live = [{ keyword: 'natural deodorant' }, { keyword: 'aluminum free' }];
  const mates = [{ keyword: 'Natural Deodorant' }, { keyword: 'roll on' }];
  const out = mergeRelatedKeywords(live, mates, 10);
  assert.deepEqual(out, ['natural deodorant', 'aluminum free', 'roll on']);
});

test('mergeRelatedKeywords accepts plain strings as live entries', () => {
  const live = ['a', 'b'];
  const mates = [{ keyword: 'B' }, { keyword: 'c' }];
  const out = mergeRelatedKeywords(live, mates, 10);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('mergeRelatedKeywords respects maxLen', () => {
  const out = mergeRelatedKeywords(['a', 'b', 'c', 'd'], [{ keyword: 'e' }], 3);
  assert.equal(out.length, 3);
});

test('buildResearchIndexContext returns null when idx missing', () => {
  assert.equal(buildResearchIndexContext(null, 'x', '/tmp'), null);
});

test('buildResearchIndexContext returns context bundle for entry match', () => {
  const idx = {
    keywords: {
      'natural-deodorant': {
        slug: 'natural-deodorant', keyword: 'natural deodorant', cluster: 'deodorant',
        validation_source: 'amazon', amazon: { purchases: 100, conversion_share: 0.12 },
      },
      'aluminum-free-deodorant': {
        slug: 'aluminum-free-deodorant', keyword: 'aluminum free deodorant', cluster: 'deodorant',
      },
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    const ctx = buildResearchIndexContext(idx, 'natural deodorant', dir);
    assert.equal(ctx.validation_source, 'amazon');
    assert.equal(ctx.cluster, 'deodorant');
    assert.equal(ctx.amazon_purchases, 100);
    assert.ok(ctx.cluster_mates.some((m) => m.slug === 'aluminum-free-deodorant'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
