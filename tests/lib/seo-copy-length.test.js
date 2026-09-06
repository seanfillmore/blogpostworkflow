// lib/seo-copy-length.js — the SERP truncation check.
//
// The properties worth pinning are the ones a future edit would plausibly get
// wrong: that it never BLOCKS a write, that an undeclared field is never
// measured, and that the title limit stays absent (a flat 60 would certify
// titles this theme truncates — see the module header).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LENGTH_LIMITS, LENGTH_KINDS, checkCopyLength, lengthConstraint,
  renderLengthLines, SEO_COPY_LENGTH_RULE,
} from '../../lib/seo-copy-length.js';
import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';

const MAX = LENGTH_LIMITS.description.max;
const desc = (n) => 'a'.repeat(n);

test('the ceiling is 160 — Ahrefs Site Audit\'s own "meta description too long" boundary', () => {
  assert.equal(MAX, 160);
});

test('titles are NOT a declarable kind', () => {
  // The theme appends " – Real Skin Care" (17 chars) to every rendered <title>,
  // so a flat 60 would pass titles that truncate and a suffix-aware limit (~43)
  // would fight every prompt in the fleet, which all ask for 50–60. Adding
  // `title` here means changing those prompts in the same PR.
  assert.deepEqual(LENGTH_KINDS, ['description']);
  assert.equal(LENGTH_LIMITS.title, undefined);
  assert.ok(!/\btitle\b/.test(SEO_COPY_LENGTH_RULE),
    'the first-prompt rule must not state a title limit while none is enforced');
});

test('at the limit passes; one over fails', () => {
  assert.equal(checkCopyLength({ meta: desc(MAX) }, { meta: 'description' }).ok, true);

  const over = checkCopyLength({ meta: desc(MAX + 1) }, { meta: 'description' });
  assert.equal(over.ok, false);
  assert.deepEqual(over.overlong, [{ field: 'meta', kind: 'description', length: MAX + 1, max: MAX, over: 1 }]);
});

test('an UNDECLARED field is never measured, however long', () => {
  // The whitelist doctrine: these callers legitimately pass a 450-650 word
  // collection body and a product body_html through the same field map.
  const fields = { meta: desc(10), body: desc(5000), 'faq body': desc(9000) };
  assert.equal(checkCopyLength(fields, { meta: 'description' }).ok, true);
});

test('trims before measuring, and counts CODE POINTS not UTF-16 units', () => {
  assert.equal(checkCopyLength({ meta: `  ${desc(MAX)}\n ` }, { meta: 'description' }).ok, true,
    'trailing whitespace is not rendered in a snippet and must not fail a description');

  // An emoji is 2 UTF-16 units but one glyph. 80 emoji = 160 code points.
  const emoji = '🙂'.repeat(MAX);
  assert.equal(emoji.length, MAX * 2, 'precondition: .length over-counts');
  assert.equal(checkCopyLength({ meta: emoji }, { meta: 'description' }).ok, true);
  assert.equal(checkCopyLength({ meta: emoji + '🙂' }, { meta: 'description' }).ok, false);
});

test('null, undefined and empty are skipped rather than failed', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(checkCopyLength({ meta: v }, { meta: 'description' }).ok, true, `value ${JSON.stringify(v)}`);
  }
});

test('an unknown kind is a programming error, not a silent pass', () => {
  assert.throws(
    () => checkCopyLength({ meta: 'x' }, { meta: 'headline' }),
    /unknown kind "headline"/,
  );
});

test('the constraint names the field, the measured length and the overage', () => {
  const { overlong } = checkCopyLength({ meta: desc(MAX + 17) }, { meta: 'description' });
  const c = lengthConstraint(overlong);
  assert.match(c, new RegExp(String(MAX + 17)), 'states the measured length');
  assert.match(c, /17 over/, 'states the overage, so a model cannot trim four characters and call it done');
  assert.match(c, new RegExp(`${MAX}-character limit`));
  assert.match(c, /WITHOUT dropping the target keyword/i);

  assert.equal(lengthConstraint([]), '', 'empty is concatenable');
  assert.equal(lengthConstraint(undefined), '');
});

test('renderLengthLines says the copy SHIPPED, not that it was blocked', () => {
  const lines = renderLengthLines([{ page: '/a', field: 'meta', kind: 'description', length: 171, max: MAX }]);
  assert.ok(lines.length > 0);
  assert.match(lines.join('\n'), /171\/160/);
  assert.match(lines.join('\n'), /shipped/i);
  assert.deepEqual(renderLengthLines([]), []);
});

// ── the loop integration: length RETRIES but never BLOCKS ──────────────────────

test('an over-long first attempt is RETRIED with the overage named', async () => {
  const seen = [];
  const res = await gateGeneratedCopy(
    async (constraint) => {
      seen.push(constraint);
      return { title: 'T', meta_description: seen.length === 1 ? desc(MAX + 20) : desc(120) };
    },
    { extract: (r) => ({ title: r?.title, meta: r?.meta_description }), lengths: { meta: 'description' } },
  );

  assert.equal(res.attempts, 2, 'exactly one retry');
  assert.equal(seen[0], '', 'first attempt is unconstrained');
  assert.match(seen[1], /20 over/, 'the retry prompt names the overage');
  assert.equal(res.ok, true);
  assert.deepEqual(res.overlong, [], 'the second attempt was within the limit');
});

test('a STILL over-long second attempt SHIPS and is reported — length never blocks', async () => {
  const res = await gateGeneratedCopy(
    async () => ({ title: 'T', meta_description: desc(MAX + 40) }),
    { extract: (r) => ({ title: r?.title, meta: r?.meta_description }), lengths: { meta: 'description' } },
  );

  // This is the whole safety property. Refusing here leaves the OLDER, worse
  // description live on a page that was selected for a rewrite precisely
  // because its current copy underperforms.
  assert.equal(res.ok, true, 'length must never fail the gate');
  assert.ok(res.proposed, 'the copy is handed back to be written');
  assert.equal(res.proposed.meta_description.length, MAX + 40);
  assert.equal(res.overlong.length, 1, 'and the overage is reported so it can be recorded');
  assert.equal(res.attempts, 2);
});

test('omitting `lengths` disables the check entirely (back-compat)', async () => {
  const res = await gateGeneratedCopy(
    async () => ({ title: 'T', meta_description: desc(500) }),
    { extract: (r) => ({ title: r?.title, meta: r?.meta_description }) },
  );
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1, 'no retry is spent when no length is declared');
  assert.deepEqual(res.overlong, []);
});

test('a clean first attempt still costs exactly ONE call', async () => {
  let calls = 0;
  const res = await gateGeneratedCopy(
    async () => { calls++; return { title: 'T', meta_description: desc(150) }; },
    { extract: (r) => ({ title: r?.title, meta: r?.meta_description }), lengths: { meta: 'description' } },
  );
  assert.equal(calls, 1);
  assert.equal(res.ok, true);
});

test('a health-claim hit and a length hit share ONE retry, not two', async () => {
  const seen = [];
  const res = await gateGeneratedCopy(
    async (constraint) => {
      seen.push(constraint);
      return seen.length === 1
        // "heals" is blocking-tier; the description is also over the limit.
        ? { title: 'Soap That Heals', meta_description: `${desc(MAX + 5)} heals` }
        : { title: 'Clean Soap', meta_description: desc(140) };
    },
    { extract: (r) => ({ title: r?.title, meta: r?.meta_description }), lengths: { meta: 'description' } },
  );

  assert.equal(res.attempts, 2, 'both defects are argued in the SAME retry');
  assert.match(seen[1], /heals/i, 'the health constraint is present');
  assert.match(seen[1], /over the 160-character limit/, 'and so is the length constraint');
  assert.equal(res.ok, true);
});

test('a blocking health claim still FAILS the gate even when length is clean', async () => {
  const res = await gateGeneratedCopy(
    async () => ({ title: 'Soap That Heals Eczema', meta_description: desc(140) }),
    { extract: (r) => ({ title: r?.title, meta: r?.meta_description }), lengths: { meta: 'description' } },
  );
  assert.equal(res.ok, false, 'adding the length check must not weaken the health gate');
  assert.ok(res.violations.length > 0);
});
