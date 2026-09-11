/**
 * The 2026-09-10 incident: a product-optimizer rewrite called coconut-lotion
 * "no water" / "no water padding" while its Ingredients tab lists purified
 * spring water first. These tests pin the regression against the REAL ingredient
 * lists in the committed PDP templates, and pin the false-positive direction
 * against the REAL copy already live on those templates — a check that fires on
 * the brand's own honest copy would strip good rewrites off an unattended cron.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  parseIngredientList,
  absencePhrases,
  findContradictedAbsences,
  ingredientAbsenceCheck,
  ingredientPromptBlock,
  ingredientTextFromTemplate,
  INGREDIENT_CATEGORY,
} from '../../lib/ingredient-absence-claims.js';

const template = (nick) => readFileSync(`theme/templates/product.landing-page-${nick}.json`, 'utf8');
const LOTION = parseIngredientList(ingredientTextFromTemplate(template('lotion')));
const CREAM = parseIngredientList(ingredientTextFromTemplate(template('cream')));

describe('the incident', () => {
  test('the lotion template really lists water', () => {
    assert.ok(LOTION.some((i) => i.name === 'purified spring water'));
  });

  test('both live strings from 2026-09-10 are caught', () => {
    const meta = 'A coconut oil lotion with only 6 ingredients — no water, no synthetic fragrance, no parabens. Absorbs quickly, never greasy. Five scents or unscented.';
    const body = "Six ingredients. That's the whole list for this coconut oil lotion — organic virgin coconut oil, jojoba, red palm oil, and three more. No fillers, no water padding, no synthetic fragrance.";
    assert.deepEqual(findContradictedAbsences(meta, LOTION).map((h) => h.phrase.toLowerCase()), ['no water']);
    assert.deepEqual(findContradictedAbsences(body, LOTION).map((h) => h.phrase.toLowerCase()), ['no water padding']);
  });

  test('every absence frame is caught for water', () => {
    for (const s of ['A water-free lotion.', 'Made without water.', 'Free from water and fillers.', 'Zero water, all oil.']) {
      assert.equal(findContradictedAbsences(s, LOTION).length, 1, s);
    }
  });

  test('denying the cream its beeswax or palm stearic is caught', () => {
    assert.equal(findContradictedAbsences('No beeswax, no lanolin.', CREAM).length, 1);
    assert.equal(findContradictedAbsences('No palm stearic.', CREAM).length, 1);
    assert.equal(findContradictedAbsences('A palm oil-free cream.', CREAM).length, 1);
  });
});

describe('what must stay allowed', () => {
  test('a modifier the ingredient does not carry makes it a different thing', () => {
    for (const s of [
      'No mineral oil, no petrolatum, no synthetic fragrance.',
      'No petroleum jelly, no mineral oil, no silicones, no lanolin.',
      'A mineral oil-free formula.',
      'No oily residue and no slick film.',
      'No parabens. Nothing you can\'t say out loud.',
      'No preservatives you\'d need to look up.',
      'It no longer feels tight after a shower.',
    ]) {
      assert.deepEqual(findContradictedAbsences(s, LOTION), [], s);
      assert.deepEqual(findContradictedAbsences(s, CREAM), [], s);
    }
  });

  test('a class noun alone is not a contradiction — "no oils added" on a coconut-oil soap', () => {
    const soap = parseIngredientList(ingredientTextFromTemplate(template('bar-soap')));
    assert.ok(soap.some((i) => /coconut oil/.test(i.name)));
    assert.deepEqual(findContradictedAbsences('Pure Unscented: no oils added.', soap), []);
    assert.equal(findContradictedAbsences('No coconut oil in this bar.', soap).length, 1);
  });

  test('ZERO hits across every text setting already live on every PDP template', () => {
    const texts = [];
    const walk = (v) => {
      if (typeof v === 'string') texts.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    let checked = 0;
    for (const f of readdirSync('theme/templates').filter((n) => n.startsWith('product.') && n.endsWith('.json'))) {
      const raw = readFileSync(`theme/templates/${f}`, 'utf8');
      const list = parseIngredientList(ingredientTextFromTemplate(raw));
      if (!list.length) continue;
      texts.length = 0;
      walk(JSON.parse(raw.replace(/^\s*\/\*[\s\S]*?\*\//, '')));
      for (const t of texts) {
        assert.deepEqual(findContradictedAbsences(t.replace(/<[^>]+>/g, ' '), list), [], `${f}: ${t.slice(0, 120)}`);
      }
      checked += 1;
    }
    assert.ok(checked >= 5, `expected several templates with ingredient tabs, checked ${checked}`);
  });
});

describe('parsing', () => {
  test('labels before a colon are not ingredients, and "none" is skipped', () => {
    const names = LOTION.map((i) => i.name);
    assert.ok(names.includes('organic coconut oil extract'));
    assert.ok(!names.some((n) => /breeze|unscented|none|variation/.test(n)));
  });

  test('a sentence inside the list is not an ingredient — the Sensitive Skin Set lander', () => {
    const set = parseIngredientList(ingredientTextFromTemplate(template('sensitive-skin-set-lander')));
    const names = set.map((i) => i.name);
    assert.ok(names.includes('organic red palm oil'));
    assert.ok(!names.some((n) => /essential/.test(n)), JSON.stringify(names));
    assert.deepEqual(findContradictedAbsences('No essential oils added.', set), []);
  });

  test('a list continues through commas and "or"', () => {
    const items = absencePhrases('No petroleum jelly, silicones or added fragrance.').map((p) => p.item);
    assert.deepEqual(items, ['petroleum jelly', 'silicones', 'added fragrance']);
  });
});

describe('the gate-loop check', () => {
  test('no ingredient list means no check, not an empty one', () => {
    assert.equal(ingredientAbsenceCheck(''), null);
    assert.equal(ingredientAbsenceCheck(null), null);
  });

  test('violations name the field, the phrase and the ingredient', () => {
    const c = ingredientAbsenceCheck(ingredientTextFromTemplate(template('lotion')));
    const v = c.check({ meta: 'No water, just oil.', body: '<p>Soaks in fast.</p>' });
    assert.equal(v.length, 1);
    assert.equal(v[0].field, 'meta');
    assert.equal(v[0].category, INGREDIENT_CATEGORY);
    assert.match(v[0].why, /purified spring water/);
    assert.match(c.constraint(v), /INGREDIENT ACCURACY/);
  });

  test('HTML is stripped before matching, so tags cannot hide a claim', () => {
    const c = ingredientAbsenceCheck(ingredientTextFromTemplate(template('lotion')));
    assert.equal(c.check({ body: '<p>No <strong>water</strong> padding.</p>' }).length, 1);
  });
});

describe('the prompt half', () => {
  test('carries the real list and the rule', () => {
    const block = ingredientPromptBlock(ingredientTextFromTemplate(template('lotion')));
    assert.match(block, /Purified spring water/);
    assert.match(block, /water-free/);
  });

  test('without a list it forbids guessing rather than saying nothing', () => {
    assert.match(ingredientPromptBlock(null), /Do not claim it contains or lacks/);
  });
});
