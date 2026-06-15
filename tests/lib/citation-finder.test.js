import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimSearchQuery,
  isAuthoritativeSource,
  insertCitation,
} from '../../lib/citation-finder.js';

// ── claimSearchQuery ──────────────────────────────────────────────────────────
test('claimSearchQuery cleans a claim sentence into a searchable query', () => {
  const q = claimSearchQuery('  "Research shows SLS can degrade this layer, causing desquamation."  ');
  assert.ok(!q.includes('"'));
  assert.ok(q.length > 0 && q.length <= 200);
  assert.match(q, /SLS/);
});

// ── isAuthoritativeSource ─────────────────────────────────────────────────────
test('isAuthoritativeSource accepts .gov/.edu/PubMed/journals', () => {
  assert.equal(isAuthoritativeSource('https://pubmed.ncbi.nlm.nih.gov/9912345/'), true);
  assert.equal(isAuthoritativeSource('https://www.nih.gov/x'), true);
  assert.equal(isAuthoritativeSource('https://dental.harvard.edu/y'), true);
  assert.equal(isAuthoritativeSource('https://doi.org/10.1111/abc'), true);
  assert.equal(isAuthoritativeSource('https://www.nature.com/articles/abc'), true);
});

test('isAuthoritativeSource rejects blogs, competitors, and our own site', () => {
  assert.equal(isAuthoritativeSource('https://somedentalblog.com/post'), false);
  assert.equal(isAuthoritativeSource('https://www.realskincare.com/blogs/news/x'), false);
  assert.equal(isAuthoritativeSource('https://www.amazon.com/dp/x'), false);
  assert.equal(isAuthoritativeSource('not a url'), false);
});

// ── insertCitation ────────────────────────────────────────────────────────────
test('insertCitation adds an external link inside the block containing the claim', () => {
  const html = '<p>Intro paragraph.</p>\n<p>Research shows SLS can degrade this layer, causing desquamation in some people.</p>\n<p>Other.</p>';
  const { html: out, inserted } = insertCitation(html, 'Research shows SLS can degrade this layer, causing desquamation', 'https://pubmed.ncbi.nlm.nih.gov/123');
  assert.equal(inserted, true);
  // link landed in the SLS paragraph, not the others
  const slsBlock = out.match(/<p>Research shows[\s\S]*?<\/p>/)[0];
  assert.match(slsBlock, /href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/123"/);
  assert.match(slsBlock, /rel="[^"]*nofollow[^"]*"/);
  // other paragraphs untouched
  assert.ok(!/href=/.test(out.match(/<p>Other\.<\/p>/)[0]));
});

test('insertCitation reports not-inserted when the claim block is not found', () => {
  const { html: out, inserted } = insertCitation('<p>nothing relevant</p>', 'a claim that does not appear', 'https://nih.gov/x');
  assert.equal(inserted, false);
  assert.equal(out, '<p>nothing relevant</p>');
});

test('insertCitation does not double-cite a block that already has an external link', () => {
  const html = '<p>Research shows SLS degrades the layer <a href="https://nih.gov/a">source</a>.</p>';
  const { inserted } = insertCitation(html, 'Research shows SLS degrades the layer', 'https://pubmed.ncbi.nlm.nih.gov/2');
  assert.equal(inserted, false);
});
