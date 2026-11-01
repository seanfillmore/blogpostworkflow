import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bulletProblems, benefitIds, applyBullets, loadBullets } from '../../scripts/apply-pdp-outcome-bullets.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const tpl = (f) => JSON.parse(readFileSync(join(ROOT, 'theme', 'templates', f), 'utf8'));

test('every approved bullet passes every gate', () => {
  for (const [file, lines] of Object.entries(loadBullets())) {
    for (const l of lines) assert.deepEqual(bulletProblems(l), [], `${file}: ${l}`);
  }
});

test('the gates refuse a drug claim, the wrong category and an em dash', () => {
  assert.ok(bulletProblems('Heals cracked skin overnight.').length);
  assert.ok(bulletProblems('Our antiperspirant keeps you dry.').length);
  assert.ok(bulletProblems('Soft skin — all day.').includes('em dash'));
});

test('each page gets exactly one bullet per rendered benefit block', () => {
  for (const [file, lines] of Object.entries(loadBullets())) {
    assert.equal(benefitIds(tpl(file)).length, lines.length, file);
  }
});

test('applyBullets refuses a count mismatch rather than leaving a stale bullet', () => {
  const t = tpl('product.landing-page-cream.json');
  assert.throws(() => applyBullets(t, ['one'], 'cream'), /refusing/);
});
