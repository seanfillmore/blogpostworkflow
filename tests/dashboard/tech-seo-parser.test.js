// tests/dashboard/tech-seo-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTechSeoReport } from '../../agents/dashboard/lib/tech-seo-parser.js';

test('parseTechSeoReport extracts date', () => {
  const md = '# Audit\n**Generated:** April 9, 2026\n## 🔴 Errors\n### 1. Broken Pages (404) — 3 pages\n- https://example.com/old';
  const result = parseTechSeoReport(md);
  assert.equal(result.generated_at, 'April 9, 2026');
});

test('parseTechSeoReport counts errors and warnings', () => {
  const md = '## 🔴 Errors\n### 1. Broken Pages (404) — 5 pages\n- https://a.com/x\n## 🟡 Warnings\n### 2. Missing Meta — 8 pages\n- https://a.com/y';
  const result = parseTechSeoReport(md);
  assert.equal(result.summary.errors, 5);
  assert.equal(result.summary.warnings, 8);
});

test('parseTechSeoReport extracts categories with table items', () => {
  const md = '## 🔴 Errors\n### 1. Broken Pages (404) — 2 pages\n| PR | URL | Inlinks |\n|----|-----|--------|\n| 9 | https://example.com/a | 373 |\n| 0 | https://example.com/b | 7 |';
  const result = parseTechSeoReport(md);
  assert.equal(result.categories.broken_pages_404.count, 2);
  assert.equal(result.categories.broken_pages_404.severity, 'error');
  assert.equal(result.categories.broken_pages_404.items.length, 2);
  assert.ok(result.categories.broken_pages_404.items[0].url.includes('example.com/a'));
});

test('parseTechSeoReport extracts list items', () => {
  const md = '## 🔴 Errors\n### 1. Pages Linking to 404s — 3 pages\n- https://example.com/post-a → 404\n- https://example.com/post-b → 404\n- https://example.com/post-c → 404';
  const result = parseTechSeoReport(md);
  assert.equal(result.categories.pages_linking_to_404s.count, 3);
  assert.equal(result.categories.pages_linking_to_404s.items.length, 3);
  assert.equal(result.categories.pages_linking_to_404s.items[0].url, 'https://example.com/post-a');
});

test('parseTechSeoReport returns null for empty input', () => {
  assert.equal(parseTechSeoReport(null), null);
  assert.equal(parseTechSeoReport(''), null);
});
