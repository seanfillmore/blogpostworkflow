// tests/agents/winner-lock-readers.test.js
//
// Source-level regression guard for the defect that started this: every agent
// hand-rolled its own winner-lock read, and meta-optimizer's copy pointed at a
// FLAT data/posts/<handle>.json that has never existed in this layout. The
// readFileSync threw on every single post, the bare `catch { /* proceed */ }`
// swallowed it, and the guard was inert for its entire life while looking fine.
//
// Two things stop that recurring:
//   1. Nobody builds a flat data/posts/<x>.json path.
//   2. Nobody reads `legacy_locked` by hand — it goes through lib/post-lock.js,
//      which is where the semantics and the failure mode are decided once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function jsFilesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsFilesUnder(full, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const SOURCE_FILES = [
  ...jsFilesUnder(join(ROOT, 'agents')),
  ...jsFilesUnder(join(ROOT, 'lib')),
];

// join(..., 'data', 'posts', `${x}.json`) — the flat layout, gone since the
// per-directory move. Any such path silently resolves to a file that is never
// there, which is exactly how a guard becomes inert without failing.
const FLAT_POST_PATH = /['"]posts['"]\s*,\s*`\$\{[^}]+\}\.json`/;

test('no agent or lib builds a flat data/posts/<slug>.json path', () => {
  const offenders = SOURCE_FILES
    .filter((f) => FLAT_POST_PATH.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, [], `flat post-JSON path (layout is data/posts/<slug>/meta.json): ${offenders.join(', ')}`);
});

test('legacy_locked is read only through lib/post-lock.js', () => {
  const ALLOWED = new Set([
    'lib/post-lock.js',            // the single reader
    'agents/legacy-triage/index.js', // the writer that stamps the flag
  ]);
  // Comments are how the reasoning stays next to the code — only real code
  // lines count as a hand-rolled read.
  const codeMentionsFlag = (src) => src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .some((l) => /legacy_locked/.test(l));

  const offenders = SOURCE_FILES
    .filter((f) => codeMentionsFlag(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
    .filter((f) => !ALLOWED.has(f));
  assert.deepEqual(offenders, [], `hand-rolled legacy_locked read — use lib/post-lock.js: ${offenders.join(', ')}`);
});

test('the body-rewriting agents still consult the winner lock', () => {
  for (const agent of [
    'agents/content-refresher/index.js',
    'agents/refresh-runner/index.js',
    'agents/legacy-rebuilder/index.js',
  ]) {
    const src = readFileSync(join(ROOT, agent), 'utf8');
    assert.match(src, /mayRewriteBody/, `${agent} must gate body rewrites on mayRewriteBody()`);
  }
});

test('meta-optimizer gates on mayTestMetadata, not on the body guard', () => {
  const src = readFileSync(join(ROOT, 'agents', 'meta-optimizer', 'index.js'), 'utf8');
  assert.match(src, /mayTestMetadata/);
  assert.doesNotMatch(src, /mayRewriteBody/, 'a title/meta test does not touch the body');
});
