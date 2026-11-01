import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectDeadPaths, buildChoiceList, parseChoice, fixSchemelessHrefs, resourceForPath,
  parseRenderedPage, shouldHideOrphan, headKeywords, titleRewriteProblems, descriptionProblems,
} from '../../lib/tech-seo-steward.js';

const row = (url, inlinks = 3) => ({ url, 'no._of_all_inlinks': inlinks });

test('selectDeadPaths keeps only real, unresolved dead paths', () => {
  const { targets, skipped } = selectDeadPaths([
    row('https://www.realskincare.com/blogs/news/what-is-natural-skincare'),
    row('https://www.realskincare.com/blogs/news/what-is-natural-skincare'), // dupe
    row('https://www.realskincare.com/blogs/news/no-links', 0),
    row('https://www.realskincare.com/cdn-cgi/l/email-protection', 225),
    row('https://www.realskincare.com/policies/www.allaboutcookies.org', 1),
    row('https://www.realskincare.com/blogs/news/already-redirected'),
    row('https://www.realskincare.com/blogs/news/live-again'),
    row('https://www.realskincare.com/blogs/news/chlorophyll-deodorant-does-it-actually-work', 22),
  ], {
    redirectPaths: new Set(['/blogs/news/already-redirected']),
    livePaths: new Set(['/blogs/news/live-again']),
    pendingPaths: new Set(['/blogs/news/chlorophyll-deodorant-does-it-actually-work']),
  });
  assert.deepEqual(targets.map((t) => t.path), ['/blogs/news/what-is-natural-skincare']);
  assert.equal(targets[0].type, 'article');
  assert.equal(skipped.length, 6);
  assert.match(skipped.find((s) => s.path.includes('chlorophyll')).why, /scheduled/);
});

test('buildChoiceList always offers the hub and never duplicates', () => {
  const inv = { articles: [{ path: '/blogs/news/a', title: 'A' }, { path: '/blogs/news/a', title: 'A' }] };
  const list = buildChoiceList('article', inv);
  assert.deepEqual(list.map((c) => c.path), ['/blogs/news/a', '/blogs/news']);
  const prod = buildChoiceList('product', { products: [{ path: '/products/x' }], collections: [{ path: '/collections/y' }] });
  assert.deepEqual(prod.map((c) => c.path), ['/products/x', '/collections/y', '/collections/all']);
});

test('parseChoice accepts only an index into the closed list', () => {
  const choices = [{ path: '/a' }, { path: '/b' }];
  assert.deepEqual(parseChoice('ok {"choice": 1, "why": "same topic"}', choices), { path: '/b', why: 'same topic' });
  assert.equal(parseChoice('{"choice": 5}', choices), null);
  assert.equal(parseChoice('{"choice": "/a"}', choices), null);
  assert.equal(parseChoice('no json', choices), null);
});

test('fixSchemelessHrefs repairs hostnames and leaves everything else alone', () => {
  const html = '<a href="www.allaboutcookies.org" target="_blank">x</a> <a href="/pages/faqs">f</a>'
    + ' <a href="guide.pdf">g</a> <a href="https://ok.com">o</a> <a href="example.com/path?q=1">e</a> <a href="#top">t</a>';
  const { html: out, fixed } = fixSchemelessHrefs(html);
  assert.deepEqual(fixed, ['www.allaboutcookies.org', 'example.com/path?q=1']);
  assert.match(out, /href="https:\/\/www\.allaboutcookies\.org"/);
  assert.match(out, /href="\/pages\/faqs"/);
  assert.match(out, /href="guide\.pdf"/);
  assert.match(out, /href="https:\/\/example\.com\/path\?q=1"/);
  assert.equal(fixSchemelessHrefs(out).fixed.length, 0, 'idempotent');
});

test('resourceForPath maps storefront paths', () => {
  assert.deepEqual(resourceForPath('/products/coconut-lotion-4-pack'), { resource: 'products', handle: 'coconut-lotion-4-pack' });
  assert.deepEqual(resourceForPath('/pages/klaviyo-test'), { resource: 'pages', handle: 'klaviyo-test' });
  assert.deepEqual(resourceForPath('/blogs/news/foo'), { resource: 'articles', handle: 'foo' });
  assert.equal(resourceForPath('/blogs/news'), null);
});

test('parseRenderedPage reads robots, description and title', () => {
  const p = parseRenderedPage('<title>\n X &ndash; Real Skin Care</title><meta name="robots" content="noindex,follow"><meta name="description" content="Tom&#39;s &amp; more">');
  assert.equal(p.noindex, true);
  assert.equal(p.metaDescription, "Tom's & more");
  assert.equal(p.title, 'X &ndash; Real Skin Care');
  assert.equal(parseRenderedPage('<title>y</title>').noindex, false);
});

test('shouldHideOrphan needs no links AND zero impressions, pages only', () => {
  assert.equal(shouldHideOrphan({ resource: 'pages', inlinks: 0, impressions90d: 0 }), true);
  assert.equal(shouldHideOrphan({ resource: 'pages', inlinks: 0, impressions90d: 12 }), false);
  assert.equal(shouldHideOrphan({ resource: 'pages', inlinks: 0, impressions90d: null }), false, 'unknown is not zero');
  assert.equal(shouldHideOrphan({ resource: 'products', inlinks: 0, impressions90d: 0 }), false);
});

test('titleRewriteProblems keeps ranking words and counts honest', () => {
  const src = 'Ivory Soap Alternatives: 6 Gentle Natural Soaps That Still Clean';
  assert.deepEqual(headKeywords(src), ['ivory', 'soap', 'alternatives']);
  assert.deepEqual(titleRewriteProblems('6 Natural Ivory Soap Alternatives', src), []);
  assert.match(titleRewriteProblems('7 Natural Ivory Soap Alternatives', src).join(), /invents numbers: 7/);
  assert.match(titleRewriteProblems('Gentle Bar Soaps That Clean', src).join(), /drops ranking words/);
  assert.match(titleRewriteProblems('Ivory Soap Alternatives That Are Gentle and Natural', src).join(), /renders at/);
});

test('descriptionProblems enforces the 160 limit and no invented numbers', () => {
  const ok = 'Looking for an Ivory soap alternative? Compare six gentle, natural bars and learn which ingredients to look for on the label.';
  assert.deepEqual(descriptionProblems(ok, 'six soaps'), []);
  assert.match(descriptionProblems('x'.repeat(170)).join(), /> 160/);
  assert.match(descriptionProblems('Short.').join(), /< 70/);
  assert.match(descriptionProblems(`${ok} Try 12 bars.`.slice(0, 150), 'six').join(), /invents numbers/);
});

import { ctrProtectedHandles } from '../../lib/ctr-protected.js';

test('ctrProtectedHandles unions wave arms and open tests, fails open', () => {
  const files = {
    'wave.json': JSON.stringify({ holdout: [{ url: 'https://www.realskincare.com/blogs/news/h1' }], treatment: [{ url: '/blogs/news/t1/' }], individual: [] }),
    'meta-ab-tracker.json': JSON.stringify([{ pageUrl: '/blogs/news/open', status: 'active' }, { pageUrl: '/blogs/news/done', status: 'concluded' }]),
  };
  const read = (p) => { const k = p.split('/').pop(); if (!files[k]) throw new Error('missing'); return files[k]; };
  assert.deepEqual([...ctrProtectedHandles('/x', { read })].sort(), ['h1', 'open', 't1']);
  assert.equal(ctrProtectedHandles('/x', { read: () => { throw new Error('none'); } }).size, 0);
});
