import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairCommandsFor } from '../../lib/edit-gate-repair.js';

const labels = (slug, reason) => repairCommandsFor(slug, reason).map((r) => r.label);

test('routes a 404/broken-link CTA blocker to link-repair', () => {
  const reason = 'CTA Quality The primary CTA link (/products/x) is flagged as 404 broken in the link health pre-check.';
  assert.ok(labels('s', reason).includes('link-repair'));
});

test('routes an uncited-claims blocker to citation-finder', () => {
  const reason = 'Factual Concerns 2 statistical/health claims lack a credible outbound citation.';
  assert.ok(labels('s', reason).includes('citation-finder'));
});

test('a vague Overall-Quality summary falls back to content-remediator (the old dead-end)', () => {
  // This is exactly why attemptRepair must route on concrete sections, not this.
  const vague = 'The post contains two blockers that must be resolved before publication.';
  assert.deepEqual(labels('s', vague), ['content-remediator']);
});

test('routing is keyword-driven so combined section+note strings hit the right agents', () => {
  assert.ok(labels('s', 'CTA Quality ... 404 broken ...').includes('link-repair'));
  assert.ok(labels('s', 'Factual Concerns ... uncited ...').includes('citation-finder'));
  assert.ok(labels('s', 'Internal Links ... orphan ...').includes('internal-linker'));
});

// ── the doomed repair loop ────────────────────────────────────────────────────
// Every repair agent, and the editor re-check itself, reads
// data/posts/<slug>/content.html. When that file does not exist not one of them
// can succeed, so the loop spends maxAttempts × (repairs + 1) subprocesses to
// arrive at the verdict it started with. On 2026-08-26..28 queue-autoapply did
// exactly that against an orphaned post directory and put six identical ENOENT
// rows into the daily digest, three days running.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEditGateWithRepair } from '../../lib/edit-gate-repair.js';
import { POSTS_DIR } from '../../lib/posts.js';

/** Create a post dir under the real POSTS_DIR with the given files, and clean up. */
function withPost(files, fn) {
  const slug = `zz-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(POSTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(slug);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAILING_REPORT = [
  '## Factual Concerns',
  '**VERDICT:** Needs Work',
  '**NOTES:** Two statistical claims lack a credible outbound citation.',
  '',
].join('\n');

test('a failing gate with no local content.html skips the loop instead of burning attempts', () => {
  withPost({ 'editor-report.md': FAILING_REPORT }, (slug) => {
    const calls = [];
    const { gate, attempts } = runEditGateWithRepair(slug, {
      run: (cmd, label) => { calls.push(label); return true; },
      log: () => {},
    });
    assert.equal(attempts, 0, 'must not attempt a repair it cannot perform');
    assert.equal(calls.length, 0, 'must not spawn a single repair agent or editor re-check');
    assert.equal(gate.pass, false, 'and it must NOT report a pass — there is no body to publish');
    assert.match(gate.reason, /content\.html/, 'the reason must name the actual problem');
  });
});

test('a failing gate WITH content.html still runs the repair loop', () => {
  withPost({ 'editor-report.md': FAILING_REPORT, 'content.html': '<p>body</p>' }, (slug) => {
    const calls = [];
    const { attempts } = runEditGateWithRepair(slug, {
      maxAttempts: 2,
      run: (cmd, label) => { calls.push(label); return true; },
      log: () => {},
    });
    assert.equal(attempts, 2, 'the guard must not disarm the normal repair path');
    assert.ok(calls.length > 0, 'repair agents still run when there is a body to repair');
  });
});

test('a post with no editor report and no content.html is untouched (page/product items)', () => {
  // queue-autoapply calls this for page- and product-meta items too, which have
  // no post body by design. Those pass today and must keep passing.
  withPost({}, (slug) => {
    const { gate, attempts } = runEditGateWithRepair(slug, { run: () => true, log: () => {} });
    assert.equal(gate.pass, true);
    assert.equal(attempts, 0);
  });
});
