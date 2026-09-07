// lib/seo-copy-length.js — the SERP truncation check.
//
// The properties worth pinning are the ones a future edit would plausibly get
// wrong: that it never BLOCKS a write, that an undeclared field is never
// measured, and that the title limit stays absent (a flat 60 would certify
// titles this theme truncates — see the module header).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LENGTH_LIMITS, LENGTH_KINDS, checkCopyLength, lengthConstraint,
  renderLengthLines, SEO_COPY_LENGTH_RULE, renderTitle, SHOP_NAME, TITLE_SUFFIX,
  shortenToRenderedLimit,
} from '../../lib/seo-copy-length.js';
import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';

const MAX = LENGTH_LIMITS.description.max;
const desc = (n) => 'a'.repeat(n);

test('the ceiling is 160 — Ahrefs Site Audit\'s own "meta description too long" boundary', () => {
  assert.equal(MAX, 160);
});

test('the shop name matches config/site.json — a rename must not drift silently', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const site = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
  assert.equal(SHOP_NAME, site.name,
    'SHOP_NAME is hardcoded to keep this module pure; it must equal config/site.json .name');
});

test('the suffix is 17 characters and uses an EN DASH, as the theme emits', () => {
  // layout/theme.liquid writes `&ndash;` — one code point, not a hyphen.
  assert.equal(TITLE_SUFFIX, ' \u2013 Real Skin Care');
  assert.equal([...TITLE_SUFFIX].length, 17);
});

test('renderTitle reproduces the theme: suffix UNLESS the title contains the shop name', () => {
  // The real live pair that motivated this whole change.
  assert.equal(
    renderTitle('SLS Free Toothpaste: Gentle Formulas That Actually Clean'),
    'SLS Free Toothpaste: Gentle Formulas That Actually Clean \u2013 Real Skin Care',
  );
  // A live page whose own title carries the brand gets NOTHING appended.
  assert.equal(
    renderTitle('FAQs \u2013 Real Skin Care Natural Products'),
    'FAQs \u2013 Real Skin Care Natural Products',
  );
  assert.equal(
    renderTitle('Coconut Oil Deodorant for Sensitive Skin | Real Skin Care'),
    'Coconut Oil Deodorant for Sensitive Skin | Real Skin Care',
  );
});

test('Liquid `contains` is CASE-SENSITIVE, so lower case still gets the suffix', () => {
  // Getting this wrong under-reports: the live page really does append here.
  assert.equal(renderTitle('the best real skin care lotion').endsWith(TITLE_SUFFIX), true);
  assert.equal(renderTitle('Shop Real Skin Care Lotion').endsWith(TITLE_SUFFIX), false);
});

test('a title is measured on its RENDERED form, not the authored string', () => {
  const authored = 'a'.repeat(50); // fits 60 on its own; 67 once the theme appends
  const { ok, overlong } = checkCopyLength({ title: authored }, { title: 'title' });
  assert.equal(ok, false, '50 authored + 17 suffix = 67, over 60');
  assert.equal(overlong[0].length, 67);
  assert.equal(overlong[0].authoredLength, 50);
  assert.match(overlong[0].rendered, /Real Skin Care$/);
});

test('the same length PASSES when the writer includes the brand itself', () => {
  // 60 characters total, brand inside => no suffix => exactly at the limit.
  const authored = `${'a'.repeat(60 - SHOP_NAME.length - 1)} ${SHOP_NAME}`;
  assert.equal([...authored].length, 60);
  assert.equal(checkCopyLength({ title: authored }, { title: 'title' }).ok, true);
});

test('43 authored characters is the no-brand budget, and 44 is not', () => {
  assert.equal(checkCopyLength({ title: 'a'.repeat(43) }, { title: 'title' }).ok, true);
  assert.equal(checkCopyLength({ title: 'a'.repeat(44) }, { title: 'title' }).ok, false);
});

test('the title constraint explains the SUFFIX RULE, not just a number', () => {
  // "shorten it" is advice a model satisfies by trimming four characters off an
  // already-short title and still landing over the limit.
  const { overlong } = checkCopyLength({ title: 'a'.repeat(50) }, { title: 'title' });
  const c = lengthConstraint(overlong);
  assert.match(c, /storefront renders it as/);
  assert.match(c, /appends " \u2013 Real Skin Care"/);
  assert.match(c, /at most 43 characters WITHOUT the brand/);
  assert.match(c, /at most 60 characters WITH it/);
});

test('the first-prompt rule states the real budget, not the old 50-60', () => {
  assert.match(SEO_COPY_LENGTH_RULE, /at most 43 characters/);
  assert.match(SEO_COPY_LENGTH_RULE, /AUTOMATICALLY appends/);
  assert.ok(!/50.60/.test(SEO_COPY_LENGTH_RULE),
    'the prompt must not still quote the budget that caused the truncation');
});

test('both kinds are declarable', () => {
  assert.deepEqual([...LENGTH_KINDS].sort(), ['description', 'title']);
});

test('at the limit passes; one over fails', () => {
  assert.equal(checkCopyLength({ meta: desc(MAX) }, { meta: 'description' }).ok, true);

  const over = checkCopyLength({ meta: desc(MAX + 1) }, { meta: 'description' });
  assert.equal(over.ok, false);
  assert.deepEqual(over.overlong, [{
    field: 'meta', kind: 'description', length: MAX + 1, max: MAX, over: 1,
    // A description has no render step, so authored and rendered are the same
    // and `rendered` stays undefined — that is what tells a report not to
    // explain a suffix rule that did not apply.
    authoredLength: MAX + 1, rendered: undefined,
  }]);
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

// ── shortenToRenderedLimit — the repair path ──────────────────────────────────

// The four titles below are REAL and were live on 2026-09-06. Each was produced
// by `technical-seo`'s old shortener, which cut to 57, re-added the brand, then
// hard-cut at 60 — landing inside the brand.
const LIVE_DAMAGED = [
  'Coconut Oil Body Lotion That Actually Works for Dry Skin | R \u2013 Real Skin Care',
  'Best Organic Toothpaste: What to Look For & Why It | | Real \u2013 Real Skin Care',
  'Fluoride Free Toothpaste: Benefits, How It Works & Best | Re \u2013 Real Skin Care',
  'Goat Milk Soap: Benefits, Ingredients & Natural Alternatives \u2013 Real Skin Care',
];

test('every repaired title RENDERS within the limit — the property that matters', () => {
  for (const t of LIVE_DAMAGED) {
    const out = shortenToRenderedLimit(t);
    const rendered = [...renderTitle(out)].length;
    assert.ok(rendered <= LENGTH_LIMITS.title.max,
      `"${t}" repaired to "${out}" still renders at ${rendered}`);
  }
});

test('a repaired title never ends mid-brand, which is the defect being fixed', () => {
  for (const t of LIVE_DAMAGED) {
    const out = shortenToRenderedLimit(t);
    // The old shortener produced "| R" and "| | Real". A repair must leave
    // either the WHOLE brand or none of it.
    for (const fragment of ['| R', '| Re', '| Real', '| | Real', '\u2013 Real Skin']) {
      assert.ok(!out.endsWith(fragment), `"${out}" ends with the partial brand "${fragment}"`);
    }
    assert.ok(!/[|\u2013\u2014\-:;,&]\s*$/.test(out), `"${out}" ends on a dangling separator`);
  }
});

test('a CAPITALISED particle is kept — the list is lower case only', () => {
  // Title case makes the distinction usable: a trailing lower-case connective is
  // dangling, a capitalised one is usually part of the phrase. Matching
  // case-insensitively turned "…What to Look For" into "…What to Look".
  assert.equal(
    shortenToRenderedLimit('Best Organic Toothpaste: What to Look For & Why It | | Real \u2013 Real Skin Care'),
    'Best Organic Toothpaste: What to Look For',
  );
});

test('an unclosed bracket is dropped with whatever followed it', () => {
  assert.equal(
    shortenToRenderedLimit('Best Aluminum Free Deodorant in 2026 (That Actually | | Real \u2013 Real Skin Care'),
    'Best Aluminum Free Deodorant in 2026',
  );
});

test('a repaired title never ends on a dangling connective', () => {
  // "Benefits, Ingredients &" and "Deodorant for" are word boundaries and still
  // read as damage, so the cut prefers a CLAUSE boundary where one exists.
  assert.equal(
    shortenToRenderedLimit('Goat Milk Soap: Benefits, Ingredients & Natural Alternatives \u2013 Real Skin Care'),
    'Goat Milk Soap: Benefits, Ingredients',
  );
  // No comma or colon in range here, so it falls back to a word boundary and
  // then strips the dangling "for".
  assert.equal(
    shortenToRenderedLimit('Best Hypoallergenic Deodorant for Sensitive Skin (2026) \u2013 Real Skin Care'),
    'Best Hypoallergenic Deodorant',
  );
  // The case that motivated preferring a clause boundary: cutting at the last
  // SPACE leaves "…Soft Skin, Zero", which reads as damage.
  assert.equal(
    shortenToRenderedLimit('Best Clean Body Lotion: Soft Skin, Zero Toxins | Real | | Re \u2013 Real Skin Care'),
    'Best Clean Body Lotion: Soft Skin',
  );
});

test('a title that already fits is returned UNCHANGED', () => {
  // A repair path must be a no-op on healthy input, or a sweep rewrites the
  // whole corpus for nothing.
  for (const t of ['Coconut Bar Soap \u2013 Real Skin Care', 'Best Soap for Tattoos', 'FAQs | Real Skin Care']) {
    assert.equal(shortenToRenderedLimit(t), t);
  }
});

test('it is idempotent — running the sweep twice changes nothing the second time', () => {
  for (const t of LIVE_DAMAGED) {
    const once = shortenToRenderedLimit(t);
    assert.equal(shortenToRenderedLimit(once), once);
  }
});

test('empty and nullish input never throw on a repair path', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(shortenToRenderedLimit(v), '');
  }
});
