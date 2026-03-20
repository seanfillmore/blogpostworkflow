import { strict as assert } from 'node:assert';
import {
  filterApprovedSuggestions,
  resolveEditValue,
  buildMutateOperation,
  parseDoneLine,
} from '../../agents/apply-ads-changes/index.js';

// filterApprovedSuggestions
const data = {
  suggestions: [
    { id: 's-001', status: 'approved', type: 'keyword_pause', proposedChange: { criterionResourceName: 'c/1' } },
    { id: 's-002', status: 'pending', type: 'keyword_add', proposedChange: {} },
    { id: 's-003', status: 'rejected', type: 'negative_add', proposedChange: {} },
    { id: 's-004', status: 'approved', type: 'negative_add', proposedChange: { keyword: 'recipe', matchType: 'BROAD', campaignResourceName: 'c/2' } },
  ],
};
const approved = filterApprovedSuggestions(data);
assert.equal(approved.length, 2);
assert.equal(approved[0].id, 's-001');

// filterApprovedSuggestions — handles missing suggestions array
assert.deepEqual(filterApprovedSuggestions({}), []);

// resolveEditValue — returns editedValue if non-empty string
assert.equal(resolveEditValue({ editedValue: 'My Edit', proposedChange: { suggested: 'Original' } }), 'My Edit');
// returns suggested if editedValue is null
assert.equal(resolveEditValue({ editedValue: null, proposedChange: { suggested: 'Original' } }), 'Original');
// returns suggested if editedValue is empty string
assert.equal(resolveEditValue({ editedValue: '', proposedChange: { suggested: 'Original' } }), 'Original');

// buildMutateOperation — keyword_pause
const pauseOp = buildMutateOperation({
  type: 'keyword_pause',
  proposedChange: { criterionResourceName: 'customers/123/adGroupCriteria/1~2' },
});
assert.deepEqual(pauseOp, {
  adGroupCriterionOperation: {
    update: { resourceName: 'customers/123/adGroupCriteria/1~2', status: 'PAUSED' },
    updateMask: 'status',
  },
});

// buildMutateOperation — keyword_add
const addOp = buildMutateOperation({
  type: 'keyword_add',
  proposedChange: {
    keyword: 'natural lotion',
    matchType: 'EXACT',
    adGroupResourceName: 'customers/123/adGroups/456',
  },
});
assert.deepEqual(addOp, {
  adGroupCriterionOperation: {
    create: {
      adGroup: 'customers/123/adGroups/456',
      keyword: { text: 'natural lotion', matchType: 'EXACT' },
      status: 'ENABLED',
    },
  },
});

// buildMutateOperation — negative_add
const negOp = buildMutateOperation({
  type: 'negative_add',
  proposedChange: {
    keyword: 'recipe',
    matchType: 'BROAD',
    campaignResourceName: 'customers/123/campaigns/789',
  },
});
assert.deepEqual(negOp, {
  campaignCriterionOperation: {
    create: {
      campaign: 'customers/123/campaigns/789',
      keyword: { text: 'recipe', matchType: 'BROAD' },
      negative: true,
    },
  },
});

// buildMutateOperation — unknown type throws
assert.throws(() => buildMutateOperation({ type: 'unknown', proposedChange: {} }), /Unknown/);

// parseDoneLine
assert.deepEqual(parseDoneLine('DONE {"applied":3,"failed":1}'), { applied: 3, failed: 1 });
assert.equal(parseDoneLine('Some other line'), null);
assert.equal(parseDoneLine('DONE invalid-json'), null);

console.log('✓ apply-ads-changes pure function tests pass');
