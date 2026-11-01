import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCopyLength, shortenToRenderedLimit, renderTitle, LENGTH_LIMITS } from '../../lib/seo-copy-length.js';
import { checkSeoCopy } from '../../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'remediate-long-titles.mjs'), 'utf8');

// The script is guarded by isDirectRun, but collectCandidates() still hits live
// Shopify on import of anything that calls it, so the structural rules below are
// asserted against the SOURCE — the same approach tests/agents/*-gated.test.js
// takes for agents that cannot be imported.

test('an UNREADABLE title_tag is distinct from an absent one', () => {
  // The bug this pins: `catch { return null }` made a transient metafield read
  // failure indistinguishable from "this surface has no title_tag". null sends
  // the surface down the MINT path, and mint calls upsertMetafield, which
  // OVERWRITES — so one flaky read replaced a good live SERP title with a
  // mechanical trim of the resource's own title.
  //
  // Observed 2026-09-20: two dry runs four minutes apart disagreed about
  // `best-soap-for-new-tattoo`, which carries the title_tag "Best Soap for New
  // Tattoo" on every read.
  assert.ok(
    /export const UNREADABLE = Symbol\(/.test(SRC),
    'seoTitleTag must have a distinct UNREADABLE sentinel, not null',
  );
  assert.ok(
    !/catch \{ return null; \}/.test(SRC),
    'seoTitleTag must not swallow a read failure into null',
  );
  assert.ok(
    /catch \{ return UNREADABLE; \}/.test(SRC),
    'a failed metafield read must yield UNREADABLE',
  );
});

test('an unreadable surface is excluded BEFORE the over-limit filter', () => {
  // Order matters for the same reason lib/cluster-hold.js applies the hold
  // before the per-run cap: an unreadable surface that reached the plan could
  // consume a slot and, worse, be written to.
  const excludeIdx = SRC.indexOf('const unreadable = all.filter');
  const overIdx = SRC.indexOf('const over = readable.filter');
  assert.ok(excludeIdx > -1, 'unreadable surfaces must be partitioned out');
  assert.ok(overIdx > -1, 'the over-limit filter must run over the READABLE set');
  assert.ok(excludeIdx < overIdx, 'exclusion must happen before measurement');
  assert.ok(
    /excluded_unreadable:/.test(SRC),
    'the run record must name what the run could not see',
  );
});

test('the hand-authored overrides fit, are compliant, and are stable', async () => {
  // Same contract as the three earlier overrides (pinned in
  // tests/lib/seo-copy-length.test.js): a hand-authored value still clears
  // every gate a generated one does, and a later sweep must not re-trim it.
  const added = {
    'coconut-oil-fatty-acids-what-they-are-why-they-matter': 'Coconut Oil Fatty Acids Explained',
    'cheap-lip-balms-best-natural-affordable-picks-for-soft-lips': 'Best Cheap Natural Lip Balms',
  };
  for (const [handle, title] of Object.entries(added)) {
    assert.ok(SRC.includes(`'${handle}'`), `${handle} must be in OVERRIDES`);
    assert.ok(SRC.includes(title), `${handle} must map to ${JSON.stringify(title)}`);
    assert.equal(checkCopyLength({ title }, { title: 'title' }).ok, true, `${title} renders too long`);
    assert.equal(checkSeoCopy({ title }).ok, true, `${title} trips the health gate`);
    assert.equal(shortenToRenderedLimit(title), title, `${title} is not stable under the shortener`);
    assert.ok(
      [...renderTitle(title)].length <= LENGTH_LIMITS.title.max,
      `${title} exceeds the rendered limit`,
    );
  }
});

test('each override replaces a trim that lands on a dangling fragment', () => {
  // These are the mechanical outputs the overrides exist to replace. If the
  // shortener ever learns to handle them, the overrides become redundant and
  // this test is the thing that says so.
  assert.equal(
    shortenToRenderedLimit('Coconut Oil Fatty Acids: What They Are & Why They Matter – Real Skin Care'),
    'Coconut Oil Fatty Acids: What They',
  );
  assert.equal(
    shortenToRenderedLimit('Cheap Lip Balms: Best Natural, Affordable Picks for Soft Lips – Real Skin Care'),
    'Cheap Lip Balms: Best Natural, Affordable',
  );
});
