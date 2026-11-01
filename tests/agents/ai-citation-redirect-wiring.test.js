// A SOURCE SCAN, not a behavioural test: importing `agents/ai-citation-tracker`
// RUNS it — 575 paid LLM calls against live APIs. Same reason as
// tests/agents/link-injectors-guarded.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = readFileSync(join(ROOT, 'agents', 'ai-citation-tracker', 'index.js'), 'utf8');
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'recompute-citation-baseline.mjs'), 'utf8');

// ── The agent must not re-declare the detectors ──────────────────────────────

test('the tracker IMPORTS the detectors rather than hand-rolling them', () => {
  assert.match(AGENT, /from '\.\.\/\.\.\/lib\/citation-detect\.js'/);
  assert.match(AGENT, /from '\.\.\/\.\.\/lib\/citation-redirects\.js'/);
});

test('the tracker declares NO local detectBrandCited / detectCompetitorCitations', () => {
  assert.doesNotMatch(AGENT, /function\s+detectBrandCited\b/,
    'a second copy is how the redirect blindness would come back');
  assert.doesNotMatch(AGENT, /function\s+detectCompetitorCitations\b/);
});

test('the tracker tests for a redirect ONLY through the shared predicate', () => {
  // The host name legitimately appears in prose the report prints for a human.
  // What must never appear is a second copy of the TEST — a hand-rolled
  // `includes`/regex against the host, which is how the fleet's one taxonomy
  // drifts into two (the AWARENESS_LEVELS rule).
  assert.match(AGENT, /\bisGroundingRedirect\b/);
  assert.doesNotMatch(AGENT, /includes\(\s*['"`]vertexaisearch/);
  assert.doesNotMatch(AGENT, /startsWith\(\s*['"`]https?:\/\/vertexaisearch/);
  assert.doesNotMatch(AGENT, /\/\^?https\?:\\\/\\\/vertexaisearch/);
});

// ── The raw field must keep its shape ────────────────────────────────────────

test('citation_urls is still written RAW — pr-target-finder resolves it itself', () => {
  assert.match(AGENT, /citation_urls:\s*citations,/);
});

test('the resolved URLs are ADDED under their own key, never in place of the raw one', () => {
  assert.match(AGENT, /citation_urls_resolved:/);
});

// ── Degrading must be visible ────────────────────────────────────────────────

test('--no-resolve exists and the snapshot records which mode ran', () => {
  assert.match(AGENT, /--no-resolve/);
  assert.match(AGENT, /redirect_resolution/);
  assert.match(AGENT, /mode:\s*RESOLVE\s*\?\s*'on'\s*:\s*'off'/);
});

test('the banner reaches the console, the markdown report AND the deferred digest', () => {
  const hits = AGENT.match(/redirectResolutionBanner\(/g) || [];
  assert.ok(hits.length >= 3, `expected the banner on at least 3 surfaces, saw ${hits.length}`);
  assert.match(AGENT, /body:\s*`\$\{summaryLine\}[^`]*redirectResolutionBanner/);
});

test('a redirect finding never escalates — it stays a deferred info notification', () => {
  assert.doesNotMatch(AGENT, /immediate:\s*true/);
  assert.doesNotMatch(AGENT, /status:\s*'error'/);
});

// ── The recompute script may never touch the history ─────────────────────────

test('the recompute script writes ONLY under its own OUT_DIR', () => {
  const writes = SCRIPT.match(/writeFileSync\([^)]*/g) || [];
  assert.ok(writes.length > 0);
  for (const w of writes) {
    assert.match(w, /OUT_DIR/, `a write outside OUT_DIR would endanger the snapshots: ${w}`);
  }
  assert.match(SCRIPT, /const OUT_DIR = join\(ROOT, 'data', 'reports', 'ai-citation-baseline'\)/);
});

test('the recompute script is DRY by default', () => {
  assert.match(SCRIPT, /const APPLY = args\.includes\('--apply'\)/);
  assert.match(SCRIPT, /if \(!APPLY\)/);
});

test('the recompute script never writes into the ai-citations snapshot directory', () => {
  assert.doesNotMatch(SCRIPT, /writeFileSync\([^)]*SNAPSHOT_DIR/);
  assert.doesNotMatch(SCRIPT, /\bunlinkSync\b|\brenameSync\b|\brmSync\b/,
    'this path is read-only over the only copy of the citation history');
});

test('the recompute report labels itself a recomputation', () => {
  assert.match(SCRIPT, /kind:\s*'recomputation'/);
  assert.match(SCRIPT, /No ai-citations snapshot was modified/);
});
