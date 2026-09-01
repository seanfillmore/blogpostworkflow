// The daily drift gate for data/rejected-keywords.json.
//
// This file is the second of the two tracked files production writes on its own,
// and it was the one WITHOUT a timer. `data/posts/*/meta.json` has
// DAILY_POST_META_GATE and content mirrors have DAILY_CONTENT_MIRROR_GATE;
// rejections had only a reconcile script somebody had to remember to run — which
// is precisely how 37 entries came to exist nowhere but the production box for
// four months, un-noticed, until an audit went looking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRejectionDrift, GATE_ARGS } from '../../scripts/check-rejected-keywords-drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('in sync is routine', () => {
  const v = classifyRejectionDrift({ onlyInBase: [], onlyInHead: [], merged: [1, 2] });
  assert.equal(v.status, 'success');
  assert.equal(v.needsHuman, false);
});

test('the box being AHEAD is routine, not a failure', () => {
  // content-strategist appends a rejection from the 15:00 UTC cron and the
  // dashboard writes from two routes, so the box growing entries is the normal
  // state. A daily failure row for the normal state is how a digest stops being
  // read — the same reasoning that keeps the post-meta gate's exit 1 on
  // `success`.
  const v = classifyRejectionDrift({ onlyInBase: [], onlyInHead: [{ keyword: 'x' }], merged: [1] });
  assert.equal(v.status, 'success');
  assert.equal(v.needsHuman, false);
  assert.match(v.headline, /only on this box/i);
});

test('GIT holding an entry the box lacks NEEDS A HUMAN — that is the loss shape', () => {
  // Unlike meta.json there is no per-field merge at deploy time here; the file's
  // safety depends entirely on somebody running the reconcile. An entry in git
  // that the box does not have means either a deploy already reverted box
  // entries, or a commit has not reached the box. Both end with the strategist
  // re-proposing a keyword Sean already rejected — a full paid research +
  // writing pipeline each.
  const v = classifyRejectionDrift({ onlyInBase: [{ keyword: 'x' }], onlyInHead: [], merged: [1] });
  assert.equal(v.status, 'error');
  assert.equal(v.needsHuman, true);
});

test('BOTH sides moved is also error — a pull now has to merge', () => {
  const v = classifyRejectionDrift({
    onlyInBase: [{ keyword: 'a' }], onlyInHead: [{ keyword: 'b' }], merged: [1, 2],
  });
  assert.equal(v.status, 'error');
  assert.equal(v.needsHuman, true);
});

test('nothing this gate emits is ever immediate', () => {
  // These run unattended; the 5 AM digest IS the report. `status: 'error'` on
  // this fleet changes rendering only and has never escalated to an email.
  for (const d of [
    { onlyInBase: [], onlyInHead: [], merged: [] },
    { onlyInBase: [], onlyInHead: [{ keyword: 'x' }], merged: [1] },
    { onlyInBase: [{ keyword: 'x' }], onlyInHead: [], merged: [1] },
  ]) {
    assert.equal(classifyRejectionDrift(d).immediate, false);
  }
});

test('the headline always states the counts, never just "drift"', () => {
  const v = classifyRejectionDrift({
    onlyInBase: [{ keyword: 'a' }, { keyword: 'b' }], onlyInHead: [{ keyword: 'c' }], merged: [1, 2, 3],
  });
  assert.match(v.headline, /2/);
  assert.match(v.headline, /1/);
});

test('the gate can never write — its arguments are frozen and carry no --apply', () => {
  assert.ok(Object.isFrozen(GATE_ARGS));
  assert.ok(!GATE_ARGS.includes('--apply'));
  const src = readFileSync(join(ROOT, 'scripts', 'check-rejected-keywords-drift.mjs'), 'utf8');
  assert.doesNotMatch(src, /writeFileSync/, 'a detector must not write');
  assert.match(src, /REFUSED: --apply/, '--apply must be refused outright, not ignored');
});

test('the job is version-controlled, scheduled in UTC, and carries no write flag', () => {
  // Scoped to the job DEFINITION line, not the whole file: the surrounding
  // comments legitimately quote the retired `TZ=America/Los_Angeles` prefix while
  // explaining why it schedules nothing here. `post-meta-drift-gate.test.js`
  // already asserts the no-TZ rule across every job line on the host, so this
  // does not restate it.
  const cron = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');
  const line = cron.split('\n').find((l) => l.startsWith('DAILY_REJECTED_KEYWORDS_GATE='));
  assert.ok(line, 'the job must be in setup-cron.sh, not hand-added to the live crontab');
  assert.match(line, /check-rejected-keywords-drift\.mjs/);
  assert.match(line, /^DAILY_REJECTED_KEYWORDS_GATE="30 12 \* \* \* /, 'UTC fields are the only thing that schedules it');
  assert.doesNotMatch(line, /--apply/, 'the scheduled line must never carry a write flag');
  assert.doesNotMatch(line, /\bTZ=/, 'a TZ= prefix schedules nothing on this host');

  // Retiring a job means BOTH sides in the same change — so it must also be in
  // the heredoc that actually builds the crontab, not only defined above it.
  assert.match(cron, /^\$DAILY_REJECTED_KEYWORDS_GATE$/m, 'defined but never installed is a job that does not run');
});
