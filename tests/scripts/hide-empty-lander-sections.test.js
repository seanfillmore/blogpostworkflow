import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECTION_DATA, MARKER, TEMPLATE, guardFor, applyGuards, WHATS_IN_IT_GUARD,
} from '../../scripts/hide-empty-lander-sections.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each data-driven section guards its CONTENT but not its WRAPPER, and the
// wrapper carries 36px top + 36px bottom whether or not anything rendered. Only
// the Coconut Reset has timeline/mechanism/ingredient-cards/stats/founder-note
// data, so the other four landers stacked six empty padded wrappers between the
// free-from band and the FAQ.

test('the guard hides the section by its OWN id', () => {
  const g = guardFor({ data: 'a.b.c' });
  assert.match(g, /#shopify-section-\{\{ section\.id \}\}\{display:none\}/);
  assert.match(g, /assign _guard = a\.b\.c/);
});

test('the guard fires on blank AND on an empty list', () => {
  const g = guardFor({ data: 'x' });
  // A list metafield with no rows is not `blank` in Liquid — it is an empty
  // array — so testing blank alone would leave every empty-list section padded.
  assert.match(g, /_guard == blank or _guard\.size == 0/);
});

test('guards are PREPENDED, leaving the original liquid byte-identical', () => {
  const body = '<style>.x{}</style>{%- if y -%}<section>hi</section>{%- endif -%}';
  const t = JSON.stringify({ sections: { stats: { settings: { custom_liquid: body } } }, order: ['stats'] });
  const { json, changed } = applyGuards(t, { stats: { data: 'st' } });
  assert.deepEqual(changed, ['stats']);
  const out = json.sections.stats.settings.custom_liquid;
  assert.ok(out.endsWith(body), 'the existing liquid must survive untouched at the end');
  assert.ok(out.startsWith(`{%- comment -%}${MARKER}`), 'the guard goes in front');
});

test('a second run changes nothing', () => {
  const t = JSON.stringify({ sections: { stats: { settings: { custom_liquid: '<section>x</section>' } } } });
  const once = applyGuards(t, { stats: { data: 'st' } });
  const twice = applyGuards(JSON.stringify(once.json), { stats: { data: 'st' } });
  assert.deepEqual(twice.changed, [], 'idempotent');
  assert.deepEqual(twice.skipped, ['stats']);
  assert.equal(
    twice.json.sections.stats.settings.custom_liquid,
    once.json.sections.stats.settings.custom_liquid,
  );
});

test('a section missing from the template is reported, never invented', () => {
  const t = JSON.stringify({ sections: {} });
  const { missing, changed } = applyGuards(t, { stats: { data: 'st' } });
  assert.deepEqual(changed, []);
  assert.deepEqual(missing, ['stats']);
});

test('whats-in-it is guarded by the same loop its body uses, not by an expression', () => {
  // Its emptiness is "no variant carries a value_stack" — hand-soap-set is the
  // live case, and it renders an empty padded grid on a published product page.
  assert.equal(SECTION_DATA['whats-in-it'].variantStack, true);
  assert.equal(SECTION_DATA['whats-in-it'].data, undefined, 'its emptiness is not one expression');
  assert.match(WHATS_IN_IT_GUARD, /for v in product\.variants/);
  assert.match(WHATS_IN_IT_GUARD, /unless _guard_stack/);
  assert.match(WHATS_IN_IT_GUARD, /display:none/);
});

test('every section named here really exists in the live template', () => {
  const json = JSON.parse(readFileSync(join(ROOT, TEMPLATE), 'utf8'));
  for (const key of Object.keys(SECTION_DATA)) {
    assert.ok(json.sections[key], `${key} is named in SECTION_DATA but absent from the template`);
    assert.equal(typeof json.sections[key].settings?.custom_liquid, 'string',
      `${key} is not a custom_liquid section`);
  }
});

test('the six sections that caused the gap are all covered', () => {
  for (const k of ['timeline', 'mechanism', 'ingredient-cards', 'stats', 'compare-rows', 'founder-note']) {
    assert.ok(k in SECTION_DATA, `${k} renders empty padding on four landers and must be guarded`);
  }
});

test('the static free-from band is NOT guarded', () => {
  // It has no data source — it is the same copy on every lander and must always
  // render. Guarding it on a blank expression would hide it everywhere.
  assert.ok(!('free-from-block' in SECTION_DATA));
});

// ── imagery requirement ────────────────────────────────────────────────────
// Sean, 2026-09-01: "We do not have lifestyle shots right now. Collapse any
// section that does not have the correct imagery."
//
// Two sections fall back to an "Image coming soon" placeholder SVG rather than
// rendering nothing, so HAVING COPY IS NOT ENOUGH — the Reset lander was live
// with two of them under its mechanism section. A placeholder reads as a broken
// page; an absent section reads as a page that simply does not have that part.

test('mechanism collapses when its images do not cover every row', () => {
  const g = guardFor(SECTION_DATA.mechanism);
  assert.match(g, /mechanism_images/);
  // Fewer images than rows still leaves SOME rows on a placeholder, so the test
  // has to be per-row coverage, not "are there any images at all".
  assert.match(g, /\.size\s*<\s*_guard\.size/, 'must compare image count against row count');
  assert.match(g, /display:none/);
});

test('founder-note collapses without a founder image', () => {
  const g = guardFor(SECTION_DATA['founder-note']);
  assert.match(g, /founder_image/);
  assert.match(g, /display:none/);
});

test('a section with no imagery requirement does not mention images', () => {
  const g = guardFor(SECTION_DATA.stats);
  assert.ok(!/image/i.test(g), 'stats renders no figure and must not gain an image condition');
});

test('re-running REPLACES a guard instead of stacking a second one', () => {
  // The first version of this script shipped guards without an image condition.
  // Upgrading them has to rewrite in place; prepending again would leave two
  // guards and a stale one that can never be found by reading the top of the file.
  const body = '<section>x</section>';
  const t = JSON.stringify({ sections: { stats: { settings: { custom_liquid: body } } } });
  const once = applyGuards(t, { stats: SECTION_DATA.stats });
  const twice = applyGuards(JSON.stringify(once.json), { stats: SECTION_DATA.stats });
  const out = twice.json.sections.stats.settings.custom_liquid;
  // The marker appears twice per guard (open + closing `/empty-section-guard`),
  // so count OPENING markers to tell one guard from two.
  const opens = (out.match(new RegExp(`\\{%- comment -%\\}${MARKER}\\{%- endcomment -%\\}`, 'g')) || []).length;
  assert.equal(opens, 1, 'exactly one guard');
  assert.ok(out.endsWith(body), 'the section body still survives untouched');
});

test('every section that renders a placeholder declares an imagery requirement', () => {
  // A source scan, so a NEW placeholder-bearing section cannot be added without
  // also being gated — that is precisely how the Reset shipped with two.
  const json = JSON.parse(readFileSync(join(ROOT, TEMPLATE), 'utf8'));
  for (const [key, sec] of Object.entries(json.sections)) {
    const cl = sec.settings?.custom_liquid;
    if (!cl || !cl.includes('bl-ph')) continue;
    const spec = SECTION_DATA[key];
    assert.ok(spec, `${key} renders a placeholder but is not in SECTION_DATA`);
    assert.ok(spec.image || spec.imageList, `${key} renders a placeholder but declares no imagery requirement`);
  }
});
