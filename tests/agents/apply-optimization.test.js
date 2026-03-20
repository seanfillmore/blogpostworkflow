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
