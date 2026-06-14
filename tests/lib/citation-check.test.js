import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findUncitedClaims } from '../../lib/citation-check.js';

test('flags a statistic with no nearby outbound citation', () => {
  const html = '<p>Studies show 80% of people sweat less with this method.</p>';
  const out = findUncitedClaims(html);
  assert.equal(out.length, 1);
  assert.match(out[0].text.toLowerCase(), /80%/);
});

test('does NOT flag a statistic that has an outbound citation in the same paragraph', () => {
  const html = '<p>Research shows 80% improvement (<a href="https://www.ncbi.nlm.nih.gov/x">source</a>).</p>';
  assert.deepEqual(findUncitedClaims(html), []);
});

test('an internal/self link does not count as a citation', () => {
  const html = '<p>Studies show 80% fewer odor issues. <a href="/products/deodorant">Shop now</a></p>';
  const out = findUncitedClaims(html, { siteHost: 'realskincare.com' });
  assert.equal(out.length, 1);
});

test('flags a strong health/efficacy claim with no citation', () => {
  const html = '<p>This ingredient is clinically proven to kill bacteria.</p>';
  assert.equal(findUncitedClaims(html).length, 1);
});

test('non-claim sentence is not flagged', () => {
  const html = '<p>Our deodorant smells like coconut and feels smooth.</p>';
  assert.deepEqual(findUncitedClaims(html), []);
});

test('returns at most maxFindings', () => {
  const p = Array.from({ length: 20 }, (_, i) => `<p>Studies show ${i+1}% effect.</p>`).join('');
  assert.ok(findUncitedClaims(p, { maxFindings: 5 }).length <= 5);
});

test('empty/no-claims html → []', () => {
  assert.deepEqual(findUncitedClaims('<p>Hello world.</p>'), []);
  assert.deepEqual(findUncitedClaims(''), []);
});
