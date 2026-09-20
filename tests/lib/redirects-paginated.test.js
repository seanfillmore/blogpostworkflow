import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Source-scanned: lib/shopify.js throws at import without OAuth credentials and
// the agents below RUN when imported, so the property is asserted structurally —
// the same approach tests/agents/*-gated.test.js takes.

// Every caller that wants the WHOLE redirect table. A filtered lookup
// (`getRedirects({ path })`) is deliberately NOT here: it asks about one path,
// and one page is always enough.
const WHOLE_TABLE_CALLERS = [
  'scripts/fix-redirect-links.mjs',
  'agents/collection-content-optimizer/index.js',
  'agents/publish-drift/index.js',
  'agents/cannibalization-resolver/index.js',
  'agents/technical-seo/index.js',
  'scripts/redirect-legacy-page-handles.mjs',
];

test('getAllRedirects pages until a short page', () => {
  const src = read('lib/shopify.js');
  assert.ok(/export async function getAllRedirects\(/.test(src), 'the helper must exist');
  const body = src.slice(src.indexOf('export async function getAllRedirects('));
  // The loop terminates on a SHORT page and advances by since_id. Both halves
  // matter: without since_id it re-reads page one forever.
  assert.ok(/since_id: sinceId/.test(body), 'must advance with since_id');
  assert.ok(/rows\.length < 250/.test(body), 'must stop on a short page');
});

test('no whole-table caller reads a single unpaginated page', () => {
  // THE BUG (2026-09-20): Shopify caps /redirects.json at 250 rows. The table
  // reached 282 and `getRedirects()` silently returned 250 of them — a
  // plausible-looking array, no error, no flag. A capped page and a short page
  // are the same shape, so nothing downstream could tell them apart.
  //
  // It was found because a freshly created redirect was rewritten ZERO times
  // across three consecutive `fix-redirect-links.mjs --apply` runs: the new
  // redirect sat on page two, where nothing could see it.
  for (const file of WHOLE_TABLE_CALLERS) {
    const src = read(file);
    assert.ok(
      !/await getRedirects\(\s*\)/.test(src),
      `${file} reads only the FIRST page of redirects — use getAllRedirects()`,
    );
    assert.ok(
      /getAllRedirects/.test(src),
      `${file} must import and use getAllRedirects`,
    );
  }
});

test('a filtered single-path lookup stays on getRedirects', () => {
  // Widening these to getAllRedirects would page the entire table to answer a
  // question about one path — slower, and it would obscure that the filtered
  // call is correct as it stands.
  const src = read('agents/llms-txt-generator/index.js');
  assert.ok(
    /getRedirects\(\{ path: '\/llms\.txt' \}\)/.test(src),
    'the llms.txt lookup is path-filtered and must stay that way',
  );
});
