// tests/dashboard/contest-recipe-text.test.js
// The pure text helpers the competitor page uses to turn an imported recipe into the
// Dish name / Ingredients / Recipe fields (agents/dashboard/public/contest/assets/recipe-text.js).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  dishNameFrom, servesLine, timeLine, fitLines, buildRecipeText,
} from '../../agents/dashboard/public/contest/assets/recipe-text.js';

test('dishNameFrom strips a trailing " Recipe" (any case) and caps at 80', () => {
  assert.equal(dishNameFrom('Smoked Turkey Recipe'), 'Smoked Turkey');
  assert.equal(dishNameFrom('Smoked Turkey recipe '), 'Smoked Turkey');
  assert.equal(dishNameFrom('Easy Lasagna RECIPE'), 'Easy Lasagna');
  assert.equal(dishNameFrom('Recipe Box Cookies'), 'Recipe Box Cookies');
  assert.equal(dishNameFrom('Grandmas Recipes'), 'Grandmas Recipes');
  assert.equal(dishNameFrom('Recipe'), 'Recipe', 'never empties the name');
  assert.equal(dishNameFrom('x'.repeat(100)).length, 80);
  assert.equal(dishNameFrom(''), '');
  assert.equal(dishNameFrom(null), '');
});

test('servesLine and timeLine', () => {
  assert.equal(servesLine('12'), 'Serves 12');
  assert.equal(servesLine('6 to 8 servings'), 'Serves 6 to 8');
  assert.equal(servesLine('2 dozen'), 'Makes 2 dozen');
  assert.equal(servesLine(null), null);
  assert.equal(timeLine(370), 'About 6 hours 10 min');
  assert.equal(timeLine(60), 'About 1 hour');
  assert.equal(timeLine(45), 'About 45 min');
  assert.equal(timeLine(null), null);
});

test('fitLines cuts between lines and reports the cut', () => {
  assert.deepEqual(fitLines(['ab', 'cd'], 10), { text: 'ab\ncd', cut: false });
  assert.deepEqual(fitLines(['ab', 'cd', 'ef'], 5), { text: 'ab\ncd', cut: true });
  assert.deepEqual(fitLines(['abcdef'], 3), { text: 'abc', cut: true });
});

test('buildRecipeText numbers steps, keeps headings, ends with the source, and fits 8,000', () => {
  const r = buildRecipeText({ steps: ['For the brine:', 'Mix.', 'Soak.', 'To cook:', 'Smoke.'], headings: [0, 3], recipeYield: '12', totalMinutes: 370 }, 'https://a.example/x');
  assert.equal(r.text, 'Serves 12 · About 6 hours 10 min\n\nFor the brine:\n1. Mix.\n2. Soak.\n\nTo cook:\n3. Smoke.\n\nSource: https://a.example/x');
  assert.equal(r.steps, 3);
  assert.equal(r.cut, false);
  const big = buildRecipeText({ steps: Array(200).fill('y'.repeat(100)), headings: [] }, 'https://a.example/x');
  assert.ok(big.text.length <= 8000);
  assert.ok(big.text.endsWith('\n\nSource: https://a.example/x'));
  assert.equal(big.cut, true);
});
