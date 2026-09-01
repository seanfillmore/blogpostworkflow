// Nothing may read a post's meta.json directly — it is HALF the metadata now.
//
// This is the guard that was missing. PR #737 split machine state into a
// gitignored state.json and shimmed `getPostMeta` to return the two merged, which
// protected all 31 files that called it. What it did NOT protect were the ~38
// sites across 25 files that bypassed the accessor and parsed meta.json
// themselves. Those saw only the authored half the moment the data migrated, and
// three of them were live hazards within minutes:
//
//   lib/post-lock.js        stopped seeing `legacy_locked` — the winner lock
//                           silently OFF, which is the exact failure that module
//                           was written to end.
//   agents/publisher        stopped seeing `shopify_article_id` — it would take
//                           the CREATE branch and make a duplicate live article.
//   agents/blog-post-writer would have composed a state-free object, and
//                           replacePostMeta would have written an empty state.json
//                           over a post's entire machine history.
//
// A source scan rather than a behavioural test for the reason CLAUDE.md gives:
// importing `agents/<name>/index.js` RUNS the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Two files legitimately read the raw file, and each has a stated reason.
const ALLOWED_RAW = new Set([
  // The accessor itself — it is what does the merging.
  'lib/posts.js',
  // The migration must see the UNMERGED meta.json to tell "already split" from
  // "not yet split"; through the merged reader those two look identical.
  'scripts/split-post-meta.mjs',
  // The deploy reconcile compares the file git tracks against the file on the
  // box. That is a question about the FILE, not about the post's metadata, and
  // merging state into it would make a legitimate server-side deletion look like
  // a field git still holds.
  'scripts/reconcile-post-metas.mjs',
  // Reads BOTH files itself, with per-file error handling, because it has to
  // tell an ABSENT state.json (a post with only authored fields — legitimate)
  // from an UNREADABLE one (which must refuse a body rewrite).
  'lib/post-lock.js',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = ['agents', 'lib', 'scripts']
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

// A direct parse of a post's meta.json, in any of the three spellings the
// codebase used before the migration.
const DIRECT_READ = /JSON\.parse\(\s*readFileSync\(\s*(getMetaPath\(|metaPath\b|join\([^)]*POSTS_DIR[^)]*'meta\.json')/;

test('no file parses a post meta.json directly except the four that must', () => {
  const offenders = SOURCES
    .filter(({ rel }) => !ALLOWED_RAW.has(rel))
    .filter(({ text }) => DIRECT_READ.test(text))
    .map(({ rel }) => rel);

  assert.deepEqual(offenders, [],
    'these read only the AUTHORED half — use getPostMeta / requirePostMeta:\n  ' + offenders.join('\n  '));
});

test('no file writes a post meta.json directly', () => {
  // The write side of the same rule. Before the split there was no write
  // chokepoint at all: 20 files called writeFileSync on a meta path, which is
  // how blog-post-writer could destroy 23 fields per redraft.
  const DIRECT_WRITE = /writeFileSync\(\s*(getMetaPath\(|metaPath\s*,)/;
  const offenders = SOURCES
    .filter(({ rel }) => !ALLOWED_RAW.has(rel))
    .filter(({ text }) => DIRECT_WRITE.test(text))
    .map(({ rel }) => rel);

  assert.deepEqual(offenders, [],
    'these bypass the routing — use writePostMeta / replacePostMeta:\n  ' + offenders.join('\n  '));
});

test('the four exceptions each still exist, so the allowlist cannot rot', () => {
  // An allowlist entry for a file that has been deleted or renamed is a rule
  // nobody is enforcing any more.
  for (const rel of ALLOWED_RAW) {
    assert.ok(SOURCES.some((s) => s.rel === rel), `allowlisted file is gone: ${rel}`);
  }
});
