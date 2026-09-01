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
  const g = guardFor('a.b.c');
  assert.match(g, /#shopify-section-\{\{ section\.id \}\}\{display:none\}/);
  assert.match(g, /assign _guard = a\.b\.c/);
});

test('the guard fires on blank AND on an empty list', () => {
  const g = guardFor('x');
  // A list metafield with no rows is not `blank` in Liquid — it is an empty
  // array — so testing blank alone would leave every empty-list section padded.
  assert.match(g, /_guard == blank or _guard\.size == 0/);
});

test('guards are PREPENDED, leaving the original liquid byte-identical', () => {
  const body = '<style>.x{}</style>{%- if y -%}<section>hi</section>{%- endif -%}';
  const t = JSON.stringify({ sections: { stats: { settings: { custom_liquid: body } } }, order: ['stats'] });
  const { json, changed } = applyGuards(t, { stats: 'st' });
  assert.deepEqual(changed, ['stats']);
  const out = json.sections.stats.settings.custom_liquid;
  assert.ok(out.endsWith(body), 'the existing liquid must survive untouched at the end');
  assert.ok(out.startsWith(`{%- comment -%}${MARKER}`), 'the guard goes in front');
});

test('a second run changes nothing', () => {
  const t = JSON.stringify({ sections: { stats: { settings: { custom_liquid: '<section>x</section>' } } } });
  const once = applyGuards(t, { stats: 'st' });
  const twice = applyGuards(JSON.stringify(once.json), { stats: 'st' });
  assert.deepEqual(twice.changed, [], 'idempotent');
  assert.deepEqual(twice.skipped, ['stats']);
  assert.equal(
    twice.json.sections.stats.settings.custom_liquid,
    once.json.sections.stats.settings.custom_liquid,
  );
});

test('a section missing from the template is reported, never invented', () => {
  const t = JSON.stringify({ sections: {} });
  const { missing, changed } = applyGuards(t, { stats: 'st' });
  assert.deepEqual(changed, []);
  assert.deepEqual(missing, ['stats']);
});

test('whats-in-it is guarded by the same loop its body uses, not by an expression', () => {
  // Its emptiness is "no variant carries a value_stack" — hand-soap-set is the
  // live case, and it renders an empty padded grid on a published product page.
  assert.equal(SECTION_DATA['whats-in-it'], null);
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
