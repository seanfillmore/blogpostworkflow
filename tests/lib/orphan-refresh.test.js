import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOrphan, rehomedName, ORPHAN_DIR } from '../../lib/orphan-refresh.js';

const base = {
  slug: 'aluminum-free-deodorant-what-it-is-how-to-choose',
  hasRefresh: true,
  target: 'aluminum-free-deodorant',
  targetIsLive: true,
  targetHasRefresh: false,
};

test('a resolvable orphan with a refresh is re-homed to the real post', () => {
  const d = decideOrphan(base);
  assert.equal(d.action, 'rehome');
  assert.match(d.reason, /aluminum-free-deodorant/);
});

test('the re-homed filename is NEVER content-refreshed.html', () => {
  // The whole safety argument. agents/refresh-runner moves content-refreshed.html
  // over content.html and PUBLISHES it once the editor gate passes. These
  // refreshes are one to four months old and were generated against bodies that
  // have since changed, so the consumed filename would queue stale content for
  // publication over a live ranking page.
  const name = rehomedName('2026-08-24T07:38:00.000Z');
  assert.equal(name, 'orphaned-refresh-2026-08-24.html');
  assert.notEqual(name, 'content-refreshed.html');
  assert.doesNotMatch(name, /^content-refreshed\.html$/);
});

test('an undated refresh still gets an inert name rather than the consumed one', () => {
  assert.equal(rehomedName(null), 'orphaned-refresh-undated.html');
  assert.equal(rehomedName(''), 'orphaned-refresh-undated.html');
});

test('a target that already has its own refresh is NOT written to', () => {
  // Its refresh is the newer, correctly-addressed one. Two files side by side
  // invites someone to compare and pick the older.
  const d = decideOrphan({ ...base, targetHasRefresh: true });
  assert.equal(d.action, 'archive');
  assert.match(d.reason, /already has its own pending refresh/);
});

test('an orphan that resolves to nothing is archived, never dropped', () => {
  const d = decideOrphan({ ...base, target: null });
  assert.equal(d.action, 'archive');
  assert.match(d.reason, /no live post resolves/);
});

test('an orphan that resolves to ITSELF is archived — there is no real post behind it', () => {
  const d = decideOrphan({ ...base, target: base.slug });
  assert.equal(d.action, 'archive');
  assert.match(d.reason, /resolves to itself/);
});

test('a target with no Shopify article is not a re-home destination', () => {
  const d = decideOrphan({ ...base, targetIsLive: false });
  assert.equal(d.action, 'archive');
  assert.match(d.reason, /no shopify_article_id/);
});

test('an empty shell is archived rather than left behind', () => {
  const d = decideOrphan({ ...base, hasRefresh: false });
  assert.equal(d.action, 'archive');
  assert.match(d.reason, /nothing to carry across/);
});

test('there is no delete verdict — every branch archives', () => {
  // The rule lib/brief-archive.js exists to enforce, after --drop-non-earning
  // permanently destroyed three paid-for briefs on 2026-08-19.
  const cases = [
    base,
    { ...base, hasRefresh: false },
    { ...base, target: null },
    { ...base, target: base.slug },
    { ...base, targetIsLive: false },
    { ...base, targetHasRefresh: true },
  ];
  for (const c of cases) {
    const d = decideOrphan(c);
    assert.ok(['rehome', 'archive'].includes(d.action), `unexpected action: ${d.action}`);
    assert.notEqual(d.action, 'delete');
  }
});

test('the archive directory is underscore-prefixed so listAllSlugs cannot see it', () => {
  // listAllSlugs requires a meta.json in the directory it scans and does not
  // recurse, so `_orphaned` is skipped — the same property that keeps
  // data/briefs/_dropped/ invisible to every reader of data/briefs/.
  assert.equal(ORPHAN_DIR, '_orphaned');
  assert.ok(ORPHAN_DIR.startsWith('_'));
});

// ── the runner cannot delete, and that is pinned rather than promised ─────────
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = () => readFileSync(join(ROOT, 'scripts/rehome-orphan-refreshes.mjs'), 'utf8');

/** Executable source only. The header names the forbidden calls on purpose, so
 *  a scan over raw text would fire on the documentation of the rule — the same
 *  trap `no cluster name is hardcoded` solves in tests/lib/cluster-hold.test.js. */
const runnerCode = () => runner()
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the runner never imports or calls a delete', () => {
  // The cheapest way for this script to become the thing it exists to prevent is
  // somebody reaching for a delete to tidy up. A source scan, because running the
  // script moves real files.
  const src = runnerCode();
  for (const fn of ['unlinkSync', 'rmSync', 'rmdirSync', 'rimraf']) {
    assert.doesNotMatch(src, new RegExp(`\\b${fn}\\b`), `no ${fn}`);
  }
});

test('every DESTINATION path comes from rehomedName, never the consumed filename', () => {
  // agents/refresh-runner moves content-refreshed.html over content.html and
  // publishes it. Reading the orphan's own content-refreshed.html is fine — that
  // is the source. What must never happen is a WRITE landing under that name.
  const src = runnerCode();
  assert.match(src, /const dest = join\(destDir, rehomedName\(/, 'the re-home destination is built from rehomedName()');
  assert.doesNotMatch(src, /const dest\w* = join\([^)]*\bREFRESH\b/, 'no destination built from the consumed name');
  assert.doesNotMatch(src, /copyFileSync\([^)]*,\s*join\([^)]*\bREFRESH\b/, 'nothing is copied TO the consumed name');
});

test('the runner is dry by default', () => {
  const src = runner();
  assert.match(src, /const APPLY = process\.argv\.includes\('--apply'\)/);
});
