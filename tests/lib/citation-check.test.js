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

// Bare trigger words inside ordinary prose are NOT citation-worthy claims — the
// old patterns flagged these and caused spurious YMYL gate blocks.
test('does NOT flag bare "research"/"clinical"/"%" used non-claim-ily', () => {
  assert.deepEqual(findUncitedClaims('<p>If you would rather skip the research, browse our picks.</p>'), []);
  assert.deepEqual(findUncitedClaims('<p>Eucerin focuses on clinical hydration but relies on mineral oil.</p>'), []);
  assert.deepEqual(findUncitedClaims('<p>Dermatologist picks often focus on clinical efficacy for conditions.</p>'), []);
  assert.deepEqual(findUncitedClaims('<p>Pat skin 80% dry, then apply lotion to damp skin.</p>'), []);
});
test('still flags real study/clinical claims', () => {
  assert.equal(findUncitedClaims('<p>Research suggests coconut oil reduces water loss.</p>').length, 1);
  assert.equal(findUncitedClaims('<p>According to a 2024 study, the effect lasts hours.</p>').length, 1);
  assert.equal(findUncitedClaims('<p>A clinical trial found measurable improvement.</p>').length, 1);
});
test('does NOT flag recipe/spec percentages or bare "proven"', () => {
  assert.deepEqual(findUncitedClaims('<p>Mix hydrogen peroxide (3% concentration), baking soda, and dish soap.</p>'), []);
  assert.deepEqual(findUncitedClaims('<p>At 3% concentration, this is safe for most cotton.</p>'), []);
  assert.deepEqual(findUncitedClaims('<p>Use a paste of hydrogen peroxide (3%) and baking soda.</p>'), []);
  assert.deepEqual(findUncitedClaims('<p>Here are the most effective strategies — practical and proven.</p>'), []);
});
