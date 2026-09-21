import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  extractArticleDates, articleAgeDays, isStaleArticle, STALE_ARTICLE_DAYS,
} from '../../lib/article-freshness.js';

// The audit that produced this module ran on 2026-09-20; every age below is
// measured against that instant so the numbers in the module header are
// checkable rather than asserted.
const NOW = Date.parse('2026-09-20T00:00:00Z');

// ---------------------------------------------------------------------------
// extractArticleDates
// ---------------------------------------------------------------------------

test('parses dateModified and datePublished from JSON-LD', () => {
  const html = `<script type="application/ld+json">
    {"@type":"Article","datePublished":"2026-01-10T09:00:00Z","dateModified":"2026-04-03T12:00:00Z"}
  </script>`;
  const out = extractArticleDates(html, { now: NOW });
  assert.equal(out.published.slice(0, 10), '2026-01-10');
  assert.equal(out.modified.slice(0, 10), '2026-04-03');
});

test('walks a @graph', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"x"},
      {"@type":"Article","dateModified":"2023-08-12"}
    ]}
  </script>`;
  assert.equal(extractArticleDates(html, { now: NOW }).modified.slice(0, 10), '2023-08-12');
});

test('falls back to the article:modified_time / published_time meta tags', () => {
  const html = `<meta property="article:published_time" content="2021-02-06T15:30:00+00:00">
    <meta property="article:modified_time" content="2021-02-06T16:00:00+00:00">`;
  const out = extractArticleDates(html, { now: NOW });
  assert.equal(out.published.slice(0, 10), '2021-02-06');
  assert.equal(out.modified.slice(0, 10), '2021-02-06');
});

test('reads a meta tag whose content attribute comes FIRST', () => {
  const html = `<meta content="2026-03-05" property="article:modified_time">`;
  assert.equal(extractArticleDates(html, { now: NOW }).modified.slice(0, 10), '2026-03-05');
});

test('a JSON-LD block that will not PARSE still yields its dates by regex', () => {
  // 58 of this site's own live pages carry unparseable JSON-LD; other people's
  // pages are no better. Throwing the block away would lose a real date.
  const html = `<script type="application/ld+json">
    {"@type":"Article","headline":"He said "hi"","dateModified":"2026-04-03"}
  </script>`;
  assert.equal(extractArticleDates(html, { now: NOW }).modified.slice(0, 10), '2026-04-03');
});

test('prefers a <time> element explicitly marked as an update', () => {
  const html = `<time datetime="2020-01-01">published</time>
    <time class="entry-date updated" datetime="2026-03-05">updated</time>`;
  const out = extractArticleDates(html, { now: NOW });
  assert.equal(out.modified.slice(0, 10), '2026-03-05');
  assert.equal(out.published.slice(0, 10), '2020-01-01');
});

test('a page that states no date returns nulls, not a guess', () => {
  assert.deepEqual(extractArticleDates('<html><body><p>hi</p></body></html>', { now: NOW }),
    { published: null, modified: null });
  assert.deepEqual(extractArticleDates(null, { now: NOW }), { published: null, modified: null });
  assert.deepEqual(extractArticleDates('', { now: NOW }), { published: null, modified: null });
});

test('implausible dates are rejected rather than returned', () => {
  // Themes really do emit these, and a 1970 date would read as maximally stale
  // while a far-future one would read as brand new.
  assert.equal(extractArticleDates('<meta property="article:modified_time" content="0000-00-00">', { now: NOW }).modified, null);
  assert.equal(extractArticleDates('<meta property="article:modified_time" content="1970-01-01">', { now: NOW }).modified, null);
  assert.equal(extractArticleDates('<meta property="article:modified_time" content="2030-01-01">', { now: NOW }).modified, null);
  assert.equal(extractArticleDates('<meta property="article:modified_time" content="not a date">', { now: NOW }).modified, null);
});

test('a date two days ahead is tolerated — scheduled posts and timezone skew', () => {
  const html = '<meta property="article:modified_time" content="2026-09-21T00:00:00Z">';
  assert.equal(extractArticleDates(html, { now: NOW }).modified.slice(0, 10), '2026-09-21');
});

// ---------------------------------------------------------------------------
// articleAgeDays
// ---------------------------------------------------------------------------

test('age is measured from the MOST RECENT stamp the page carries', () => {
  const age = articleAgeDays({ published: '2020-01-01', modified: '2026-09-10' }, { now: NOW });
  assert.equal(age, 10);
});

test('age falls back to published when there is no modified', () => {
  assert.equal(articleAgeDays({ published: '2026-09-10' }, { now: NOW }), 10);
});

test('no date at all yields null, never 0', () => {
  // 0 would read as "updated today", the single most dangerous wrong answer.
  assert.equal(articleAgeDays({}, { now: NOW }), null);
  assert.equal(articleAgeDays({ published: null, modified: null }, { now: NOW }), null);
  assert.equal(articleAgeDays(undefined, { now: NOW }), null);
  assert.equal(articleAgeDays({ modified: 'garbage' }, { now: NOW }), null);
});

// ---------------------------------------------------------------------------
// isStaleArticle — the calibration that justifies STALE_ARTICLE_DAYS
// ---------------------------------------------------------------------------

test('the threshold sits in the measured gap between live and abandoned pages', () => {
  // The four pages the 2026-09-20 audit actually measured.
  const live = [
    ['Non-Toxic Lab', '2026-04-03', 170],
    ['The Daley Dose', '2026-03-05', 199],
  ];
  const dead = [
    ['Better Goods', '2023-08-12', 1135],
    ['Elite Daily', '2021-02-06', 2052],
  ];
  for (const [name, date, expectedAge] of live) {
    const age = articleAgeDays({ modified: date }, { now: NOW });
    assert.ok(Math.abs(age - expectedAge) <= 1, `${name}: age ${age}, expected ~${expectedAge}`);
    assert.equal(isStaleArticle({ modified: date }, { now: NOW }), false, `${name} must not be stale`);
  }
  for (const [name, date, expectedAge] of dead) {
    const age = articleAgeDays({ published: date }, { now: NOW });
    assert.ok(Math.abs(age - expectedAge) <= 1, `${name}: age ${age}, expected ~${expectedAge}`);
    assert.equal(isStaleArticle({ published: date }, { now: NOW }), true, `${name} must be stale`);
  }
  // And the threshold genuinely sits inside the gap rather than beside an edge.
  assert.ok(STALE_ARTICLE_DAYS > 199 + 50, 'too close to the freshest abandoned-looking live page');
  assert.ok(STALE_ARTICLE_DAYS < 1135 - 50, 'too close to the oldest genuinely-dead page');
});

test('a page with NO date is never stale — it fails open', () => {
  assert.equal(isStaleArticle({}, { now: NOW }), false);
  assert.equal(isStaleArticle({ published: null, modified: null }, { now: NOW }), false);
});

test('the boundary is exclusive: exactly at the threshold is still fresh', () => {
  const atLimit = new Date(NOW - STALE_ARTICLE_DAYS * 86_400_000).toISOString();
  const pastLimit = new Date(NOW - (STALE_ARTICLE_DAYS + 1) * 86_400_000).toISOString();
  assert.equal(isStaleArticle({ modified: atLimit }, { now: NOW }), false);
  assert.equal(isStaleArticle({ modified: pastLimit }, { now: NOW }), true);
});

test('maxAgeDays is overridable without touching the constant', () => {
  assert.equal(isStaleArticle({ modified: '2026-03-05' }, { now: NOW, maxAgeDays: 100 }), true);
  assert.equal(isStaleArticle({ modified: '2026-03-05' }, { now: NOW, maxAgeDays: 400 }), false);
});
