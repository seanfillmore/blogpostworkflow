// Built from the real 2026-09-09 production shape: 21 HIGH-confidence merges,
// 17 of them targeting one winner — the biggest page on the blog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { capMergesPerWinner, mergeCapLines, MAX_MERGES_PER_WINNER } from '../../lib/merge-cap.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLAGSHIP = '/blogs/news/toothpaste-without-sls-what-to-know-best-options';
const LOTION = '/blogs/news/best-unscented-lotion-clean-fragrance-free-picks';

// Each merge names a DISTINCT loser. Modelling N merges as N copies of one
// (loser -> winner) pair is the bug the dedupe below fixes, not the shape of a
// real pool — a real pool is many different duplicates of one winner.
let loserSeq = 0;
const merge = (winner, query = 'q') => ({
  query, winner, confidence: 'HIGH',
  losers: [{ path: `/blogs/news/loser-${++loserSeq}`, action: 'CONSOLIDATE' }],
});
const redirectOnly = (winner) => ({
  query: 'r', winner, confidence: 'HIGH',
  losers: [{ path: `/blogs/news/redir-${++loserSeq}`, action: 'REDIRECT' }],
});

test('one winner cannot be rewritten more than the cap in a single run', () => {
  const decisions = Array.from({ length: 17 }, (_, i) => merge(FLAGSHIP, `q${i}`));
  const { apply, deferred } = capMergesPerWinner(decisions);
  assert.equal(apply.length, MAX_MERGES_PER_WINNER);
  assert.equal(deferred.length, 17 - MAX_MERGES_PER_WINNER);
});

test('the cap is PER WINNER, not per run', () => {
  // Two different pages each get their full allowance — the hazard is
  // compounding rewrites of ONE body, not total merges.
  const decisions = [
    ...Array.from({ length: 5 }, (_, i) => merge(FLAGSHIP, `t${i}`)),
    ...Array.from({ length: 2 }, (_, i) => merge(LOTION, `l${i}`)),
  ];
  const { apply, perWinner } = capMergesPerWinner(decisions);
  assert.equal(apply.length, MAX_MERGES_PER_WINNER + 2);
  assert.equal(perWinner.get(FLAGSHIP.toLowerCase()), MAX_MERGES_PER_WINNER);
  assert.equal(perWinner.get(LOTION.toLowerCase()), 2);
});

test('a decision that rewrites NO body is never capped', () => {
  // A REDIRECT 301s the loser and leaves the winner untouched; holding it back
  // would strand the cheap half of a consolidation behind the expensive half.
  const decisions = [
    ...Array.from({ length: 5 }, (_, i) => merge(FLAGSHIP, `m${i}`)),
    redirectOnly(FLAGSHIP),
    { query: 'mon', winner: FLAGSHIP, confidence: 'HIGH', losers: [{ path: '/x', action: 'MONITOR' }] },
  ];
  const { apply, deferred } = capMergesPerWinner(decisions);
  assert.equal(apply.length, MAX_MERGES_PER_WINNER + 2, 'both no-rewrite decisions still apply');
  assert.ok(deferred.every((d) => d.merges > 0));
});

test('a multi-merge decision is deferred WHOLE, never split', () => {
  // Applying half a decision would redirect some losers into a winner that
  // never absorbed their content.
  const big = {
    query: 'best sls free toothpaste',
    winner: FLAGSHIP,
    confidence: 'HIGH',
    losers: [
      { path: '/a', action: 'CONSOLIDATE' },
      { path: '/b', action: 'CONSOLIDATE' },
      { path: '/c', action: 'CONSOLIDATE' },
    ],
  };
  const { apply, deferred } = capMergesPerWinner([merge(FLAGSHIP, 'first'), big]);
  assert.equal(apply.length, 1, 'the 3-merge decision does not fit in the 2 remaining slots');
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].merges, 3);
});

test('triage ORDER is preserved — biggest conflicts spend the cap first', () => {
  // The triage list arrives ranked by total impressions. Re-sorting here would
  // silently override that ranking.
  const decisions = ['big', 'mid', 'small', 'tiny'].map((q) => merge(FLAGSHIP, q));
  const { apply } = capMergesPerWinner(decisions);
  assert.deepEqual(apply.map((d) => d.query), ['big', 'mid', 'small']);
});

test('deferral is not dismissal, and the report says so', () => {
  const { deferred, perWinner } = capMergesPerWinner(
    Array.from({ length: 6 }, (_, i) => merge(FLAGSHIP, `q${i}`)),
  );
  const lines = mergeCapLines({ deferred, perWinner }).join('\n');
  assert.match(lines, /DEFERRED/);
  assert.match(lines, /Nothing is dismissed/);
  assert.match(lines, /re-propose/);
  assert.match(lines, /toothpaste-without-sls/);
});

test('a clean run says the cap did not bite', () => {
  const { deferred, perWinner } = capMergesPerWinner([merge(FLAGSHIP), merge(LOTION)]);
  assert.equal(deferred.length, 0);
  assert.match(mergeCapLines({ deferred, perWinner }).join('\n'), /nothing deferred/);
});

test('empty and malformed input do not throw', () => {
  for (const input of [[], null, undefined, [{}], [{ winner: FLAGSHIP }]]) {
    assert.doesNotThrow(() => capMergesPerWinner(input));
  }
});

test('the resolver applies the CAPPED list, not the raw decisions', () => {
  // The whole fix is one word at the loop head. A regression there is silent:
  // every decision still applies and the run still exits 0.
  const src = readFileSync(join(ROOT, 'agents/cannibalization-resolver/index.js'), 'utf8');
  assert.match(src, /const \{ apply: capped[^}]*\} = capMergesPerWinner\(decisions\)/);
  assert.match(src, /for \(const decision of capped\)/,
    'the apply loop must iterate the capped list');
  assert.doesNotMatch(src, /for \(const decision of decisions\)\s*\{\s*\n\s*if \(decision\.confidence !== 'HIGH'\)/,
    'iterating the uncapped list would restore the 17-rewrite run');
  assert.match(src, /mergeCapLines\(/, 'the run must report what it deferred');
});

// ── Added 2026-09-09, from the live --apply run ─────────────────────────────
// The cap allowed 3 merges and ALL THREE were the same (loser -> winner) pair,
// reached from three different queries: three paid Claude merges of one page.
// The run then reported "2 held for review", sending a human to look at two
// superseded attempts at work the third had already completed.

const pair = (winner, loser, query) => ({
  query, winner, confidence: 'HIGH', losers: [{ path: loser, action: 'CONSOLIDATE' }],
});

test('the same (loser -> winner) pair is merged ONCE, however many queries propose it', () => {
  const decisions = [
    pair(FLAGSHIP, '/blogs/news/best-toothpaste-without-sls-2025', 'sls free toothpaste'),
    pair(FLAGSHIP, '/blogs/news/best-toothpaste-without-sls-2025', 'toothpaste without sls'),
    pair(FLAGSHIP, '/blogs/news/best-toothpaste-without-sls-2025', 'best toothpaste without sls'),
  ];
  const { apply, duplicates } = capMergesPerWinner(decisions);
  assert.equal(apply.length, 1, 'one pair is one piece of work');
  assert.equal(duplicates.length, 2);
});

test('deduping happens BEFORE the cap, so the cap buys real merges', () => {
  // Otherwise three slots are spent on one page and two genuinely different
  // duplicates are deferred behind repeats of it.
  const decisions = [
    pair(FLAGSHIP, '/blogs/news/dup', 'q1'),
    pair(FLAGSHIP, '/blogs/news/dup', 'q2'),
    pair(FLAGSHIP, '/blogs/news/dup', 'q3'),
    pair(FLAGSHIP, '/blogs/news/other-a', 'q4'),
    pair(FLAGSHIP, '/blogs/news/other-b', 'q5'),
  ];
  const { apply, deferred } = capMergesPerWinner(decisions);
  assert.equal(apply.length, 3, 'dup + other-a + other-b all fit in the cap of 3');
  assert.equal(deferred.length, 0);
  const losers = apply.flatMap((d) => d.losers.map((l) => l.path));
  assert.deepEqual(losers.sort(), ['/blogs/news/dup', '/blogs/news/other-a', '/blogs/news/other-b']);
});

test('a repeat pair is dropped from a decision without dropping its other work', () => {
  const first = pair(FLAGSHIP, '/blogs/news/dup', 'q1');
  const mixed = {
    query: 'q2',
    winner: FLAGSHIP,
    confidence: 'HIGH',
    losers: [
      { path: '/blogs/news/dup', action: 'CONSOLIDATE' },   // already merged
      { path: '/blogs/news/fresh', action: 'CONSOLIDATE' }, // still to do
      { path: '/blogs/news/r', action: 'REDIRECT' },        // untouched
    ],
  };
  const { apply, duplicates } = capMergesPerWinner([first, mixed]);
  assert.equal(duplicates.length, 1);
  const second = apply[1];
  assert.deepEqual(second.losers.map((l) => l.path), ['/blogs/news/fresh', '/blogs/news/r']);
  assert.notEqual(second, mixed, 'the original decision object is not mutated');
  assert.equal(mixed.losers.length, 3, 'caller-owned input stays intact');
});

test('a decision whose every merge is a repeat, and nothing else, is dropped whole', () => {
  const { apply } = capMergesPerWinner([
    pair(FLAGSHIP, '/blogs/news/dup', 'q1'),
    pair(FLAGSHIP, '/blogs/news/dup', 'q2'),
  ]);
  assert.equal(apply.length, 1);
});

test('the same loser merged into a DIFFERENT winner is not a duplicate', () => {
  const { apply, duplicates } = capMergesPerWinner([
    pair(FLAGSHIP, '/blogs/news/x', 'q1'),
    pair(LOTION, '/blogs/news/x', 'q2'),
  ]);
  assert.equal(duplicates.length, 0);
  assert.equal(apply.length, 2);
});

test('the run reports what it deduped', () => {
  const { deferred, duplicates, perWinner } = capMergesPerWinner([
    pair(FLAGSHIP, '/blogs/news/dup', 'q1'),
    pair(FLAGSHIP, '/blogs/news/dup', 'q2'),
  ]);
  const lines = mergeCapLines({ deferred, duplicates, perWinner }).join('\n');
  assert.match(lines, /Deduped 1 repeat merge/);
  assert.match(lines, /one piece of work/);
});
