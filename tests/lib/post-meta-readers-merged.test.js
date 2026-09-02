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

// Find every raw touch of a post's meta.json in one file.
//
// ⚠️ THIS USED TO MATCH SPELLINGS AND A LOCAL VARIABLE NAME DEFEATED IT.
// The old rule looked for `readFileSync(getMetaPath(` or `readFileSync(metaPath`.
// agents/indexing-checker writes `const path = getMetaPath(slug)` and then
// `readFileSync(path)` / `writeFileSync(path)` — so the guard saw nothing while
// the agent stamped a SERVER-owned field into the git-TRACKED meta.json every
// morning on cron. Six files were bypassing it, not one; `postMetaPath` and
// `retroMetaPath` slipped past for the same reason (the regex anchored the name
// immediately after the paren).
//
// So follow the VALUE, not the name: any local assigned from getMetaPath() is a
// meta path, whatever it is called, and reading or writing it raw is the defect.
function rawMetaTouches(text) {
  const found = [];
  if (/readFileSync\(\s*getMetaPath\(/.test(text)) found.push('read via inline getMetaPath()');
  if (/writeFileSync\(\s*getMetaPath\(/.test(text)) found.push('write via inline getMetaPath()');
  if (/JSON\.parse\(\s*readFileSync\(\s*join\([^)]*POSTS_DIR[^)]*'meta\.json'/.test(text)) {
    found.push('read via a hand-built POSTS_DIR path');
  }
  for (const [, name] of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*getMetaPath\(/g)) {
    if (new RegExp(`readFileSync\\(\\s*${name}\\b`).test(text)) found.push(`read via \`${name}\``);
    if (new RegExp(`writeFileSync\\(\\s*${name}\\b`).test(text)) found.push(`write via \`${name}\``);
  }
  return [...new Set(found)];
}

test('no file touches a post meta.json raw except the four that must', () => {
  const offenders = SOURCES
    .filter(({ rel }) => !ALLOWED_RAW.has(rel))
    .map(({ rel, text }) => ({ rel, hits: rawMetaTouches(text) }))
    .filter(({ hits }) => hits.length)
    .map(({ rel, hits }) => `${rel} (${hits.join('; ')})`);

  assert.deepEqual(offenders, [],
    'meta.json is HALF the metadata. A raw READ sees only the authored fields; a raw\n'
    + 'WRITE puts machine state into the file git tracks, which is the deploy collision\n'
    + 'the split was built to end. Use getPostMeta / requirePostMeta / writePostMeta:\n  '
    + offenders.join('\n  '));
});

test('the guard cannot be defeated by renaming the variable', () => {
  // Pins the actual regression above: this is indexing-checker's exact shape.
  const shape = `
    const path = getMetaPath(slug);
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(meta, null, 2));
  `;
  assert.deepEqual(rawMetaTouches(shape), ['read via `path`', 'write via `path`']);

  // And the two names that slipped past because the old regex anchored them
  // immediately after the opening paren.
  assert.ok(rawMetaTouches("const postMetaPath = getMetaPath(s);\nreadFileSync(postMetaPath, 'utf8')").length);
  assert.ok(rawMetaTouches("const retroMetaPath = getMetaPath(s);\nreadFileSync(retroMetaPath, 'utf8')").length);

  // A file that only resolves the path (existsSync, logging) is NOT an offender —
  // the rule is about reading or writing the contents.
  assert.deepEqual(rawMetaTouches("const p = getMetaPath(s);\nif (existsSync(p)) console.log(p);"), []);
});

test('the four exceptions each still exist, so the allowlist cannot rot', () => {
  // An allowlist entry for a file that has been deleted or renamed is a rule
  // nobody is enforcing any more.
  for (const rel of ALLOWED_RAW) {
    assert.ok(SOURCES.some((s) => s.rel === rel), `allowlisted file is gone: ${rel}`);
  }
});
