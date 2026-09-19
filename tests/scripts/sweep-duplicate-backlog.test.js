import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The script itself is I/O glue over two tested libraries, and it cannot be
// imported without running (it is a top-level-await .mjs with no direct-run
// guard by design — it IS the entry point). So its own invariants are pinned by
// a source scan plus the argument paths, which write nothing.

const SCRIPT = fileURLToPath(new URL('../../scripts/sweep-duplicate-backlog.mjs', import.meta.url));
const SRC = readFileSync(SCRIPT, 'utf8');
// Whole-line comments removed. The file explains its own rules in prose, and a
// scan for `immediate: true` that fires on the sentence saying it never does
// that is a scan measuring nothing.
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ── argument handling: these paths touch no file ────────────────────────────

test('an unrecognised flag is a usage error, not a silent full-corpus run', () => {
  const r = run(['--drop-everything']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Unrecognised flag/);
});

test('--limit refuses a value that is not a whole number', () => {
  for (const bad of ['banana', '-3', '2.5']) {
    const r = run(['--limit', bad]);
    assert.equal(r.code, 64, `--limit ${bad} must be refused`);
  }
});

test('--restore with neither a slug nor --all is a usage error', () => {
  const r = run(['--restore']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--restore needs one or more slugs/);
});

test('a bare slug without --restore is refused rather than guessed at', () => {
  const r = run(['best-sls-free-toothpaste']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /only meaningful with --restore/);
});

// ── the refusals that make a run readable ───────────────────────────────────

test('a disarmed or unavailable ranked index REFUSES the run, exit 65', () => {
  // A sweep that silently drops nothing is indistinguishable from a clean
  // corpus, and every drop it makes is evidence out of this index.
  assert.match(SRC, /rankedIndex\.disarmed \|\| rankedIndex\.available !== true/);
  assert.match(SRC, /REFUSING TO RUN/);
  assert.match(SRC, /process\.exit\(65\)/);
});

test('the semantic index only degrades — it may not refuse the run', () => {
  // Tier 3 produces FLAGS, which are reported and kept, so its absence costs
  // visibility rather than correctness.
  const block = SRC.slice(SRC.indexOf('authoredIndex.disarmed'), SRC.indexOf('const classify'));
  assert.ok(!/process\.exit/.test(block), 'a disarmed authored index must not exit');
  assert.match(block, /UNDER-reported/);
});

// ── what the script may and may not do ──────────────────────────────────────

test('it never deletes: no unlink, no rm, and the only calendar write is the guarded one', () => {
  assert.ok(!/unlink|rmSync|rmdirSync/.test(CODE));
  assert.ok(!/writeFileSync\(\s*calendarPath/.test(SRC));
  assert.equal((SRC.match(/writeCalendarItems\(/g) || []).length, 1);
});

test('it backs the calendar up BEFORE the write, and refuses to write without one', () => {
  const backupAt = SRC.indexOf('backupCalendar(');
  const writeAt = SRC.indexOf('writeCalendarItems(');
  assert.ok(backupAt > 0 && backupAt < writeAt, 'the backup must be taken before the write');
  assert.match(SRC, /Refusing to write without a backup/);
});

test('it archives BEFORE it writes the calendar', () => {
  // A calendar write that lands before the record exists can lose an item with
  // nothing anywhere saying so.
  assert.ok(SRC.indexOf('archiveItems(') < SRC.indexOf('writeCalendarItems('));
});

test('nothing is written without --apply', () => {
  const dryExit = SRC.indexOf('if (!APPLY)');
  assert.ok(dryExit > 0);
  for (const writer of ['backupCalendar(', 'archiveItems(', 'writeCalendarItems(']) {
    assert.ok(SRC.indexOf(writer) > dryExit, `${writer} must come after the dry-run exit`);
  }
});

test('the status is re-derived through pipeline-prioritizer, never read off the item', () => {
  assert.match(SRC, /import \{ statusOf \} from '\.\.\/agents\/pipeline-prioritizer\/index\.js'/);
  assert.ok(!/item\.status\b/.test(CODE), 'the raw `status` field means nothing on this calendar');
});

test('the coverage rule is imported, never re-implemented', () => {
  assert.match(SRC, /classifyRankedCoverage/);
  assert.ok(!/POSSIBLE_DUPLICATE|AUTO_COVERED/.test(CODE), 'verdict handling belongs in lib/calendar-backlog-sweep.js');
});

test('its notification is deferred and is never an error for an ordinary sweep', () => {
  assert.ok(!/immediate:\s*true/.test(CODE));
  // The severity decision lives in renderSweepDigest, which is tested to be
  // `success` unless an archive failed — the script must not override it.
  assert.ok(!/status:\s*'error'/.test(CODE));
});
