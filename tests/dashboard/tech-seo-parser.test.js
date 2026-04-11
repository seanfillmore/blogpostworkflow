// tests/dashboard/tech-seo-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTechSeoReport } from '../../agents/dashboard/lib/tech-seo-parser.js';

test('parseTechSeoReport extracts date', () => {
  const md = '# Audit\n**Generated:** April 9, 2026\n### 🔴 404 Pages (3)\n| URL |\n|---|\n| /old |';
  const result = parseTechSeoReport(md);
  assert.equal(result.generated_at, 'April 9, 2026');
});

test('parseTechSeoReport counts errors and warnings', () => {
  const md = '### 🔴 404 Pages (5)\n| URL |\n|---|\n| /a |\n### 🟡 Missing Meta (8)\n| URL |\n|---|\n| /b |';
  const result = parseTechSeoReport(md);
  assert.equal(result.summary.errors, 5);
  assert.equal(result.summary.warnings, 8);
});

test('parseTechSeoReport extracts categories with items', () => {
  const md = '### 🔴 Broken Links (2)\n| Source | Target | Status |\n|---|---|---|\n| /post-a | /dead | 404 |\n| /post-b | /gone | 404 |';
  const result = parseTechSeoReport(md);
  assert.equal(result.categories.broken_links.count, 2);
  assert.equal(result.categories.broken_links.severity, 'error');
  assert.equal(result.categories.broken_links.items.length, 2);
  assert.equal(result.categories.broken_links.items[0].url, '/post-a');
});

test('parseTechSeoReport returns null for empty input', () => {
  assert.equal(parseTechSeoReport(null), null);
  assert.equal(parseTechSeoReport(''), null);
});
