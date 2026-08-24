// tests/scripts/remediate-ingredient-benefit-headings.test.js
//
// Same posture as tests/scripts/remediate-live-health-claims.test.js: the plan is
// DATA, so the tests are assertions about the data — the only way to prove a
// rewrite is safe before it touches a live ranking page.
//
// Two things this suite can check that the older one could not:
//
//  1. Every FILE-target BEFORE is verified against the real file in this repo.
//     `data/posts/*/content.html` is committed, so "this literal occurs exactly
//     N times" is a fact a test can prove rather than a promise the runner
//     checks later. Article-target BEFOREs are still runtime-verified only —
//     they live in Shopify — which is what the drift guard is for.
//  2. A rewritten heading must not collide with another heading in the same
//     file, because two identical headings mean two identical anchors.
//
// Importing the script must not run it (see reference_agents_run_on_import): the
// module is guarded and these tests are the proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLAN,
  gatePlan,
  targetLabel,
  backupName,
} from '../../scripts/remediate-ingredient-benefit-headings.js';
import { occurrences, replaceAll } from '../../scripts/remediate-live-health-claims.js';
import { checkSeoCopy, findSeoCopyClaims, plainText } from '../../lib/seo-copy-health-gate.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const fileEntries = () => PLAN.filter((e) => e.target.kind === 'file');
const articleEntries = () => PLAN.filter((e) => e.target.kind === 'article');

// --- shape --------------------------------------------------------------------

test('the plan is non-empty and every entry has a unique id', () => {
  assert.ok(PLAN.length > 0, 'plan must contain at least one entry');
  const ids = PLAN.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate plan ids: ${ids}`);
});

test('every entry names a target the runner knows how to write', () => {
  for (const e of PLAN) {
    assert.ok(['article', 'file'].includes(e.target.kind), `${e.id}: kind ${e.target.kind}`);
    if (e.target.kind === 'article') {
      assert.equal(typeof e.target.blogId, 'number', `${e.id}: blogId`);
      assert.equal(typeof e.target.articleId, 'number', `${e.id}: articleId`);
      assert.equal(e.target.field, 'body_html', `${e.id}: field`);
      assert.equal(typeof e.target.slug, 'string', `${e.id}: slug`);
    } else {
      assert.ok(
        e.target.path.startsWith('data/posts/') && e.target.path.endsWith('/content.html'),
        `${e.id}: unexpected mirror path ${e.target.path}`,
      );
    }
    assert.ok(['title', 'meta'].includes(e.gateSlot), `${e.id}: gateSlot ${e.gateSlot}`);
    assert.equal(typeof e.expectedOccurrences, 'number', `${e.id}: expectedOccurrences`);
    assert.ok(e.expectedOccurrences >= 1, `${e.id}: expectedOccurrences must be >= 1`);
  }
});

test('this plan and the PR #634 plan never write the same field twice', () => {
  // Both scripts can be run in either order. An overlap would mean one of them
  // silently drifting the other, so they must address disjoint resources.
  //   (The #634 plan touches summary_html / description_tag on four of these
  //   articles and body_html on two others; only body_html is ours.)
  const mine = new Set(
    articleEntries().map((e) => `${e.target.articleId}/${e.target.field}`),
  );
  // Imported lazily so a failure here names this test, not a module-load error.
  return import('../../scripts/remediate-live-health-claims.js').then(({ PLAN: OTHER }) => {
    for (const o of OTHER) {
      const key = `${o.articleId}/${o.field}`;
      if (!mine.has(key)) continue;
      // Same field on the same article — allowed only if the literals cannot
      // overlap, which for body_html substrings we assert explicitly.
      for (const e of articleEntries().filter((x) => `${x.target.articleId}/${x.target.field}` === key)) {
        assert.ok(
          !o.before.includes(e.before) && !e.before.includes(o.before),
          `${e.id} overlaps PR #634 entry ${o.slug}/${o.field}`,
        );
      }
    }
  });
});

// --- the two halves of "necessary and sufficient" -----------------------------

test("every entry's BEFORE actually trips the blocking tier", () => {
  // Guards against toning down copy that never needed it. An entry whose BEFORE
  // is clean is an unnecessary edit to a ranking page, which the brief forbids.
  for (const e of PLAN) {
    const hits = findSeoCopyClaims(plainText(e.before));
    assert.ok(
      hits.blocking.length > 0,
      `${e.id}: BEFORE has no blocking-tier claim — it should not be in the plan`,
    );
  }
});

test("every entry's AFTER passes checkSeoCopy in its declared slot", () => {
  for (const e of PLAN) {
    const res = checkSeoCopy({ [e.gateSlot]: e.after });
    assert.equal(
      res.ok,
      true,
      `${e.id}: AFTER still blocks — ${res.blocking.map((b) => b.match).join(', ')}`,
    );
  }
});

test('checkSeoCopy is called with an object, never a bare string', () => {
  // The documented trap: a bare string has no .title/.meta, so the gate returns
  // ok:true and every entry gets a silent free pass. Pinned here so a future
  // simplification of gatePlan cannot reintroduce it unnoticed.
  const bare = checkSeoCopy('this lotion heals eczema');
  assert.equal(bare.ok, true, 'precondition: a bare string is the silent free pass');
  const shaped = checkSeoCopy({ title: 'this lotion heals eczema' });
  assert.equal(shaped.ok, false);
  assert.equal(gatePlan([{ ...PLAN[0], after: 'this lotion heals eczema' }]).ok, false);
});

test('gatePlan() reports a clean plan and names any offender', () => {
  const clean = gatePlan(PLAN);
  assert.deepEqual(clean.failures, []);
  assert.equal(clean.ok, true);

  const dirty = gatePlan([{ ...PLAN[0], after: '<h3>Treats Fungal Infections</h3>' }]);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.failures.length, 1);
  assert.equal(dirty.failures[0].id, PLAN[0].id);
  assert.ok(dirty.failures[0].matches.join(' ').toLowerCase().includes('fungal'));
});

test('AFTER differs from BEFORE', () => {
  for (const e of PLAN) assert.notEqual(e.after, e.before, `${e.id}: no-op edit`);
});

// --- what the rewrite must preserve ------------------------------------------

test('mustContain tokens survive BEFORE → AFTER, in order, in both', () => {
  // A token only counts as "preserved" if it was there to begin with, so it is
  // asserted against BEFORE as well. An empty list is allowed — see the tea-tree
  // soap heading, where nothing in "Antifungal Support" is a claim a cosmetic may
  // keep — but the next test makes sure that is a decision, not an omission.
  for (const e of PLAN) {
    assert.ok(Array.isArray(e.mustContain), `${e.id}: mustContain must be an array`);
    for (const hay of [e.before, e.after]) {
      let cursor = 0;
      for (const token of e.mustContain) {
        const at = hay.toLowerCase().indexOf(token.toLowerCase(), cursor);
        assert.ok(at >= 0, `${e.id}: "${token}" missing (or out of order) in ${JSON.stringify(hay.slice(0, 80))}`);
        cursor = at + token.length;
      }
    }
  }
});

test('an empty mustContain is justified in the entry itself', () => {
  for (const e of PLAN.filter((x) => x.mustContain.length === 0)) {
    assert.ok(
      /mustContain is deliberately empty/i.test(e.why),
      `${e.id}: empty mustContain must say why in \`why\``,
    );
  }
});

test('a numbered heading keeps its number', () => {
  // These are ordered benefit lists. Changing "3." to "4." silently renumbers the
  // article and breaks any deep link or in-page reference to it.
  const ordinal = (s) => (s.match(/<h[1-6][^>]*>\s*(\d+)\./) || [])[1];
  for (const e of PLAN) {
    const b = ordinal(e.before);
    if (!b) continue;
    assert.equal(ordinal(e.after), b, `${e.id}: heading renumbered ${b} → ${ordinal(e.after)}`);
  }
});

test('markup is preserved exactly — same tags, same order', () => {
  const tags = (s) =>
    (s.match(/<\/?([a-z0-9]+)[^>]*>/gi) || []).map((t) => t.replace(/[^a-z0-9/]/gi, '').toLowerCase());
  for (const e of PLAN) {
    assert.deepEqual(tags(e.after), tags(e.before), `${e.id}: markup changed`);
  }
});

test('no entry carries an invisible character on either side', () => {
  // PR #634's drift guard earned itself on a transcribed U+00A0. These BEFOREs
  // were machine-extracted rather than typed, and this keeps it that way.
  const INVISIBLE = /[ ​‌‍⁠﻿]/;
  for (const e of PLAN) {
    assert.ok(!INVISIBLE.test(e.before), `${e.id}: BEFORE carries an invisible character`);
    assert.ok(!INVISIBLE.test(e.after), `${e.id}: AFTER carries an invisible character`);
  }
});

test('AFTER never silently normalises a non-ASCII character out of BEFORE', () => {
  // Deliberately weaker than #634's exact-multiset rule: these BEFOREs are
  // substrings, not whole fields, so an AFTER may legitimately introduce a dash
  // the original lacked. What it may NOT do is de-curl an apostrophe or drop an
  // em dash, which is how a literal replacement silently stops matching.
  const exotic = (s) => new Set([...s].filter((c) => c.codePointAt(0) > 127));
  for (const e of PLAN) {
    const after = exotic(e.after);
    for (const c of exotic(e.before)) {
      assert.ok(
        after.has(c),
        `${e.id}: AFTER dropped U+${c.codePointAt(0).toString(16).toUpperCase()} — check for a normalised quote or dash`,
      );
    }
  }
});

test('length stays within 0.5×–2.0× and headings stay short', () => {
  // A wider band than the #634 meta-description rule on purpose: a 25-character
  // heading cannot be rewritten inside ±40%. The absolute cap is what keeps that
  // from becoming a licence to write a sentence where a heading belongs.
  for (const e of PLAN) {
    const ratio = e.after.length / e.before.length;
    assert.ok(ratio >= 0.5 && ratio <= 2.0, `${e.id}: length ${e.before.length}→${e.after.length} (${ratio.toFixed(2)}×)`);
    const heading = (e.after.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/) || [])[1];
    if (heading) assert.ok(heading.trim().length <= 70, `${e.id}: heading is ${heading.trim().length} chars`);
  }
});

test('advisory-tier vocabulary is never the reason for an edit', () => {
  // Toxicity words are deliberately allowed. An entry that only exists to remove
  // one would be a regression against that decision.
  for (const e of PLAN) {
    const removed = findSeoCopyClaims(plainText(e.before)).advisory
      .map((a) => a.match.toLowerCase())
      .filter((m) => !plainText(e.after).toLowerCase().includes(m));
    assert.deepEqual(removed, [], `${e.id}: dropped advisory-tier word(s) ${removed}`);
  }
});

// --- verified against the real files in this repo -----------------------------

test('every mirror target exists and is committed', () => {
  for (const e of fileEntries()) {
    assert.ok(existsSync(join(ROOT, e.target.path)), `${e.id}: ${e.target.path} missing`);
  }
});

test('every mirror BEFORE occurs exactly expectedOccurrences times in the real file', () => {
  for (const e of fileEntries()) {
    const html = readFileSync(join(ROOT, e.target.path), 'utf8');
    assert.equal(
      occurrences(html, e.before),
      e.expectedOccurrences,
      `${e.id}: BEFORE not found as written in ${e.target.path}`,
    );
  }
});

test('applying a mirror produces a file with the claim gone and nothing else moved', () => {
  for (const e of fileEntries()) {
    const html = readFileSync(join(ROOT, e.target.path), 'utf8');
    const once = replaceAll(html, e.before, e.after);
    assert.equal(occurrences(once, e.before), 0, `${e.id}: BEFORE survived`);
    assert.equal(occurrences(once, e.after), e.expectedOccurrences, `${e.id}: AFTER not written`);
    assert.equal(
      html.length - e.before.length * e.expectedOccurrences,
      once.length - e.after.length * e.expectedOccurrences,
      `${e.id}: the replacement changed more than the planned span`,
    );
    assert.equal(replaceAll(once, e.before, e.after), once, `${e.id}: not idempotent`);
  }
});

test('a rewritten heading does not collide with another heading in the same file', () => {
  // Two identical headings are two identical anchors.
  for (const e of fileEntries()) {
    const newHeading = (e.after.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/) || [])[1];
    if (!newHeading) continue;
    const html = readFileSync(join(ROOT, e.target.path), 'utf8');
    const existing = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)].map((m) => m[1].trim());
    assert.ok(
      !existing.includes(newHeading.trim()),
      `${e.id}: "${newHeading.trim()}" already exists in ${e.target.path}`,
    );
  }
});

// --- runner helpers -----------------------------------------------------------

test('targetLabel names both kinds of target', () => {
  assert.match(targetLabel({ kind: 'file', path: 'data/posts/x/content.html' }), /data\/posts\/x/);
  assert.match(
    targetLabel({ kind: 'article', slug: 'x', field: 'body_html', articleId: 42 }),
    /x \[body_html #42\]/,
  );
});

test('backupName is filesystem-safe and unique per entry', () => {
  const names = PLAN.map((e) => backupName(e));
  assert.equal(new Set(names).size, names.length, 'backup filenames collide');
  for (const n of names) assert.match(n, /^[a-z0-9.@_-]+$/i, `unsafe backup filename ${n}`);
});

// --- documentation the plan must carry ---------------------------------------

test('every entry carries a written reason and a body verdict', () => {
  for (const e of PLAN) {
    assert.equal(typeof e.why, 'string');
    assert.ok(e.why.length > 40, `${e.id}: reason too thin`);
    assert.equal(typeof e.bodyVerdict, 'string');
    assert.ok(e.bodyVerdict.length > 40, `${e.id}: bodyVerdict too thin`);
    assert.ok(
      /HEADING ONLY|HEADING \+ BODY|HEADING \+ ONE SENTENCE|Mirror of|Paired with/i.test(e.bodyVerdict),
      `${e.id}: bodyVerdict must state whether the section body was changed`,
    );
  }
});

test('every mirror entry points at a live entry it mirrors', () => {
  const liveIds = new Set(articleEntries().map((e) => e.id));
  for (const e of fileEntries()) {
    const base = e.id.replace(/^mirror-/, '');
    assert.ok(
      e.id.startsWith('mirror-'),
      `${e.id}: file entries must be named mirror-*`,
    );
    if (!liveIds.has(base)) {
      // A mirror whose local text differs from live is allowed, but it has to say so.
      assert.match(e.why, /NOT a copy of the live string/i, `${e.id}: unexplained divergent mirror`);
    }
  }
});
