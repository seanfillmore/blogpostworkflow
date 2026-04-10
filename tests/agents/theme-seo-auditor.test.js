// tests/agents/theme-seo-auditor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function auditHeadings(html) {
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  const headings = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => parseInt(m[1]));
  let hierarchyValid = true;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) { hierarchyValid = false; break; }
  }
  return { h1_count: h1s, heading_hierarchy_valid: hierarchyValid };
}

function auditMeta(html) {
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const ogTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
  const ogDesc = /<meta[^>]+property=["']og:description["']/i.test(html);
  const ogImage = /<meta[^>]+property=["']og:image["']/i.test(html);
  const ogUrl = /<meta[^>]+property=["']og:url["']/i.test(html);
  const twitterCard = /<meta[^>]+name=["']twitter:card["']/i.test(html);
  return {
    canonical_present: !!canonical,
    canonical_href: canonical ? canonical[1] : null,
    viewport_present: viewport,
    og_tags: { title: ogTitle, description: ogDesc, image: ogImage, url: ogUrl },
    twitter_tags: { card: twitterCard },
  };
}

function auditImages(html) {
  const imgs = [...html.matchAll(/<img[^>]*>/gi)];
  const withAlt = imgs.filter((m) => /alt=["'][^"']+["']/i.test(m[0]));
  return {
    image_count: imgs.length,
    images_with_alt: withAlt.length,
    alt_coverage: imgs.length > 0 ? withAlt.length / imgs.length : 1,
  };
}

test('auditHeadings: single H1, valid hierarchy', () => {
  const html = '<h1>Title</h1><h2>Sub</h2><h3>Detail</h3>';
  const result = auditHeadings(html);
  assert.equal(result.h1_count, 1);
  assert.equal(result.heading_hierarchy_valid, true);
});

test('auditHeadings: multiple H1s', () => {
  const html = '<h1>Title</h1><h1>Another</h1>';
  assert.equal(auditHeadings(html).h1_count, 2);
});

test('auditHeadings: skipped level = invalid', () => {
  const html = '<h1>Title</h1><h3>Skipped H2</h3>';
  assert.equal(auditHeadings(html).heading_hierarchy_valid, false);
});

test('auditMeta: finds canonical and OG tags', () => {
  const html = '<link rel="canonical" href="https://example.com/page"><meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="I"><meta property="og:url" content="U"><meta name="viewport" content="width=device-width"><meta name="twitter:card" content="summary">';
  const result = auditMeta(html);
  assert.equal(result.canonical_present, true);
  assert.equal(result.canonical_href, 'https://example.com/page');
  assert.equal(result.viewport_present, true);
  assert.equal(result.og_tags.title, true);
  assert.equal(result.twitter_tags.card, true);
});

test('auditMeta: missing tags', () => {
  const result = auditMeta('<html><head></head></html>');
  assert.equal(result.canonical_present, false);
  assert.equal(result.viewport_present, false);
  assert.equal(result.og_tags.title, false);
});

test('auditImages: counts images and alt coverage', () => {
  const html = '<img src="a.jpg" alt="Photo"><img src="b.jpg"><img src="c.jpg" alt="Another">';
  const result = auditImages(html);
  assert.equal(result.image_count, 3);
  assert.equal(result.images_with_alt, 2);
  assert.ok(Math.abs(result.alt_coverage - 0.667) < 0.01);
});
