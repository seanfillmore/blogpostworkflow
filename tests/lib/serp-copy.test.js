import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderedSerp, unsupportedNumbers, serpRevertOps } from '../../lib/serp-copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mf = (key, value, id = 1) => ({ id, namespace: 'global', key, value });

describe('renderedSerp — what the search result actually shows', () => {
  test('title_tag wins over article.title (159 of 178 live articles)', () => {
    const r = renderedSerp({ article: { title: 'SLS Free Toothpaste: 7 Picks That Work', body_html: '<p>Body</p>' },
      metafields: [mf('title_tag', 'SLS Free Toothpaste: Top Picks')] });
    assert.equal(r.title, 'SLS Free Toothpaste: Top Picks');
    assert.equal(r.titleTag, 'SLS Free Toothpaste: Top Picks');
  });

  test('with no description_tag the SERP shows the BODY, never summary_html', () => {
    const r = renderedSerp({ article: { title: 'T', summary_html: 'excerpt nobody sees', body_html: '<h2>Clean Teeth</h2><p>No SLS here.</p>' }, metafields: [] });
    assert.equal(r.description, 'Clean Teeth No SLS here.');
    assert.equal(r.descriptionTag, null);
  });
});

describe('unsupportedNumbers — a count in a title is a promise', () => {
  const moisturizer = '<h2>4 Easy Natural Moisturizer Recipes</h2><h3>Recipe 1</h3><h3>Recipe 2</h3>';
  test('the 2026-09-21 case: "5 Recipes" on a page with four', () => {
    assert.deepEqual(unsupportedNumbers('How to Make Natural Moisturizer: 5 Recipes', moisturizer), [5]);
    assert.deepEqual(unsupportedNumbers('How to Make Natural Moisturizer: 4 Recipes', moisturizer), []);
  });
  test('"7 Picks" on a page with no seven of anything', () => {
    assert.deepEqual(unsupportedNumbers('Best Deodorant for Sensitive Skin: 7 Clean Picks', '<p>Why sensitive skin reacts</p>'), [7]);
  });
  test('a number written as a word counts; years and percentages are exempt', () => {
    assert.deepEqual(unsupportedNumbers('5 Ingredients', '<p>You need five ingredients</p>'), []);
    assert.deepEqual(unsupportedNumbers('Best Picks for 2026, 100% natural', '<p>nothing</p>'), []);
  });
});

describe('serpRevertOps', () => {
  test('restores a prior tag, deletes one that did not exist before', () => {
    const ops = serpRevertOps({ originalTitleTag: 'Old Title', originalDescriptionTag: null },
      [mf('title_tag', 'New Title', 11), mf('description_tag', 'New desc', 12)]);
    assert.deepEqual(ops, [{ op: 'set', key: 'title_tag', value: 'Old Title' }, { op: 'delete', key: 'description_tag', id: 12 }]);
  });
});

test('meta-optimizer writes the SERP metafields and no longer the article title/excerpt', () => {
  const src = readFileSync(join(ROOT, 'agents/meta-optimizer/index.js'), 'utf8');
  const apply = src.slice(src.indexOf('// The SERP fields, not article.title'), src.indexOf('result.applied = true'));
  assert.match(apply, /upsertMetafield\('articles', article\.id, 'global', TITLE_TAG/);
  assert.match(apply, /DESCRIPTION_TAG/);
  assert.doesNotMatch(apply, /updateArticle/);
  assert.match(src, /unsupportedNumbers\(/);
  assert.doesNotMatch(src, /a count \("7 Picks"\)/, 'the prompt must not invite an invented count');
});

test('meta-ab-checker reverts SERP-field entries through their metafields', () => {
  const src = readFileSync(join(ROOT, 'agents/meta-ab-checker/index.js'), 'utf8');
  assert.match(src, /if \(entry\.serpFields\)[\s\S]*serpRevertOps/);
});
