import { strict as assert } from 'node:assert';
import { isRejected as schedulerIsRejected } from '../../agents/pipeline-scheduler/index.js';
import { isRejected, buildRejectionSection } from '../../agents/content-strategist/index.js';

// ── pipeline-scheduler isRejected ───────────────────────────────────────────

const exactR  = [{ keyword: 'sls', matchType: 'exact' }];
const phraseR = [{ keyword: 'sls', matchType: 'phrase' }];
const broadR  = [{ keyword: 'sls', matchType: 'broad' }];

// exact: matches slug of identical keyword
assert.equal(schedulerIsRejected('sls', exactR), true, 'exact: matches identical');
// exact: slug comparison makes it case-insensitive
assert.equal(schedulerIsRejected('SLS', exactR), true, 'exact: case-insensitive via slug');
// exact: does NOT match a longer keyword that contains the term
assert.equal(schedulerIsRejected('best sls free toothpaste', exactR), false, 'exact: no substring match');
// slug normalization: "sls free" and "sls-free" are treated as the same exact rejection
assert.equal(schedulerIsRejected('sls free', [{ keyword: 'sls-free', matchType: 'exact' }]), true, 'exact: slug normalizes hyphen vs space');
// but strategist does NOT slug-normalize (direct string comparison)
assert.equal(isRejected('sls free', [{ keyword: 'sls-free', matchType: 'exact' }]), false, 'strategist exact: no slug normalization');

// phrase: matches any keyword containing the term
assert.equal(schedulerIsRejected('best sls free toothpaste', phraseR), true, 'phrase: matches containing keyword');
assert.equal(schedulerIsRejected('toothpaste without sodium lauryl sulfate', phraseR), false, 'phrase: no false positive');

// broad: same hard filter as phrase
assert.equal(schedulerIsRejected('sls toothpaste', broadR), true, 'broad: substring match');

// empty list: never blocks
assert.equal(schedulerIsRejected('anything', []), false, 'empty list: never blocks');

// ── content-strategist isRejected ───────────────────────────────────────────

assert.equal(isRejected('sls', exactR), true, 'strategist exact: matches');
assert.equal(isRejected('SLS', exactR), true, 'strategist exact: case-insensitive');
assert.equal(isRejected('best sls toothpaste', exactR), false, 'strategist exact: no substring match');
assert.equal(isRejected('best sls toothpaste', phraseR), true, 'strategist phrase: matches substring');
assert.equal(isRejected('unrelated keyword', phraseR), false, 'strategist phrase: no false positive');

// ── buildRejectionSection ────────────────────────────────────────────────────

assert.equal(buildRejectionSection([]), '', 'empty list returns empty string');

const section = buildRejectionSection([
  { keyword: 'sls', matchType: 'broad', reason: 'too broad' },
  { keyword: 'itchy armpits', matchType: 'exact', reason: null },
  { keyword: 'sweating', matchType: 'phrase', reason: 'off-brand' },
]);
assert.ok(section.includes('## Rejected Keywords'), 'includes heading');
assert.ok(section.includes('"sls" (broad match)'), 'broad entry present');
assert.ok(section.includes('avoid this topic'), 'broad has avoidance language');
assert.ok(section.includes('too broad'), 'reason included when present');
assert.ok(section.includes('"itchy armpits" (exact match)'), 'exact entry present');
assert.ok(!section.includes('null'), 'null reason not rendered');
assert.ok(section.includes('"sweating" (phrase match)'), 'phrase entry present');
assert.ok(section.includes('off-brand'), 'phrase reason included');

console.log('All rejected-keywords tests passed.');
