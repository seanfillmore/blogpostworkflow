// tests/agents/blog-post-writer-meta-preserve.test.js
//
// A SOURCE SCAN, not a behavioural test: importing agents/blog-post-writer
// pulls in lib/anthropic.js and the site config at module scope, and the
// function that writes meta.json is not exported. The property being pinned is
// structural anyway — "the object written to meta.json is built by spreading
// the previous one" — and that is visible in the source.
//
// What it protects: agents/blog-post-writer rebuilt meta.json from scratch on
// every redraft and copied 11 named keys across from the old file. Twenty-odd
// fields were destroyed each time. The fix inverts it — preserve by default,
// overwrite only what the agent authors — and the authored list lives in
// lib/post-meta-reconcile.js next to the deploy ownership table it must agree
// with. A future edit that reintroduces a keep-list, or that stops merging,
// fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents', 'blog-post-writer', 'index.js'), 'utf8');

test('the writer derives its owned-field set from the ownership table, not a local list', () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*composeAuthoredMeta[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/post-meta-reconcile\.js'/,
    'blog-post-writer must import composeAuthoredMeta from lib/post-meta-reconcile.js',
  );
});

test('meta.json is composed by MERGING onto the previous file', () => {
  assert.match(
    SRC,
    /composeAuthoredMeta\(\s*existingMeta\b/,
    'the previous meta.json must be the base of the merge, not a source to copy keys out of',
  );
});

test('the 11-key preservation allowlist is gone', () => {
  // The exact shape of the bug: a `for (const key of [...])` copy loop over
  // named Shopify/legacy fields, feeding a spread of "shopifyFields".
  assert.doesNotMatch(SRC, /shopifyFields/, 'the shopifyFields allowlist must not come back');
  assert.doesNotMatch(
    SRC,
    /for\s*\(\s*const\s+key\s+of\s*\[\s*'shopify_blog_id'/,
    'the named-key copy loop must not come back',
  );
});

test('no bare `const meta = {` object literal is written straight to metaPath', () => {
  // Pins the inversion at the write site: whatever is serialized to meta.json
  // has to be the composed object.
  const write = SRC.match(/writeFileSync\(metaPath,[^)]*\)/);
  assert.ok(write, 'expected a writeFileSync(metaPath, ...) call');
  assert.match(write[0], /JSON\.stringify\(meta\b/);

  const assignment = SRC.match(/const\s+meta\s*=\s*([\s\S]{0,40})/);
  assert.ok(assignment, 'expected a `const meta =` assignment');
  assert.match(
    assignment[1],
    /composeAuthoredMeta/,
    '`meta` must be the composed object, not a fresh literal',
  );
});

test('an unreadable previous meta.json is reported, never silently swallowed', () => {
  // With preserve-by-default, an unparseable existing file (conflict markers
  // from a bad deploy is the realistic case) means nothing is preserved. The
  // old `catch {}` made that invisible.
  assert.doesNotMatch(
    SRC,
    /existingMeta\s*=\s*JSON\.parse\(readFileSync\(metaPath,\s*'utf8'\)\);\s*\}\s*catch\s*\{\s*\}/,
    'a bare `catch {}` around the existing-meta read hides the one case where the merge preserves nothing',
  );
});
