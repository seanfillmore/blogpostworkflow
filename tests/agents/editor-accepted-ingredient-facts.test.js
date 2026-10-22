// The editor's INGREDIENT ACCURACY rule must not block owner-confirmed facts.
// On 2026-10-18 it filed "cold-pressed coconut oil" as a BLOCKER because the spec
// says "organic virgin coconut oil"; blocked-post-resolver would then have
// "fixed" a true claim off live pages. Sean, 2026-10-07: cold-pressed is true,
// and "all organic" is accurate. A source scan: importing the agent runs it.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../agents/editor/index.js', import.meta.url), 'utf8');
const start = SRC.indexOf('3. INGREDIENT ACCURACY');
const rule = SRC.slice(start, SRC.indexOf('4. YEAR ACCURACY', start));

test('ingredient accuracy accepts cold-pressed coconut oil', () => {
  assert.match(rule, /cold-pressed/i);
});

test('ingredient accuracy accepts "all organic"', () => {
  assert.match(rule, /all organic/i);
});

test('a product free_from list reaches the ingredient-accuracy context', () => {
  assert.match(SRC, /freeFrom: Array\.isArray\(p\.free_from\)/);
  assert.match(SRC, /\$\{formatNote\}\$\{freeFromNote\}/);
});

test('the toothpaste spec lists what it is verified free from', async () => {
  const { readFileSync: r } = await import('node:fs');
  const ing = JSON.parse(r(new URL('../../config/ingredients.json', import.meta.url), 'utf8'));
  const t = ing.toothpaste;
  for (const x of ['glycerin', 'preservatives', 'fluoride']) assert.ok(t.free_from.includes(x), x);
  // A free-from entry may never contradict the ingredient list itself.
  const all = [...t.base_ingredients, ...t.variations.flatMap((v) => v.essential_oils || [])].join(' ').toLowerCase();
  for (const x of t.free_from) assert.ok(!all.includes(x.split(' ')[0].toLowerCase()), `${x} is in the ingredient list`);
});
