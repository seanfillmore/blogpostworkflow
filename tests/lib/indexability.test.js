// tests/lib/indexability.test.js
//
// "WOULD GOOGLE INDEX THIS URL?" — the check that stops `theme-seo-auditor`
// auditing pages that cannot rank.
//
// Measured against live on 2026-09-05, TWO of its five template rows were
// meaningless: `blog_post` audited Shopify's 404 page (the picked article is a
// draft that 404s), and `page` audited `/pages/sales-page-v1`, which is
// `noindex,nofollow` and absent from the sitemap. The noindex is DELIBERATE —
// `agents/technical-seo --fix-noindex` exists to put it on ads landing pages —
// and the auditor then reported that page's missing <h1> as its only CRITICAL
// issue. The headline issue count was manufactured from a page the fleet had
// intentionally excluded from search.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkIndexable, robotsMetaDirective } from '../../lib/indexability.js';

const OK = '<html><head><title>x</title></head><body>hi</body></html>';

test('a plain 200 page is indexable', () => {
  const v = checkIndexable({ status: 200, html: OK });
  assert.equal(v.indexable, true);
  assert.equal(v.reason, null);
});

test('THE 404 CASE: the picked blog article does not exist', () => {
  // Shopify serves its 404 page, whose own canonical is /404 — which the
  // auditor was reporting as a finding about a blog post.
  const v = checkIndexable({ status: 404, html: '<link rel="canonical" href="https://x/404">' });
  assert.equal(v.indexable, false);
  assert.match(v.reason, /404/);
});

test('THE NOINDEX CASE: /pages/sales-page-v1', () => {
  // The exact live markup, and the reason the agent reported "1 critical".
  const v = checkIndexable({
    status: 200,
    html: '<meta name="robots" content="noindex,nofollow">',
  });
  assert.equal(v.indexable, false);
  assert.match(v.reason, /noindex/);
});

test('nofollow ALONE does not disqualify — it governs links, not indexing', () => {
  const v = checkIndexable({ status: 200, html: '<meta name="robots" content="nofollow">' });
  assert.equal(v.indexable, true);
});

test('`none` blocks, because it means noindex,nofollow', () => {
  assert.equal(checkIndexable({ status: 200, html: '<meta name="robots" content="none">' }).indexable, false);
});

test('attribute ORDER does not matter', () => {
  // `<meta content="noindex" name="robots">` is as valid as the usual spelling.
  // A single ordered mega-regex misses it, and a miss here means auditing a
  // noindex page — exactly the defect this exists to fix.
  const v = checkIndexable({ status: 200, html: '<meta content="noindex" name="robots">' });
  assert.equal(v.indexable, false);
});

test('a googlebot-specific noindex blocks too', () => {
  assert.equal(
    checkIndexable({ status: 200, html: '<meta name="googlebot" content="noindex">' }).indexable,
    false,
  );
});

test('a non-robots meta carrying the word is ignored', () => {
  // `<meta name="description" content="...how to noindex a page...">` is an
  // article ABOUT noindex, not a noindexed page. Keying on `name` is what
  // separates them.
  const html = '<meta name="description" content="A guide to noindex and nofollow directives">';
  assert.equal(checkIndexable({ status: 200, html }).indexable, true);
  assert.equal(robotsMetaDirective(html), null);
});

test('X-Robots-Tag is header-level noindex and binds the same way', () => {
  const v = checkIndexable({ status: 200, html: OK, headers: { 'x-robots-tag': 'noindex' } });
  assert.equal(v.indexable, false);
  assert.match(v.reason, /X-Robots-Tag/);
});

test('X-Robots-Tag header name is matched case-insensitively', () => {
  // puppeteer lowercases them; a caller passing raw headers must not silently miss.
  assert.equal(
    checkIndexable({ status: 200, html: OK, headers: { 'X-Robots-Tag': 'googlebot: noindex' } }).indexable,
    false,
  );
});

test('X-Robots-Tag carrying only nofollow does not block', () => {
  assert.equal(
    checkIndexable({ status: 200, html: OK, headers: { 'x-robots-tag': 'nofollow' } }).indexable,
    true,
  );
});

test('a 3xx is not indexable — the audited page is not the page at this URL', () => {
  assert.equal(checkIndexable({ status: 301, html: OK }).indexable, false);
});

test('a MISSING status is treated as indexable rather than guessed at', () => {
  // Refusing everything we cannot measure would make this check silently skip
  // the whole run — the "quiet loss of capability" failure mode this repo keeps
  // relearning. A caller with no status still has HTML worth auditing.
  assert.equal(checkIndexable({ html: OK }).indexable, true);
  assert.equal(checkIndexable({}).indexable, true);
  assert.equal(checkIndexable().indexable, true);
});

test('directive matching tolerates spacing and case', () => {
  for (const content of ['NoIndex', ' noindex , nofollow ', 'NOINDEX']) {
    assert.equal(
      checkIndexable({ status: 200, html: `<meta name="robots" content="${content}">` }).indexable,
      false,
      `"${content}" should block`,
    );
  }
});

test('a substring is not a directive', () => {
  // "noindexing" is not "noindex". Splitting on commas and comparing whole
  // directives is what prevents this; a bare `includes('noindex')` would fire.
  assert.equal(
    checkIndexable({ status: 200, html: '<meta name="robots" content="noindexing-tips">' }).indexable,
    true,
  );
});
