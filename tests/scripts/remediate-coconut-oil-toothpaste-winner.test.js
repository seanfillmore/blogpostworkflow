import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PLAN, applyPlan, occurrences } from '../../scripts/remediate-coconut-oil-toothpaste-winner.mjs';
import { findUncitedClaims } from '../../lib/citation-check.js';

test('plan ids are unique and every entry states why', () => {
  assert.equal(new Set(PLAN.map((e) => e.id)).size, PLAN.length);
  for (const e of PLAN) assert.ok(e.why && e.before && e.after && e.before !== e.after, e.id);
});

test('no AFTER uses the remineralize verb/adjective or "fights cavities"', () => {
  for (const e of PLAN) {
    assert.doesNotMatch(e.after, /\bremineraliz(?:e|es|ed|ing)\b/i, e.id);
    assert.doesNotMatch(e.after, /\bfights? cavit/i, e.id);
  }
});

test('the brain-imaging link is gone and every new external citation points at NCBI', () => {
  for (const e of PLAN) {
    assert.doesNotMatch(e.after, /PMC5024049/, e.id);
    for (const [, href] of e.after.matchAll(/href="([^"]+)"/g)) {
      if (href.startsWith('https://www.realskincare.com/')) continue; // internal link, not a citation
      assert.match(href, /^https:\/\/(pmc|pubmed)\.ncbi\.nlm\.nih\.gov\//, `${e.id}: ${href}`);
    }
  }
});

test('the trial is no longer credited with S. mutans or parity with chlorhexidine', () => {
  const t = PLAN.find((e) => e.id === 'trial-accuracy').after;
  assert.doesNotMatch(t, /mutans|comparable/i);
});

test('each AFTER block that makes a claim carries its own citation', () => {
  for (const e of PLAN) assert.equal(findUncitedClaims(`<p>${e.after}</p>`).length, 0, e.id);
});

test('applyPlan is re-run safe and refuses a body that moved', () => {
  const body = PLAN.map((e) => `<div>${e.before}</div>`).join('\n');
  const once = applyPlan(body).html;
  for (const e of PLAN) assert.equal(occurrences(once, e.after) >= 1, true, e.id);
  assert.ok(applyPlan(once).rows.every((r) => r.action === 'already-applied'));
  assert.throws(() => applyPlan('<p>unrelated</p>'), /BEFORE found 0x/);
});

test('an entry that deletes into its own AFTER, and one that inserts after its BEFORE, each apply once', () => {
  const lead = PLAN.find((e) => e.id === 'date-stamp-lead');
  const tail = PLAN.find((e) => e.id === 'date-stamp-after-intro');
  const body = `<article>\n\n${lead.before} x. ${tail.before}`;
  const once = applyPlan(body, [lead, tail]);
  assert.deepEqual(once.rows.map((r) => r.action), ['applied', 'applied']);
  assert.equal(occurrences(once.html, 'Last Updated: February 2026'), 0);
  assert.equal(occurrences(once.html, 'Last updated: October 2026'), 1);
  const twice = applyPlan(once.html, [lead, tail]);
  assert.equal(twice.html, once.html);
});
