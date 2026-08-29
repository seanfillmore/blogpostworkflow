// tests/scripts/remediate-tea-tree-11-benefits-post.test.js
//
// Same posture as tests/scripts/remediate-ingredient-benefit-headings.test.js:
// the plan is DATA, so the tests are assertions about the data — the only way to
// prove a rewrite is safe before it touches a live page.
//
// Three things this suite checks that its sibling could not:
//
//  1. `nonClaimRationale` is REQUIRED exactly when an entry's BEFORE trips no
//     blocking-tier claim, and FORBIDDEN when it does. The mouth-rinse section is
//     the only such entry; the field is what stops an unflagged edit being
//     smuggled in beside eleven flagged ones, and stops the field becoming
//     decorative on entries that never needed it.
//  2. `KEPT` — the sections examined and deliberately left alone — is verified
//     against the real committed mirror, BEFORE and AFTER the whole plan is
//     applied. "We judged it and kept it" and "we never looked" are otherwise
//     indistinguishable, and a later pass could silently rewrite a considered keep.
//  3. The WHOLE plan is applied to the real file in one pass, not entry by entry,
//     because three entries deliberately replace two occurrences each (prose plus
//     the JSON-LD FAQPage block) and because eleven edits to one file is where a
//     literal replacement stops being obviously safe.
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
  KEPT,
  gatePlan,
  targetLabel,
  backupName,
} from '../../scripts/remediate-tea-tree-11-benefits-post.js';
import { occurrences, replaceAll } from '../../scripts/remediate-live-health-claims.js';
import { checkSeoCopy, findSeoCopyClaims, plainText } from '../../lib/seo-copy-health-gate.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SLUG = '11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life';
const MIRROR_PATH = `data/posts/${SLUG}/content.html`;
const ARTICLE_ID = 559520252074;

const fileEntries = () => PLAN.filter((e) => e.target.kind === 'file');
const articleEntries = () => PLAN.filter((e) => e.target.kind === 'article');
const mirrorHtml = () => readFileSync(join(ROOT, MIRROR_PATH), 'utf8');

/** The whole plan applied to one string, in plan order — what --apply does. */
function applyAll(html, entries) {
  let out = html;
  for (const e of entries) out = replaceAll(out, e.before, e.after);
  return out;
}

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
      assert.equal(e.target.articleId, ARTICLE_ID, `${e.id}: this pass is one post only`);
      assert.equal(e.target.blogId, 48998449187, `${e.id}: blogId`);
      assert.equal(e.target.field, 'body_html', `${e.id}: field`);
      assert.equal(e.target.slug, SLUG, `${e.id}: slug`);
    } else {
      assert.equal(e.target.path, MIRROR_PATH, `${e.id}: unexpected mirror path ${e.target.path}`);
    }
    assert.ok(['title', 'meta'].includes(e.gateSlot), `${e.id}: gateSlot ${e.gateSlot}`);
    assert.equal(typeof e.expectedOccurrences, 'number', `${e.id}: expectedOccurrences`);
    assert.ok(e.expectedOccurrences >= 1, `${e.id}: expectedOccurrences must be >= 1`);
  }
});

test('every live entry has exactly one mirror entry, and vice versa', () => {
  // A live fix with no mirror is a fix agents/publisher undoes on the next
  // republish — the trap PR #634 found with summary_html.
  const live = articleEntries().map((e) => e.id).sort();
  const mirrored = fileEntries().map((e) => e.id.replace(/^mirror-/, '')).sort();
  assert.deepEqual(mirrored, live, 'live and mirror entries are not one-to-one');
  for (const e of fileEntries()) {
    assert.ok(e.id.startsWith('mirror-'), `${e.id}: file entries must be named mirror-*`);
  }
});

test('a mirror entry replaces the same literal as the live entry it mirrors', () => {
  const byId = new Map(articleEntries().map((e) => [e.id, e]));
  for (const m of fileEntries()) {
    const live = byId.get(m.id.replace(/^mirror-/, ''));
    assert.equal(m.before, live.before, `${m.id}: BEFORE diverges from live`);
    assert.equal(m.after, live.after, `${m.id}: AFTER diverges from live`);
    assert.equal(m.expectedOccurrences, live.expectedOccurrences, `${m.id}: occurrence count diverges`);
  }
});

// --- the two halves of "necessary and sufficient" -----------------------------

test("an entry's BEFORE either trips the blocking tier or declares why not", () => {
  // Guards against toning down copy that never needed it. The exception is
  // deliberate and narrow: section 10 is an unsafe-USE-instruction problem, not a
  // claims problem, and the gate is not built to see it.
  for (const e of PLAN) {
    const blocking = findSeoCopyClaims(plainText(e.before)).blocking;
    if (blocking.length > 0) {
      assert.equal(
        e.nonClaimRationale,
        undefined,
        `${e.id}: BEFORE already trips the blocking tier — nonClaimRationale is decorative here`,
      );
      continue;
    }
    assert.equal(
      typeof e.nonClaimRationale,
      'string',
      `${e.id}: BEFORE has no blocking-tier claim and no nonClaimRationale — it should not be in the plan`,
    );
    assert.ok(e.nonClaimRationale.length > 200, `${e.id}: nonClaimRationale too thin to be a decision`);
  }
});

test('exactly one live section is rewritten without a blocking-tier claim', () => {
  // Not a style rule — a budget. Every additional unflagged edit is a rewrite of a
  // live ranking page that no measurement asked for, so growth here has to be a
  // visible, deliberate change to this number.
  const unflagged = articleEntries().filter(
    (e) => findSeoCopyClaims(plainText(e.before)).blocking.length === 0,
  );
  assert.deepEqual(unflagged.map((e) => e.id), ['s10-mouth-rinse']);
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
  // ok:true and every entry gets a silent free pass.
  const bare = checkSeoCopy('this soap heals wounds');
  assert.equal(bare.ok, true, 'precondition: a bare string is the silent free pass');
  const shaped = checkSeoCopy({ meta: 'this soap heals wounds' });
  assert.equal(shaped.ok, false);
  assert.equal(gatePlan([{ ...PLAN[0], after: 'this soap heals wounds' }]).ok, false);
});

test('gatePlan() reports a clean plan and names any offender', () => {
  const clean = gatePlan(PLAN);
  assert.deepEqual(clean.failures, []);
  assert.equal(clean.ok, true);

  const dirty = gatePlan([{ ...PLAN[0], after: '<p>Prevents infection in minor wounds.</p>' }]);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.failures.length, 1);
  assert.equal(dirty.failures[0].id, PLAN[0].id);
  assert.ok(dirty.failures[0].matches.join(' ').toLowerCase().includes('infection'));
});

test('AFTER differs from BEFORE', () => {
  for (const e of PLAN) assert.notEqual(e.after, e.before, `${e.id}: no-op edit`);
});

// --- what the rewrite must preserve ------------------------------------------

test('mustContain tokens survive BEFORE → AFTER, in order, in both', () => {
  for (const e of PLAN) {
    assert.ok(Array.isArray(e.mustContain), `${e.id}: mustContain must be an array`);
    assert.ok(e.mustContain.length > 0, `${e.id}: every rewrite here keeps at least one token`);
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

test('a numbered heading keeps its number', () => {
  // These are ordered benefit lists. Changing "7." to "8." silently renumbers the
  // article and breaks any deep link or in-page reference to it. This is also what
  // makes refilling slot 10 legitimate rather than a renumber in disguise.
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
  const INVISIBLE = /[ ​‌‍⁠﻿]/;
  for (const e of PLAN) {
    assert.ok(!INVISIBLE.test(e.before), `${e.id}: BEFORE carries an invisible character`);
    assert.ok(!INVISIBLE.test(e.after), `${e.id}: AFTER carries an invisible character`);
  }
});

test('AFTER never silently normalises a non-ASCII character out of BEFORE', () => {
  // How a literal replacement silently stops matching: a de-curled apostrophe or a
  // dropped em dash. AFTER may introduce new ones; it may not lose BEFORE's.
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
  for (const e of PLAN) {
    const ratio = e.after.length / e.before.length;
    assert.ok(ratio >= 0.5 && ratio <= 2.0, `${e.id}: length ${e.before.length}→${e.after.length} (${ratio.toFixed(2)}×)`);
    const heading = (e.after.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/) || [])[1];
    if (heading) assert.ok(heading.trim().length <= 70, `${e.id}: heading is ${heading.trim().length} chars`);
  }
});

test('advisory-tier vocabulary is never the reason for an edit', () => {
  // Toxicity words are deliberately allowed. An entry that only exists to remove
  // one would be a regression against that decision — which is exactly what
  // s10-mouth-rinse would look like if its AFTER dropped "toxic".
  for (const e of PLAN) {
    const removed = findSeoCopyClaims(plainText(e.before)).advisory
      .map((a) => a.match.toLowerCase())
      .filter((m) => !plainText(e.after).toLowerCase().includes(m));
    assert.deepEqual(removed, [], `${e.id}: dropped advisory-tier word(s) ${removed}`);
  }
});

// --- entries must not interfere with each other or with the earlier plans ------

test('no entry BEFORE contains another entry BEFORE', () => {
  // Overlapping literals make the result order-dependent, and the runner replaces
  // in plan order against a value it re-reads after every write.
  for (const a of PLAN) {
    for (const b of PLAN) {
      if (a === b || a.target.kind !== b.target.kind) continue;
      assert.ok(!a.before.includes(b.before), `${a.id}: BEFORE contains ${b.id}'s BEFORE`);
    }
  }
});

test('no entry AFTER reintroduces another entry BEFORE', () => {
  for (const a of PLAN) {
    for (const b of PLAN) {
      assert.ok(!a.after.includes(b.before), `${a.id}: AFTER contains ${b.id}'s BEFORE`);
    }
  }
});

test('this plan never writes the same span as the #634 or #645 plans', () => {
  // All three can be run in either order, and #645 addresses this same article
  // body_html and this same mirror file. An overlap would mean one silently
  // drifting another.
  return Promise.all([
    import('../../scripts/remediate-live-health-claims.js'),
    import('../../scripts/remediate-ingredient-benefit-headings.js'),
  ]).then(([older, sibling]) => {
    const others = [
      ...older.PLAN.filter((o) => o.articleId === ARTICLE_ID && o.field === 'body_html'),
      ...sibling.PLAN.filter(
        (o) =>
          (o.target.kind === 'article' && o.target.articleId === ARTICLE_ID)
          || (o.target.kind === 'file' && o.target.path === MIRROR_PATH),
      ),
    ];
    assert.ok(others.length > 0, 'precondition: the earlier plans do touch this post');
    for (const o of others) {
      for (const e of PLAN) {
        assert.ok(
          !o.before.includes(e.before) && !e.before.includes(o.before),
          `${e.id} overlaps an earlier plan entry`,
        );
      }
    }
  });
});

// --- verified against the real file in this repo ------------------------------

test('the mirror exists and is committed', () => {
  assert.ok(existsSync(join(ROOT, MIRROR_PATH)), `${MIRROR_PATH} missing`);
});

// EITHER the BEFORE or the AFTER, never a third value — the same invariant this
// file already applies to the sibling plan's entries further down. The strict
// "BEFORE is present" form pinned this mirror in a shape no reconciliation could
// survive: scripts/reconcile-content-mirrors.mjs pulls the LIVE body down, live
// already carries every AFTER, and the strict form then failed on a file that
// was MORE correct than before.
test('every mirror carries EITHER the BEFORE or the AFTER, never a third value', () => {
  const html = mirrorHtml();
  for (const e of fileEntries()) {
    assert.equal(
      occurrences(html, e.before) + occurrences(html, e.after),
      e.expectedOccurrences,
      `${e.id}: mirror drifted to a third value in ${MIRROR_PATH}`,
    );
  }
});

test('the three FAQ entries really do hit prose AND the JSON-LD block', () => {
  // The whole reason they declare expectedOccurrences: 2. If the schema block ever
  // stops mirroring the prose, this fails rather than silently half-fixing a rich
  // result that Google may render.
  const html = mirrorHtml();
  const schema = html.slice(html.indexOf('<script type="application/ld+json">'));
  assert.ok(schema.includes('"@type": "FAQPage"'), 'precondition: the FAQ schema block exists');
  const faq = fileEntries().filter((e) => e.expectedOccurrences === 2);
  assert.equal(faq.length, 3, 'expected exactly the three FAQ strings to be doubled');
  for (const e of faq) {
    assert.equal(occurrences(schema, e.before), 1, `${e.id}: not present in the JSON-LD block`);
    assert.equal(
      occurrences(html.slice(0, html.indexOf('<script type="application/ld+json">')), e.before),
      1,
      `${e.id}: not present in the visible prose`,
    );
  }
});

test('applying the WHOLE plan leaves no claim behind and moves nothing else', () => {
  const html = mirrorHtml();
  const once = applyAll(html, fileEntries());

  let expectedDelta = 0;
  for (const e of fileEntries()) {
    // Count what was actually PENDING before the apply. An already-applied entry
    // contributes no delta — there is nothing left in the file to replace.
    const pending = occurrences(html, e.before);
    assert.equal(occurrences(once, e.before), 0, `${e.id}: BEFORE survived`);
    assert.equal(occurrences(once, e.after), e.expectedOccurrences, `${e.id}: AFTER not written`);
    expectedDelta += (e.after.length - e.before.length) * pending;
  }
  assert.equal(
    once.length,
    html.length + expectedDelta,
    'the replacements changed more (or less) than the planned spans',
  );
  assert.equal(applyAll(once, fileEntries()), once, 'not idempotent');
});

test('the remediated mirror still parses as balanced HTML at block level', () => {
  // assertHtmlComplete's third check in miniature: a hand-written AFTER that drops
  // a </p> would otherwise ship a truncated-looking article.
  const once = applyAll(mirrorHtml(), fileEntries());
  for (const tag of ['p', 'h2', 'h3', 'li', 'ul', 'section']) {
    const open = (once.match(new RegExp(`<${tag}(?=[\\s>])`, 'gi')) || []).length;
    const close = (once.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
    assert.equal(open, close, `<${tag}> unbalanced after remediation: ${open} open, ${close} close`);
  }
});

test('the mirror is in a known state with respect to the #645 plan', async () => {
  // This file is NOT byte-identical to live: PR #645's `--apply` wrote its two
  // section fixes to Shopify but its two MIRROR entries were never committed, so
  // sections 3 and 4 here still carry "Supports Wound Healing" and "Fights Fungal
  // Infections". That is a real, recorded divergence — not something this plan
  // silently resyncs, and not something it may assume away.
  //
  // Asserted as "either BEFORE or AFTER, never neither", so this stays true both
  // now and after somebody re-runs that script. Drifting to a third value is what
  // would make the composition below unsafe.
  const sibling = await import('../../scripts/remediate-ingredient-benefit-headings.js');
  const html = mirrorHtml();
  const theirs = sibling.PLAN.filter(
    (o) => o.target.kind === 'file' && o.target.path === MIRROR_PATH,
  );
  assert.equal(theirs.length, 2, 'precondition: #645 carries two mirror entries for this file');
  for (const o of theirs) {
    const before = occurrences(html, o.before);
    const after = occurrences(html, o.after);
    assert.equal(before + after, o.expectedOccurrences, `${o.id}: mirror drifted to a third value`);
  }
});

test('the remediated mirror carries no blocking-tier claim outside the KEPT list', async () => {
  // The end-to-end assertion: this pass being COMPLETE, not merely correct.
  //
  // It composes with the #645 mirror entries deliberately. The claims left in
  // sections 3 and 4 of this file are that script's to remove — duplicating its
  // literals here would create two plans owning one string — but "the article is
  // clean" is a statement about the FILE, so the check has to cover both. The
  // documented remediation is both commands, and this is what proves the pair is
  // sufficient. If #645's mirror entries are ever dropped, this fails.
  const sibling = await import('../../scripts/remediate-ingredient-benefit-headings.js');
  const theirs = sibling.PLAN.filter(
    (o) => o.target.kind === 'file' && o.target.path === MIRROR_PATH,
  );
  const once = applyAll(applyAll(mirrorHtml(), theirs), fileEntries());
  const keptExcerpts = KEPT.map((k) => k.excerpt);
  const survivors = [];
  for (const block of once.split(/(?=<h[23])/)) {
    const hits = findSeoCopyClaims(plainText(block)).blocking;
    if (!hits.length) continue;
    if (keptExcerpts.some((x) => block.includes(x))) continue;
    survivors.push(`${plainText(block).slice(0, 60)} → ${hits.map((h) => h.match).join(',')}`);
  }
  assert.deepEqual(survivors, [], 'blocking-tier claims survive in a block no KEPT entry accounts for');
});

test('a rewritten heading does not collide with another heading in the file', () => {
  // Two identical headings are two identical anchors.
  const once = applyAll(mirrorHtml(), fileEntries());
  const headings = [...once.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)].map((m) => m[1].trim());
  const dupes = headings.filter((h, i) => headings.indexOf(h) !== i);
  assert.deepEqual(dupes, [], `duplicate headings after remediation: ${dupes}`);
});

// --- KEPT: the sections judged and deliberately left alone ---------------------

test('KEPT is non-empty, uniquely keyed and every verdict is argued', () => {
  assert.ok(KEPT.length > 0);
  const ids = KEPT.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate KEPT ids: ${ids}`);
  for (const k of KEPT) {
    assert.equal(typeof k.excerpt, 'string');
    assert.ok(k.excerpt.length > 20, `${k.id}: excerpt too short to identify a section`);
    assert.equal(typeof k.verdict, 'string');
    assert.ok(k.verdict.length > 60, `${k.id}: verdict too thin`);
    assert.match(k.verdict, /^KEEP/, `${k.id}: a KEPT verdict must say so first`);
  }
});

test('every KEPT excerpt is really in the article, before and after the plan runs', () => {
  const html = mirrorHtml();
  const once = applyAll(html, fileEntries());
  for (const k of KEPT) {
    assert.ok(occurrences(html, k.excerpt) >= 1, `${k.id}: excerpt not found in ${MIRROR_PATH}`);
    assert.equal(
      occurrences(once, k.excerpt),
      occurrences(html, k.excerpt),
      `${k.id}: a "considered keep" was changed by this plan`,
    );
  }
});

test('no KEPT excerpt overlaps anything the plan rewrites', () => {
  for (const k of KEPT) {
    for (const e of PLAN) {
      assert.ok(!e.before.includes(k.excerpt), `${e.id} rewrites KEPT ${k.id}`);
      assert.ok(!k.excerpt.includes(e.before), `KEPT ${k.id} contains ${e.id}'s BEFORE`);
    }
  }
});

test('the two KEPT safety warnings that make section 10 removable are both present', () => {
  // Load-bearing for s10-mouth-rinse: refilling slot 10 is only safe because the
  // "never ingest" warning survives elsewhere on the page. If either goes, the
  // mouth-rinse decision has to be revisited.
  const once = applyAll(mirrorHtml(), fileEntries());
  for (const id of ['safety-never-ingest', 'faq-q5-side-effects']) {
    const k = KEPT.find((x) => x.id === id);
    assert.ok(k, `${id} missing from KEPT`);
    assert.ok(occurrences(once, k.excerpt) >= 1, `${id}: warning no longer on the page`);
  }
  assert.match(once, /never ingest/i);
});

// --- runner helpers -----------------------------------------------------------

test('targetLabel names both kinds of target', () => {
  assert.match(targetLabel({ kind: 'file', path: MIRROR_PATH }), /data\/posts\//);
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
