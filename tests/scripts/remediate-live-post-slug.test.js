// tests/scripts/remediate-live-post-slug.test.js
//
// scripts/remediate-live-post.js calls ensurePostDir(slug) and therefore
// MANUFACTURES whatever directory string it is handed. Handed a Shopify article
// HANDLE — which is what every live URL carries, and which is not the local slug
// for most of this corpus — it creates data/posts/<handle>/ beside the real post
// directory. That orphan carries a meta.json, so listAllSlugs() counts it as a
// post and resolvePostSlug() matches it FIRST at step 1 (exact dir), shadowing
// the genuine one.
//
// Measured: `best-unscented-lotion-clean-fragrance-free-picks` is the handle of a
// live article (id 563553173674, HTTP 200) whose local slug is
// `best-unscented-lotion`. The orphan was archived 2026-08-31 and had regenerated
// by 2026-09-06, where it shadowed the live post and put a false "Action Required
// — 1 post hard-blocked" row in the digest every morning. CLAUDE.md records the
// identical shape for best-soap-for-tattoos.
//
// A source scan, because the script executes its whole remediation at module
// scope — importing it would run it against live Shopify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/posts.js';

const SRC = readFileSync(join(ROOT, 'scripts', 'remediate-live-post.js'), 'utf8');

test('the argument is RESOLVED, never trusted as a local slug', () => {
  assert.match(SRC, /import \{[^}]*resolvePostSlug[^}]*\} from '\.\.\/lib\/posts\.js'/,
    'resolvePostSlug must be imported from the accessor');
  assert.match(SRC, /resolvePostSlug\(slugArg\)/,
    'the raw argv value must be passed through resolvePostSlug');
  assert.doesNotMatch(SRC, /^const slug = process\.argv\[2\];$/m,
    'taking argv[2] as the slug verbatim is the defect — ensurePostDir then creates it');
});

test('it FALLS BACK to the raw argument, so a genuinely new slug still works', () => {
  // The `||` is what keeps this change one-directional: it can only ever redirect
  // a write that would have landed in the wrong directory, never block one that
  // was already correct.
  assert.match(SRC, /resolvePostSlug\(slugArg\)\s*\|\|\s*slugArg/);
});

test('ensurePostDir still receives the RESOLVED slug, not the raw argument', () => {
  // The whole point: the directory-creating call must be downstream of the
  // resolution, or the orphan is created anyway.
  assert.match(SRC, /ensurePostDir\(slug\)/);
  assert.doesNotMatch(SRC, /ensurePostDir\(slugArg\)/);
  // Compare against the CALL, not the header comment — which quotes
  // `ensurePostDir(slug)` verbatim while explaining the defect and therefore
  // sits before the assignment. Strip line comments first; matching your own
  // documentation is the same trap the digest-severity guard hit.
  const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(code.indexOf('const slug =') < code.indexOf('ensurePostDir(slug)'),
    'resolution must happen before the directory is created');
});

test('a redirect is announced rather than silent', () => {
  // If this script quietly operates on a different directory than the caller
  // named, the next person debugging it has no thread to pull.
  assert.match(SRC, /slug !== slugArg/);
});
