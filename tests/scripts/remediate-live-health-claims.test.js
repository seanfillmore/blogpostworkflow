// tests/scripts/remediate-live-health-claims.test.js
//
// The remediation plan is DATA, so the tests are assertions about the data — the
// only way to prove a rewrite is safe before it touches a live ranking page.
//
// Importing the script must not run it (see reference_agents_run_on_import): the
// module is guarded and these tests are the proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN,
  gateSlotFor,
  gatePlan,
  classify,
  replaceAll,
  occurrences,
} from '../../scripts/remediate-live-health-claims.js';
import { checkSeoCopy, findSeoCopyClaims } from '../../lib/seo-copy-health-gate.js';

const label = (e) => `${e.slug}/${e.field}`;

test('the plan is non-empty and every entry is uniquely addressed', () => {
  assert.ok(PLAN.length > 0, 'plan must contain at least one entry');
  const keys = PLAN.map(label);
  assert.equal(new Set(keys).size, keys.length, `duplicate plan keys: ${keys}`);
});

test('every entry names the live Shopify resource it will write', () => {
  for (const e of PLAN) {
    assert.equal(typeof e.blogId, 'number', `${label(e)}: blogId`);
    assert.equal(typeof e.articleId, 'number', `${label(e)}: articleId`);
    assert.ok(
      ['summary_html', 'body_html', 'description_tag', 'title'].includes(e.field),
      `${label(e)}: unexpected field ${e.field}`,
    );
  }
});

// --- the two halves of "necessary and sufficient" -----------------------------

test("every entry's BEFORE actually trips the blocking tier", () => {
  // Guards against toning down copy that never needed it. An entry whose BEFORE
  // is clean is an unnecessary edit to a ranking page, which the brief forbids.
  for (const e of PLAN) {
    const hits = findSeoCopyClaims(e.before);
    assert.ok(
      hits.blocking.length > 0,
      `${label(e)}: BEFORE has no blocking-tier claim — it should not be in the plan`,
    );
  }
});

test("every entry's AFTER passes checkSeoCopy", () => {
  for (const e of PLAN) {
    const res = checkSeoCopy({ [gateSlotFor(e.field)]: e.after });
    assert.equal(
      res.ok,
      true,
      `${label(e)}: AFTER still blocks — ${res.blocking.map((b) => b.match).join(', ')}`,
    );
  }
});

test('gatePlan() reports a clean plan and names any offender', () => {
  const clean = gatePlan(PLAN);
  assert.deepEqual(clean.failures, []);
  assert.equal(clean.ok, true);

  const dirty = gatePlan([{ ...PLAN[0], after: 'This lotion heals eczema' }]);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.failures.length, 1);
  assert.ok(dirty.failures[0].matches.join(' ').toLowerCase().includes('heals'));
});

test('AFTER differs from BEFORE', () => {
  for (const e of PLAN) assert.notEqual(e.after, e.before, `${label(e)}: no-op edit`);
});

// --- what the rewrite must preserve ------------------------------------------

test('every entry preserves its declared ranking tokens, in order', () => {
  for (const e of PLAN) {
    assert.ok(Array.isArray(e.mustContain) && e.mustContain.length, `${label(e)}: mustContain`);
    const hay = e.after.toLowerCase();
    let cursor = 0;
    for (const token of e.mustContain) {
      const at = hay.indexOf(token.toLowerCase(), cursor);
      assert.ok(at >= 0, `${label(e)}: AFTER dropped ranking token "${token}"`);
      cursor = at + token.length;
    }
  }
});

test('the leading ranking token keeps its position', () => {
  // A meta description that buries the keyword reads as a different snippet even
  // when it still technically contains it.
  for (const e of PLAN) {
    const lead = e.mustContain[0].toLowerCase();
    const beforeAt = e.before.toLowerCase().indexOf(lead);
    const afterAt = e.after.toLowerCase().indexOf(lead);
    assert.ok(beforeAt >= 0, `${label(e)}: BEFORE lacks its own lead token`);
    assert.ok(
      Math.abs(afterAt - beforeAt) <= 12,
      `${label(e)}: lead token moved ${beforeAt}→${afterAt}`,
    );
  }
});

test('length is preserved within ±40%', () => {
  for (const e of PLAN) {
    const ratio = e.after.length / e.before.length;
    assert.ok(
      ratio >= 0.6 && ratio <= 1.4,
      `${label(e)}: length ${e.before.length}→${e.after.length} (${ratio.toFixed(2)}×)`,
    );
  }
});

test('description_tag rewrites stay inside the SERP snippet budget', () => {
  for (const e of PLAN.filter((x) => x.field === 'description_tag')) {
    assert.ok(e.after.length <= 160, `${label(e)}: ${e.after.length} chars`);
  }
});

test('HTML-wrapped fields keep their wrapper', () => {
  // summary_html values carry theme-significant markup. Losing <p>/<span> silently
  // changes how the excerpt renders on the article and the blog listing.
  for (const e of PLAN) {
    const tags = (s) => (s.match(/<([a-z]+)[^>]*>/gi) || []).map((t) => t.match(/[a-z]+/i)[0].toLowerCase());
    assert.deepEqual(tags(e.after), tags(e.before), `${label(e)}: markup changed`);
  }
});

test('AFTER preserves every non-ASCII character BEFORE carries', () => {
  // The plan is exact-match, so an invisible character is a silent skip. Transcribing
  // the vanilla excerpt turned its trailing U+00A0 into a plain space and the drift
  // guard caught it — this pins the class: em dashes, curly quotes and NBSPs must
  // survive a rewrite, and any that must not be sourced with an explicit \u escape.
  const exotic = (s) =>
    [...s].filter((c) => c.codePointAt(0) > 127).map((c) => c.codePointAt(0)).sort((a, b) => a - b);
  for (const e of PLAN) {
    assert.deepEqual(
      exotic(e.after),
      exotic(e.before),
      `${label(e)}: non-ASCII characters changed — check for a normalized NBSP or dash`,
    );
  }
});

test('advisory-tier vocabulary is never the reason for an edit', () => {
  // Toxicity words are deliberately allowed. An entry that only exists to remove
  // one would be a regression against that decision.
  for (const e of PLAN) {
    const removed = findSeoCopyClaims(e.before).advisory
      .map((a) => a.match.toLowerCase())
      .filter((m) => !e.after.toLowerCase().includes(m));
    assert.deepEqual(removed, [], `${label(e)}: dropped advisory-tier word(s) ${removed}`);
  }
});

// --- drift / idempotence ------------------------------------------------------

test('classify() distinguishes apply, already-applied and drift', () => {
  const e = { before: 'old text', after: 'new text' };
  assert.equal(classify('old text', e).action, 'apply');
  assert.equal(classify('new text', e).action, 'already-applied');
  assert.equal(classify('something else entirely', e).action, 'drift');
});

test('classify() never proposes a write it cannot verify', () => {
  const e = { before: 'old text', after: 'new text' };
  for (const live of ['', null, undefined, 'old text ']) {
    const r = classify(live, e);
    assert.notEqual(r.action, 'apply', `live=${JSON.stringify(live)} must not apply`);
  }
});

test('body_html entries are matched as substrings, and replace every occurrence', () => {
  const html = '<h2>X</h2> ... "name": "X", ... <h2>X</h2>';
  assert.equal(occurrences(html, 'X'), 3);
  const out = replaceAll(html, 'X', 'Y');
  assert.equal(occurrences(out, 'X'), 0);
  assert.equal(occurrences(out, 'Y'), 3);
});

test('applying a body replacement twice is a no-op the second time', () => {
  const e = PLAN.find((x) => x.field === 'body_html');
  assert.ok(e, 'expected at least one body_html entry');
  const html = `<div>${e.before}</div><span>${e.before}</span>`;
  const once = replaceAll(html, e.before, e.after);
  const twice = replaceAll(once, e.before, e.after);
  assert.equal(twice, once);
  assert.equal(occurrences(once, e.before), 0);
});

test('replaceAll treats the needle literally, not as a regex', () => {
  assert.equal(replaceAll('a.c a.c', 'a.c', 'Z'), 'Z Z');
  assert.equal(replaceAll('abc', 'a.c', 'Z'), 'abc');
  assert.equal(replaceAll('x', 'x', '$&$&'), '$&$&');
});

test('body_html entries declare how many occurrences they expect', () => {
  for (const e of PLAN.filter((x) => x.field === 'body_html')) {
    assert.equal(typeof e.expectedOccurrences, 'number', `${label(e)}: expectedOccurrences`);
    assert.ok(e.expectedOccurrences >= 1, `${label(e)}: expectedOccurrences must be >= 1`);
  }
});

test('gateSlotFor maps every planned field onto a gate slot', () => {
  for (const e of PLAN) {
    assert.ok(['title', 'meta'].includes(gateSlotFor(e.field)), `${label(e)}: ${e.field}`);
  }
});

test('every entry carries a written reason', () => {
  for (const e of PLAN) {
    assert.equal(typeof e.why, 'string');
    assert.ok(e.why.length > 20, `${label(e)}: reason too thin`);
  }
});
