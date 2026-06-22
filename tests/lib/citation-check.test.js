import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findUncitedClaims, softenClaimsInHtml, softenClaimText } from '../../lib/citation-check.js';

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

// ── Deterministic soften: guarantees the gate clears (no dead-end) ──

test('softens the exact reported claims so the gate clears', () => {
  const html = [
    '<p>Research also suggests it may have mild antimicrobial properties, making it a solid choice for sensitive or eczema-prone skin.</p>',
    '<p>The lauric acid in coconut oil (about 50% of its fatty acid content) is particularly effective at penetrating the skin barrier, which sets it apart from many other plant oils that only sit on the surface.</p>',
  ].join('\n');
  assert.equal(findUncitedClaims(html).length, 2); // flagged before
  const { html: out, changed } = softenClaimsInHtml(html);
  assert.equal(changed, true);
  assert.deepEqual(findUncitedClaims(out), []); // cleared after
  assert.ok(/Many people find that/.test(out));
  assert.ok(/about half of its fatty acid content/.test(out));
  assert.ok(!/50\s?%/.test(out));
});

test('softens every claim pattern category to clear the gate', () => {
  const cases = [
    '<p>Studies show 80% of users sweat less.</p>',
    '<p>According to recent research, it works better.</p>',
    '<p>It is clinically proven to reduce odor.</p>',
    '<p>Doctors recommend it for daily use.</p>',
    '<p>It kills odor-causing bacteria on contact.</p>',
    '<p>It is scientifically proven to hydrate.</p>',
  ];
  for (const html of cases) {
    assert.ok(findUncitedClaims(html).length >= 1, `should flag: ${html}`);
    const { html: out } = softenClaimsInHtml(html);
    assert.deepEqual(findUncitedClaims(out), [], `should clear: ${html} -> ${out}`);
  }
});

test('soften leaves cited blocks, non-claim blocks, and links untouched', () => {
  const cited = '<p>Studies show 80% sweat less (<a href="https://pubmed.ncbi.nlm.nih.gov/123">source</a>).</p>';
  assert.equal(softenClaimsInHtml(cited).changed, false); // already cited → not flagged → untouched

  const plain = '<p>Our deodorant smells like fresh coconut and goes on smooth.</p>';
  assert.equal(softenClaimsInHtml(plain).changed, false);

  const withLink = '<p>Research shows it helps, per our <a href="https://www.realskincare.com/x">guide</a>.</p>';
  const out = softenClaimsInHtml(withLink).html;
  assert.ok(out.includes('href="https://www.realskincare.com/x"')); // link preserved
  assert.deepEqual(findUncitedClaims(out), []);
});

test('softenClaimText preserves percentages in non-claim contexts', () => {
  // "3% concentration" is excluded by the detector and must stay numeric.
  assert.equal(softenClaimText('a 3% concentration'), 'a 3% concentration');
});
