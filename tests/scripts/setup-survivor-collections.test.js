import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLeadLink, SURVIVOR_LEAD } from '../../scripts/setup-survivor-collections.mjs';

test('empty body_html gets the full lead-link + description body', () => {
  const plan = planLeadLink('', SURVIVOR_LEAD['non-toxic-body-lotion']);
  assert.equal(plan.action, 'write-full');
  assert.ok(plan.body.includes('/products/coconut-lotion'));
});

test('whitespace-only body_html is treated as empty', () => {
  const plan = planLeadLink('   \n  ', SURVIVOR_LEAD['foaming-hand-soap']);
  assert.equal(plan.action, 'write-full');
});

test('existing copy without the PDP link gets the link prepended, copy preserved', () => {
  const existing = '<p>Some merchandiser copy about hand soap.</p>';
  const plan = planLeadLink(existing, SURVIVOR_LEAD['foaming-hand-soap']);
  assert.equal(plan.action, 'prepend');
  assert.ok(plan.body.startsWith('<p><a href="/products/organic-foaming-hand-soap"'));
  assert.ok(plan.body.includes(existing), 'existing copy must survive, not be destroyed');
});

test('idempotent: running the plan twice does not stack a duplicate lead link', () => {
  const original = '<p>Merchandiser copy that does not yet link to the PDP.</p>';
  const cfg = SURVIVOR_LEAD['non-toxic-body-lotion'];

  const first = planLeadLink(original, cfg);
  assert.equal(first.action, 'prepend');

  // Feed the result back through — simulates re-running the script after
  // the first prepend already landed.
  const second = planLeadLink(first.body, cfg);
  assert.equal(second.action, 'skip');
  assert.equal(second.body, first.body, 'a no-op pass must not alter the body');

  const occurrences = (second.body.match(/href="\/products\/coconut-lotion"/g) || []).length;
  assert.equal(occurrences, 1, 'the link must appear exactly once, not stacked');
});

test('a body_html that already links to the PDP is left alone on the first pass too', () => {
  const already = '<p>Copy.</p><p><a href="/products/coconut-lotion">Shop</a></p>';
  const plan = planLeadLink(already, SURVIVOR_LEAD['non-toxic-body-lotion']);
  assert.equal(plan.action, 'skip');
  assert.equal(plan.body, already);
});

test('all-products requires every surviving-collection link, not just one, before it counts as done', () => {
  const partial = '<p>Only <a href="/collections/non-toxic-body-lotion">lotion</a> linked so far.</p>';
  const plan = planLeadLink(partial, SURVIVOR_LEAD['all-products']);
  assert.equal(plan.action, 'prepend');
});

test('all-products is idempotent once every surviving-collection link is present', () => {
  const cfg = SURVIVOR_LEAD['all-products'];
  const first = planLeadLink('', cfg);
  assert.equal(first.action, 'write-full');
  const second = planLeadLink(first.body, cfg);
  assert.equal(second.action, 'skip');
});

test('sets-and-bundles: empty body_html gets the lead link plus the description sentence', () => {
  const plan = planLeadLink('', SURVIVOR_LEAD['sets-and-bundles']);
  assert.equal(plan.action, 'write-full');
  assert.ok(plan.body.includes('/products/90-day-clean-swap'));
  assert.ok(plan.body.includes('Multi-product sets and value packs'));
});
