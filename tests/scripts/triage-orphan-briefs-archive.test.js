import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'triage-orphan-briefs.mjs');
const src = readFileSync(SCRIPT, 'utf8');

// The script cannot be imported (it reads the live repo and calls process.exit)
// and must not be run for real against data/briefs/, so its wiring is asserted
// on the source. What it MUST NOT contain is the point.

/**
 * Source with comments removed.
 *
 * The header docstring explains that this script USED to call unlinkSync, and
 * the notify call is commented with why it is not `immediate: true`. Both are
 * exactly the strings the negative assertions below look for, so those have to
 * read code rather than prose.
 */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const codeOnly = code(src);

test('the script no longer deletes a brief', () => {
  assert.doesNotMatch(codeOnly, /\bunlinkSync\b/,
    'unlinkSync is what destroyed vegan-soap, oatmeal-soap and coconut-oil-soap-benefits on 2026-08-19');
  assert.doesNotMatch(codeOnly, /\brmSync\b/, 'nor any other destructive fs call');
});

test('the script archives through lib/brief-archive.js', () => {
  assert.match(src, /import\s*\{[^}]*archiveBriefs[^}]*\}\s*from\s*'\.\.\/lib\/brief-archive\.js'/s);
  assert.match(src, /archiveBriefs\(\{/);
});

test('the drop record carries the cluster verdict that condemned the brief', () => {
  // Not just the one-line reason: the classification object behind it, so a
  // restore decision can re-examine the evidence rather than trust the summary.
  assert.match(src, /cluster:\s*verdict\.cluster/);
  assert.match(src, /clusterStats:\s*verdict\.clusterStats/);
  assert.match(src, /report:\s*reportContext/, 'and which seo-impact report it came from');
});

test('the script emits a DEFERRED notify — the gap that hid the 2026-08-19 loss', () => {
  assert.match(src, /import\s*\{\s*notify\s*\}\s*from\s*'\.\.\/lib\/notify\.js'/,
    'this import did not exist, so the 5 AM digest could not have reported the drop even in principle');
  assert.match(src, /await notify\(\{/);
  assert.doesNotMatch(codeOnly, /immediate:\s*true/,
    'CLAUDE.md digest convention — a recoverable drop waits for the 5 AM digest');
});

test('notify fires when briefs are archived AND when archiving fails', () => {
  assert.match(src, /if\s*\(archived\.length\s*\|\|\s*failed\.length\)/,
    'a half-archived run must not be silent');
});

test('the orphan walk cannot see into the archive directory', () => {
  // Belt and braces: `_dropped` has no .json suffix AND is not a file. Either
  // check alone suffices; a re-read dropped brief would undo the archive.
  assert.match(src, /readdirSync\(BRIEFS_DIR,\s*\{\s*withFileTypes:\s*true\s*\}\)/);
  assert.match(src, /e\.isFile\(\)\s*&&\s*e\.name\.endsWith\('\.json'\)/);
});

test('a restore path exists and does not require hand-moving files', () => {
  assert.match(src, /--restore/);
  assert.match(src, /restoreDropped\(/);
  assert.match(src, /--list-dropped/);
  assert.match(src, /--force/, 'and an explicit way to overwrite a live brief');
});

test('PR #627s upstream staleness refusal is still intact and not duplicated', () => {
  // The two guards are complementary: #627 stops a bad verdict being acted on;
  // the archive makes acting on one reversible. On 2026-08-19 the report was
  // fresh and simply wrong, so #627 alone would not have helped.
  assert.match(src, /loadClusterHold\(/);
  assert.match(src, /if\s*\(!hold\.available\)/);
  assert.match(src, /staleNote\(hold\.freshness\)/);
  assert.equal((src.match(/process\.exit\(1\)/g) || []).length >= 1, true);
  assert.doesNotMatch(src, /SEO_IMPACT_MAX_AGE_DAYS\s*=/, 'no second copy of the freshness policy');
});

test('the dry run tells the operator drops are reversible', () => {
  assert.match(src, /Nothing is deleted/);
});

// ── the second deleter, found while fixing the first ─────────────────────────

test('lib/post-kill.js archives the brief instead of unlinking it', () => {
  // Not the path that caused the 2026-08-19 loss, but the only other code in
  // the repo that removed a file from data/briefs/ — and it is reachable from
  // the dashboard's public URL.
  const killSrc = readFileSync(join(ROOT, 'lib', 'post-kill.js'), 'utf8');
  assert.doesNotMatch(killSrc, /\bunlinkSync\b/);
  assert.match(killSrc, /archiveBriefs\(\{/);
  assert.match(killSrc, /droppedBy:\s*'lib\/post-kill\.js'/);
  assert.match(killSrc, /summary\.brief_deleted = true/,
    'the existing summary field stays, so dashboard and CLI callers are unchanged');
});
