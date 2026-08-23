import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DROPPED_DIRNAME } from '../../lib/brief-archive.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// WHY THIS FILE EXISTS
//
// `data/briefs/_dropped/` holds briefs that scripts/triage-orphan-briefs.mjs
// took out of circulation. They must never be re-read as live briefs: a dropped
// brief that a reader still sees would be re-counted as coverage by
// gsc-opportunity, re-proposed against by content-researcher, or handed to
// blog-post-writer --all and written after we decided not to write it.
//
// What makes that safe today is ONE property, and it is implicit: every reader
// of data/briefs/ does a NON-RECURSIVE readdirSync and filters
// `.endsWith('.json')`, and `_dropped` is a directory with no `.json` suffix.
// Nothing enforces that — it is a convention six files happen to share. A
// seventh reader written without the filter, or an existing one switched to a
// recursive walk, would silently resurrect every dropped brief.
//
// So this test reads the actual source of every file that touches the briefs
// directory and pins the property. It is deliberately a source scan rather than
// a behavioural test: importing agents/*/index.js RUNS the agent (live writes,
// process.exit), so they cannot be exercised in-process.

/** Every .js/.mjs file in the repo, excluding dependencies and the archive itself. */
function sourceFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'data' || entry.name === 'assets' || entry.name === 'theme') continue;
      sourceFiles(full, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files that resolve the CONTENT briefs directory.
 *
 * `data/briefs/ad-studio/` is a different pipeline with its own store, and
 * `data/competitor-intelligence/briefs/` is a third — neither is affected by
 * this archive, so both are excluded rather than papered over.
 */
function contentBriefReaders() {
  const hits = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const declaresBriefsDir = /join\(\s*ROOT\s*,\s*'data'\s*,\s*'briefs'\s*\)/.test(src)
      || /BRIEFS_DIR\s*=\s*join\(/.test(src);
    const usesBriefsDir = /\bBRIEFS_DIR\b/.test(src) && !/\bCOMP_BRIEFS_DIR\b/.test(src.replace(/\bBRIEFS_DIR\b/g, ''));
    if (declaresBriefsDir || usesBriefsDir) hits.push({ file, src });
  }
  return hits;
}

// lib/brief-archive.js owns `_dropped/` and reads it deliberately; the tests
// below construct archives on purpose. Neither reads live briefs.
const NOT_LIVE_BRIEF_READERS = new Set([
  'lib/brief-archive.js',
  'tests/lib/brief-archive.test.js',
  'tests/lib/briefs-dir-readers.test.js',
]);

test('every readdir of the content briefs directory filters to .json', () => {
  const offenders = [];

  for (const { file, src } of contentBriefReaders()) {
    if (NOT_LIVE_BRIEF_READERS.has(relative(ROOT, file))) continue;
    // Match a readdir over an identifier that NAMES the briefs directory, and
    // look at what is chained onto it. `[\s\S]{0,160}` spans the newline these
    // calls are routinely wrapped across. A bare `dir` is deliberately not
    // matched — it is too generic to attribute; seo-reporter, the one reader
    // that uses it, gets its own test below.
    const re = /readdirSync\(\s*(?:BRIEFS_DIR|briefsDir)\b[^)]*\)([\s\S]{0,160})/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const tail = m[1];
      const filtersJson = /\.filter\([\s\S]{0,80}?\.json['"]\s*\)/.test(tail)
        || /endsWith\(\s*['"]\.json['"]\s*\)/.test(tail);
      if (!filtersJson) {
        offenders.push(`${relative(ROOT, file)} — readdirSync over the briefs dir is not filtered to .json`);
      }
    }

    if (/readdirSync\([^)]*BRIEFS_DIR[^)]*recursive\s*:\s*true/.test(src)) {
      offenders.push(`${relative(ROOT, file)} — recursive readdir would descend into ${DROPPED_DIRNAME}/`);
    }
  }

  assert.deepEqual(offenders, [],
    `A dropped brief must stay dropped. Either filter to '.json' (which hides ${DROPPED_DIRNAME}/, `
    + 'a directory), or skip it explicitly — see lib/brief-archive.js.');
});

test('the scan actually found the readers it is meant to guard', () => {
  // A regex guard that matches nothing passes forever. Pin the known readers so
  // a rename or a refactor that hides them fails here instead of silently.
  const files = contentBriefReaders().map((h) => relative(ROOT, h.file));
  for (const expected of [
    'agents/blog-post-writer/index.js',
    'agents/content-researcher/index.js',
    'agents/gsc-opportunity/index.js',
    'agents/unmapped-query-promoter/index.js',
    'scripts/triage-orphan-briefs.mjs',
  ]) {
    assert.ok(files.includes(expected), `${expected} should be recognised as a briefs-directory reader`);
  }
  assert.ok(files.length >= 5);
});

test('agents/seo-reporter filters its own inline briefs readdir to .json', () => {
  // It builds the path inline rather than via a BRIEFS_DIR constant, so the scan
  // above does not classify it. Checked directly instead of loosening the regex.
  const src = readFileSync(join(ROOT, 'agents', 'seo-reporter', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function loadBriefs()'));
  assert.ok(fn.includes("join(ROOT, 'data', 'briefs')"), 'still the same directory');
  assert.match(fn.slice(0, 600), /\.filter\(\(f\) => f\.endsWith\('\.json'\)\)/,
    `seo-reporter would otherwise try to JSON.parse ${DROPPED_DIRNAME}/`);
});

test('nothing but the archive itself writes into the dropped directory', () => {
  const allowed = new Set([
    'lib/brief-archive.js',
    'tests/lib/brief-archive.test.js',
    'tests/lib/briefs-dir-readers.test.js',
    'tests/scripts/triage-orphan-briefs-archive.test.js',
  ]);
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = relative(ROOT, file);
    if (allowed.has(rel)) continue;
    if (new RegExp(`['"\`]${DROPPED_DIRNAME}['"\`]`).test(readFileSync(file, 'utf8'))) {
      offenders.push(`${rel} — hardcodes '${DROPPED_DIRNAME}'; import it from lib/brief-archive.js instead`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the dropped directory is inside data/briefs, so the archive is found where the loss happened', () => {
  // Deliberately NOT a sibling like data/briefs-dropped/. Six weeks later the
  // person looking for a vanished brief opens data/briefs/ — the recovery path
  // has to be visible from there.
  const { droppedDir } = { droppedDir: (root) => join(root, 'data', 'briefs', DROPPED_DIRNAME) };
  assert.equal(
    relative(join(ROOT, 'data', 'briefs'), droppedDir(ROOT)),
    DROPPED_DIRNAME,
  );
  assert.ok(statSync(join(ROOT, 'data', 'briefs')).isDirectory());
});
