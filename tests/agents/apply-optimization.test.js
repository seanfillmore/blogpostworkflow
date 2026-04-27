// tests/agents/apply-optimization.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterApprovedChanges, parseDoneLine } from '../../agents/apply-optimization/index.js';

test('filterApprovedChanges returns only approved changes', () => {
  const brief = {
    proposed_changes: [
      { id: 'change-001', type: 'meta_title', status: 'approved', proposed: 'New Title' },
      { id: 'change-002', type: 'body_html',  status: 'pending',  proposed: '<p>Body</p>' },
      { id: 'change-003', type: 'meta_description', status: 'rejected', proposed: 'Desc' },
    ],
  };
  const result = filterApprovedChanges(brief);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'change-001');
});

test('filterApprovedChanges returns empty array when none approved', () => {
  const brief = { proposed_changes: [{ id: 'c1', status: 'pending' }] };
  assert.deepEqual(filterApprovedChanges(brief), []);
});

test('parseDoneLine extracts counts from DONE JSON line', () => {
  const result = parseDoneLine('DONE {"applied":3,"failed":1}');
  assert.deepEqual(result, { applied: 3, failed: 1 });
});

test('parseDoneLine returns null for non-DONE lines', () => {
  assert.equal(parseDoneLine('Applying change-001...'), null);
});

import { resolveIndexEntry, applyValidationMetadata } from '../../agents/apply-optimization/index.js';

const idx = {
  keywords: {
    'natural-deodorant': {
      slug: 'natural-deodorant', keyword: 'natural deodorant', validation_source: 'amazon',
      gsc: { top_page: 'https://example.com/products/natural-deodorant' },
    },
  },
};

test('resolveIndexEntry matches by URL when handle + page_type + siteUrl present', () => {
  const brief = { handle: 'natural-deodorant', page_type: 'product', target_keyword: 'something else' };
  const e = resolveIndexEntry(brief, idx, 'https://example.com');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('resolveIndexEntry falls back to target_keyword when URL miss', () => {
  const brief = { handle: 'unknown', page_type: 'product', target_keyword: 'natural deodorant' };
  const e = resolveIndexEntry(brief, idx, 'https://example.com');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('resolveIndexEntry returns null when idx is null', () => {
  const brief = { handle: 'x', page_type: 'product', target_keyword: 'y' };
  assert.equal(resolveIndexEntry(brief, null, 'https://example.com'), null);
});

test('applyValidationMetadata stamps applied changes + brief root', () => {
  const brief = {
    proposed_changes: [
      { id: 'a', status: 'applied' },
      { id: 'b', status: 'pending' },
    ],
  };
  const entry = { keyword: 'natural deodorant', validation_source: 'amazon' };
  applyValidationMetadata(brief, entry, '2026-04-27T00:00:00Z');
  assert.equal(brief.proposed_changes[0].validation_source, 'amazon');
  assert.equal(brief.proposed_changes[0].index_keyword, 'natural deodorant');
  assert.equal(brief.proposed_changes[0].applied_at, '2026-04-27T00:00:00Z');
  assert.equal(brief.proposed_changes[1].validation_source, undefined);
  assert.equal(brief.validation_source, 'amazon');
  assert.equal(brief.applied_at, '2026-04-27T00:00:00Z');
});

test('applyValidationMetadata is a no-op for null entry', () => {
  const brief = { proposed_changes: [{ id: 'a', status: 'applied' }] };
  applyValidationMetadata(brief, null);
  assert.equal(brief.validation_source, undefined);
  assert.equal(brief.proposed_changes[0].validation_source, undefined);
});
