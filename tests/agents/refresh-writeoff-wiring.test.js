// The three agents in the refused-refresh loop must all read the ONE module.
//
// A source scan rather than a behavioural test, for the reason CLAUDE.md gives
// about every agent in this tree: importing `agents/<name>/index.js` runs the
// agent. These pin the wiring the loop's fix depends on — each one, left out,
// silently restores a different half of the bug.
//
// (Line comments, not a block: the glob for an agent path contains `*/`, which
// closes a block comment early and drops the rest of the file into the parser.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELD_OWNERS } from '../../lib/post-meta-reconcile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const refreshRunner = read('agents/refresh-runner/index.js');
const legacyRebuilder = read('agents/legacy-rebuilder/index.js');

test('refresh-runner restores the mirror on EVERY failure after the overwrite', () => {
  // The three exits between the copy at `writeFileSync(canonicalHtml, ...)` and
  // the end of the function are the whole surface. If a fourth is ever added and
  // returns `{ ok: false }` directly, it leaks the overwritten mirror again —
  // which is the permanent, unpublishable state this fix exists to end.
  const from = refreshRunner.indexOf('writeFileSync(canonicalHtml, readFileSync(refreshedHtml))');
  const to = refreshRunner.indexOf('return { slug, ok: true };');
  assert.ok(from > 0 && to > from, 'fixture assumption: the overwrite precedes the success return');

  const tail = refreshRunner.slice(from, to);
  const bareFailures = tail.match(/return \{ slug, ok: false[^}]*\};/g) || [];
  // The only bare `ok: false` allowed in this span is the one INSIDE abort()'s
  // own restore-failed branch, plus abort's own final return.
  assert.ok(bareFailures.length <= 2,
    `every failure exit after the mirror overwrite must go through abort(); found ${bareFailures.length} bare returns`);
  assert.ok(tail.includes('return abort('), 'the failure exits must call abort()');
});

test('refresh-runner skips a written-off post BEFORE the paid step', () => {
  const gate = refreshRunner.indexOf('isRefreshWrittenOff(');
  const paid = refreshRunner.indexOf('agents/content-refresher/index.js');
  assert.ok(gate > 0, 'refresh-runner must consult the write-off');
  assert.ok(gate < paid, 'the write-off check must land before content-refresher, which is what costs money');
});

test('refresh-runner is the chokepoint, so it never re-implements the rule', () => {
  assert.match(refreshRunner, /from '\.\.\/\.\.\/lib\/refresh-writeoff\.js'/);
  assert.ok(!/mirror_fingerprint\s*===/.test(refreshRunner),
    'the fingerprint comparison belongs in lib/refresh-writeoff.js, not inlined here');
});

test('legacy-rebuilder excludes written-off posts from its pick list', () => {
  assert.match(legacyRebuilder, /excludeWrittenOff\(/);
  assert.match(legacyRebuilder, /from '\.\.\/\.\.\/lib\/refresh-writeoff\.js'/);
});

test('legacy-rebuilder excludes them BEFORE the --limit cap', () => {
  // Same rule as the $0-cluster hold and the efficiency ranking: withholding
  // after the cap lets five withheld posts eat a budget of five.
  const exclude = legacyRebuilder.indexOf('excludeWrittenOff(');
  const cap = legacyRebuilder.indexOf('selectLegacyPosts(findLegacyPosts()');
  assert.ok(exclude > 0 && cap > 0);
  assert.ok(exclude < cap, 'excludeWrittenOff lives inside findLegacyPosts, which feeds selectLegacyPosts');
});

test('what legacy-rebuilder withheld reaches the console AND the digest', () => {
  // A hold nobody can see becomes a mystery outage six weeks later.
  assert.match(legacyRebuilder, /renderWrittenOffLines\(\)/);
  const notifyAt = legacyRebuilder.indexOf('await notify({');
  const body = legacyRebuilder.slice(notifyAt, notifyAt + 900);
  assert.match(body, /writtenOffLines/, 'the digest body must name the withheld posts, not just the console');
});

test('the write-off never escalates — it is the policy working', () => {
  // Scope to the run-summary notify only. The `status: 'error'` further down is
  // the top-level crash handler ("Legacy Rebuilder failed"), which is correct and
  // must stay — an over-wide slice swallowed it and made this test read as a
  // failure of the thing it is protecting.
  const notifyAt = legacyRebuilder.indexOf('await notify({');
  const call = legacyRebuilder.slice(notifyAt, legacyRebuilder.indexOf('});', notifyAt));
  assert.ok(call.includes('writtenOffLines'), 'fixture assumption: this is the run-summary notify');
  assert.ok(!/immediate:\s*true/.test(call), 'a write-off must not page anyone');
  // The status expression may only be driven by real failures, never by how many
  // posts were withheld — same rule the $0-cluster hold already follows.
  const status = call.match(/status: ([^,\n]+)/)?.[1] || '';
  assert.ok(!/writtenOff/i.test(status), 'a write-off is not an agent failure and must not move the status');
});

test('the new meta field is classified, or the next deploy exits 2 on it', () => {
  // FIELD_OWNERS is what the deploy reconcile consults. An unclassified field
  // both sides moved stops a deploy; worse, a repo-owned one would DELETE the
  // write-off on pull and re-enrol the post into the daily paid loop.
  assert.equal(FIELD_OWNERS.refresh_writeoff, 'server');
});
