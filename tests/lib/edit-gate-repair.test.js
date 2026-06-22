import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairCommandsFor } from '../../lib/edit-gate-repair.js';

const labels = (slug, reason) => repairCommandsFor(slug, reason).map((r) => r.label);

test('routes a 404/broken-link CTA blocker to link-repair', () => {
  const reason = 'CTA Quality The primary CTA link (/products/x) is flagged as 404 broken in the link health pre-check.';
  assert.ok(labels('s', reason).includes('link-repair'));
});

test('routes an uncited-claims blocker to citation-finder', () => {
  const reason = 'Factual Concerns 2 statistical/health claims lack a credible outbound citation.';
  assert.ok(labels('s', reason).includes('citation-finder'));
});

test('a vague Overall-Quality summary falls back to content-remediator (the old dead-end)', () => {
  // This is exactly why attemptRepair must route on concrete sections, not this.
  const vague = 'The post contains two blockers that must be resolved before publication.';
  assert.deepEqual(labels('s', vague), ['content-remediator']);
});

test('routing is keyword-driven so combined section+note strings hit the right agents', () => {
  assert.ok(labels('s', 'CTA Quality ... 404 broken ...').includes('link-repair'));
  assert.ok(labels('s', 'Factual Concerns ... uncited ...').includes('citation-finder'));
  assert.ok(labels('s', 'Internal Links ... orphan ...').includes('internal-linker'));
});
