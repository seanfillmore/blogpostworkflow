// tests/lib/schema-audit.test.js
//
// Pure logic for the structured-data coverage audit (lib/schema-audit.js). No I/O:
// the caller hands in already-fetched HTML (Shopify body_html, or a live rendered page)
// and gets back which schema.org types that HTML actually publishes.
//
// The measurement has to be honest about two things that trip up naive greps:
//   1. Real pages nest types inside @graph, arrays, and mainEntity — a top-level
//      "@type" read misses most of what Google actually sees.
//   2. A JSON-LD block that does not parse publishes NOTHING. It must be counted as
//      broken, not as coverage.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  extractJsonLdBlocks,
  collectSchemaTypes,
  auditHtml,
  summarizeCoverage,
  TRACKED_TYPES,
} from '../../lib/schema-audit.js';

// ── extractJsonLdBlocks ───────────────────────────────────────────────────────

test('extractJsonLdBlocks finds a single well-formed block', () => {
  const html = `<p>hi</p><script type="application/ld+json">{"@type":"Article"}</script>`;
  const { blocks, invalid } = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(invalid, 0);
  assert.equal(blocks[0]['@type'], 'Article');
});

test('extractJsonLdBlocks tolerates attribute order and whitespace in the script tag', () => {
  const html = `<script  data-x="1"   type='application/ld+json' >\n {"@type":"FAQPage"} \n</script>`;
  const { blocks } = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]['@type'], 'FAQPage');
});

test('extractJsonLdBlocks ignores non-JSON-LD script tags', () => {
  const html = `<script>var a = {"@type":"Article"};</script><script type="text/javascript">x</script>`;
  const { blocks, invalid } = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 0);
  assert.equal(invalid, 0);
});

test('extractJsonLdBlocks counts an unparseable block as invalid, not as coverage', () => {
  const html = `<script type="application/ld+json">{"@type":"Article",}</script>`;
  const { blocks, invalid } = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 0);
  assert.equal(invalid, 1);
});

test('extractJsonLdBlocks strips CDATA wrappers some themes emit', () => {
  const html = `<script type="application/ld+json">//<![CDATA[
{"@type":"Product"}
//]]></script>`;
  const { blocks } = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]['@type'], 'Product');
});

// ── collectSchemaTypes ────────────────────────────────────────────────────────

test('collectSchemaTypes flattens @graph nodes', () => {
  const blocks = [{
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'Organization' }, { '@type': 'BreadcrumbList' }],
  }];
  const types = collectSchemaTypes(blocks);
  assert.ok(types.has('Organization'));
  assert.ok(types.has('BreadcrumbList'));
});

test('collectSchemaTypes handles a top-level array of nodes', () => {
  const types = collectSchemaTypes([[{ '@type': 'Article' }, { '@type': 'WebSite' }]]);
  assert.ok(types.has('Article'));
  assert.ok(types.has('WebSite'));
});

test('collectSchemaTypes handles a multi-valued @type', () => {
  const types = collectSchemaTypes([{ '@type': ['Product', 'IndividualProduct'] }]);
  assert.ok(types.has('Product'));
  assert.ok(types.has('IndividualProduct'));
});

test('collectSchemaTypes descends into nested properties (AggregateRating inside Product)', () => {
  const types = collectSchemaTypes([{
    '@type': 'Product',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: 12 },
  }]);
  assert.ok(types.has('Product'));
  assert.ok(types.has('AggregateRating'));
});

test('collectSchemaTypes descends into arrays of nested nodes (FAQ Question entities)', () => {
  const types = collectSchemaTypes([{
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', acceptedAnswer: { '@type': 'Answer' } },
      { '@type': 'Question', acceptedAnswer: { '@type': 'Answer' } },
    ],
  }]);
  assert.ok(types.has('FAQPage'));
  assert.ok(types.has('Question'));
  assert.ok(types.has('Answer'));
});

test('collectSchemaTypes returns an empty set for no blocks', () => {
  assert.equal(collectSchemaTypes([]).size, 0);
});

// ── auditHtml ─────────────────────────────────────────────────────────────────

test('auditHtml reports the tracked types present and absent', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Article","headline":"x"}
  </script>`;
  const r = auditHtml(html);
  assert.equal(r.has.Article, true);
  assert.equal(r.has.FAQPage, false);
  assert.equal(r.has.BreadcrumbList, false);
  assert.equal(r.blockCount, 1);
  assert.equal(r.invalidBlocks, 0);
  assert.equal(r.bare, false);
});

test('auditHtml flags a page with no JSON-LD at all as bare', () => {
  const r = auditHtml('<h1>hello</h1><p>no schema here</p>');
  assert.equal(r.bare, true);
  assert.equal(r.blockCount, 0);
  assert.deepEqual(r.allTypes, []);
});

test('auditHtml does not count a broken block as coverage but still marks it not-bare', () => {
  const r = auditHtml('<script type="application/ld+json">{oops</script>');
  assert.equal(r.invalidBlocks, 1);
  assert.equal(r.blockCount, 0);
  assert.equal(r.has.Article, false);
  assert.equal(r.bare, true, 'a block that cannot parse publishes nothing');
});

test('auditHtml counts FAQ question pairs so a thin FAQPage is visible', () => {
  const html = `<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[
    {"@type":"Question","name":"a","acceptedAnswer":{"@type":"Answer","text":"1"}},
    {"@type":"Question","name":"b","acceptedAnswer":{"@type":"Answer","text":"2"}},
    {"@type":"Question","name":"c","acceptedAnswer":{"@type":"Answer","text":"3"}}]}</script>`;
  const r = auditHtml(html);
  assert.equal(r.has.FAQPage, true);
  assert.equal(r.faqQuestionCount, 3);
});

test('auditHtml handles null/undefined html without throwing', () => {
  const r = auditHtml(null);
  assert.equal(r.bare, true);
  assert.equal(r.blockCount, 0);
});

test('TRACKED_TYPES covers exactly the types this audit reports on', () => {
  assert.deepEqual(
    [...TRACKED_TYPES].sort(),
    ['AggregateRating', 'Article', 'BreadcrumbList', 'FAQPage', 'HowTo', 'Product', 'Review'].sort()
  );
});

// ── summarizeCoverage ─────────────────────────────────────────────────────────

test('summarizeCoverage counts each tracked type across records', () => {
  const records = [
    { has: { Article: true, FAQPage: true, BreadcrumbList: false, Product: false, AggregateRating: false, Review: false, HowTo: false }, bare: false },
    { has: { Article: true, FAQPage: false, BreadcrumbList: true, Product: false, AggregateRating: false, Review: false, HowTo: false }, bare: false },
    { has: { Article: false, FAQPage: false, BreadcrumbList: false, Product: false, AggregateRating: false, Review: false, HowTo: false }, bare: true },
  ];
  const s = summarizeCoverage(records);
  assert.equal(s.total, 3);
  assert.equal(s.byType.Article, 2);
  assert.equal(s.byType.FAQPage, 1);
  assert.equal(s.byType.BreadcrumbList, 1);
  assert.equal(s.byType.Product, 0);
  assert.equal(s.bare, 1);
});

test('summarizeCoverage on an empty set reports zeros, not NaN', () => {
  const s = summarizeCoverage([]);
  assert.equal(s.total, 0);
  assert.equal(s.bare, 0);
  for (const t of TRACKED_TYPES) assert.equal(s.byType[t], 0);
});
