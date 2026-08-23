// tests/lib/rejected-keywords.test.js
//
// data/rejected-keywords.json is TRACKED in git and WRITTEN by production. On
// 2026-08-23 it held 39 entries on the server against 2 committed — 37 that
// exist nowhere but the production box. Audited that day, none had been lost
// yet (the 18 `content-strategist:product-scope` entries match the 18
// `[SKIP] Off product scope` lines in scheduler.log one-for-one), and the
// server's reflog shows only fast-forward pulls and mixed resets — never
// `--hard`. The hazard is real and un-fired: it survives only because nothing
// has committed that file since 2026-04-08.
//
// These tests pin the two properties that make the failure mode safe: a write
// can never drop an entry it did not know about, and a reconcile can never
// resolve a divergence by discarding one side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeRejection,
  mergeRejections,
  loadRejections,
  appendRejection,
  diffRejections,
  renderReconcileReport,
} from '../../lib/rejected-keywords.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'rejkw-'));
  return { dir, path: join(dir, 'rejected-keywords.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeRejection — four writers, four different shapes
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeRejection accepts the dashboard DataForSEO route camelCase stamp', () => {
  // REAL entry 6 on the server: the only one carrying `rejectedAt`, which no
  // reader consults. It is preserved as `rejected_at` so it stops being invisible.
  const r = normalizeRejection({ keyword: 'real skin care organic body lotion', matchType: 'exact', reason: null, rejectedAt: '2026-05-02T00:00:00.000Z' });
  assert.equal(r.rejected_at, '2026-05-02T00:00:00.000Z');
  assert.equal(r.keyword, 'real skin care organic body lotion');
});

test('normalizeRejection accepts the manual added_at spelling', () => {
  const r = normalizeRejection({ keyword: 'reale', matchType: 'broad', added_at: '2026-04-09' });
  assert.equal(r.rejected_at, '2026-04-09');
});

test('normalizeRejection drops an entry with no keyword', () => {
  assert.equal(normalizeRejection({ reason: 'orphan' }), null);
  assert.equal(normalizeRejection(null), null);
  assert.equal(normalizeRejection({ keyword: '   ' }), null);
});

test('normalizeRejection never invents a matchType', () => {
  // Absent matchType means substring (`kw.includes(term)`) in eight of the nine
  // readers. Defaulting it to 'exact' here would quietly un-block every
  // content-strategist auto-rejection.
  const r = normalizeRejection({ keyword: 'tallow for skin', reason: 'no product mapping' });
  assert.equal('matchType' in r, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeRejections — the anti-clobber primitive
// ─────────────────────────────────────────────────────────────────────────────

const COMMITTED_2 = [
  { keyword: 'reale', matchType: 'broad', reason: "Brand conflict", added_at: '2026-04-09' },
  { keyword: 'real skin', matchType: 'exact', reason: 'exact-match only', added_at: '2026-04-09' },
];
const SERVER_EXTRA = [
  { keyword: 'reale', matchType: 'broad', reason: 'Brand conflict', added_at: '2026-04-09' },
  { keyword: 'real skin', matchType: 'exact', reason: 'exact-match only', added_at: '2026-04-09' },
  { keyword: 'jojoba oil for skin', reason: 'no product mapping', rejected_at: '2026-08-10T15:00:00.000Z', source: 'content-strategist:product-scope' },
  { keyword: 'armpit detox', reason: 'no product mapping', rejected_at: '2026-08-03T15:00:00.000Z', source: 'content-strategist:product-scope' },
];

test('mergeRejections keeps the union — the deploy hazard, inverted', () => {
  const merged = mergeRejections(COMMITTED_2, SERVER_EXTRA);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.map((r) => r.keyword).sort(), ['armpit detox', 'jojoba oil for skin', 'real skin', 'reale']);
});

test('mergeRejections is order-independent — neither side is "the winner"', () => {
  const a = mergeRejections(COMMITTED_2, SERVER_EXTRA).map((r) => r.keyword).sort();
  const b = mergeRejections(SERVER_EXTRA, COMMITTED_2).map((r) => r.keyword).sort();
  assert.deepEqual(a, b);
});

test('mergeRejections dedupes case-insensitively', () => {
  const merged = mergeRejections(
    [{ keyword: 'Armpit Detox', reason: 'manual' }],
    [{ keyword: 'armpit detox', reason: 'no product mapping', source: 'content-strategist:product-scope' }],
  );
  assert.equal(merged.length, 1);
});

test('mergeRejections keeps the EARLIEST rejection date on a duplicate', () => {
  const merged = mergeRejections(
    [{ keyword: 'armpit detox', rejected_at: '2026-08-03T15:00:00.000Z', reason: 'no product mapping' }],
    [{ keyword: 'armpit detox', rejected_at: '2026-08-20T00:00:00.000Z', reason: 're-rejected' }],
  );
  assert.equal(merged[0].rejected_at, '2026-08-03T15:00:00.000Z');
});

test('mergeRejections keeps the BROADER matchType on a duplicate', () => {
  // Widening a rejection blocks more; narrowing it lets a keyword back through.
  // A merge must never be the thing that narrows one.
  const merged = mergeRejections(
    [{ keyword: 'tattoo aftercare', matchType: 'exact' }],
    [{ keyword: 'tattoo aftercare', matchType: 'broad' }],
  );
  assert.equal(merged[0].matchType, 'broad');
});

test('mergeRejections keeps a field one side has and the other does not', () => {
  const merged = mergeRejections(
    [{ keyword: 'peppermint soap' }],
    [{ keyword: 'peppermint soap', slug: 'peppermint-soap', reason: 'killed', source: 'post-kill' }],
  );
  assert.equal(merged[0].slug, 'peppermint-soap');
  assert.equal(merged[0].source, 'post-kill');
});

test('mergeRejections tolerates a non-array side', () => {
  assert.deepEqual(mergeRejections(null, undefined), []);
  assert.equal(mergeRejections(COMMITTED_2, 'not a list').length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// appendRejection — re-read before write, or lose the other process's entry
// ─────────────────────────────────────────────────────────────────────────────

test('appendRejection adds an entry', () => {
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(COMMITTED_2, null, 2));
    const res = appendRejection({ keyword: 'beef tallow for skin', reason: 'no product mapping', source: 'content-strategist:product-scope' }, { path: s.path });
    assert.equal(res.added, true);
    assert.equal(JSON.parse(readFileSync(s.path, 'utf8')).length, 3);
  } finally { s.cleanup(); }
});

test('appendRejection is idempotent on an existing keyword', () => {
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(COMMITTED_2, null, 2));
    assert.equal(appendRejection({ keyword: 'REALE' }, { path: s.path }).added, false);
    assert.equal(JSON.parse(readFileSync(s.path, 'utf8')).length, 2);
  } finally { s.cleanup(); }
});

test('appendRejection re-reads, so a concurrent write is not lost', () => {
  // THE LOST UPDATE. Every writer did readFileSync → push → writeFileSync with
  // no lock. The 15:00 UTC cron scheduler and the long-lived PM2 dashboard both
  // write this file on the same box; a dashboard rejection landing mid-strategist
  // run used to vanish. Simulated here by mutating the file between the caller's
  // read and the append.
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(COMMITTED_2, null, 2));
    const stale = loadRejections({ path: s.path });      // the strategist's read
    writeFileSync(s.path, JSON.stringify([...COMMITTED_2, { keyword: 'glass skin routine', source: 'dashboard' }], null, 2));
    appendRejection({ keyword: 'organic skincare', source: 'content-strategist:product-scope' }, { path: s.path });

    const after = JSON.parse(readFileSync(s.path, 'utf8')).map((r) => r.keyword);
    assert.ok(after.includes('glass skin routine'), 'the dashboard entry survived');
    assert.ok(after.includes('organic skincare'), 'the strategist entry landed');
    assert.equal(stale.length, 2);
  } finally { s.cleanup(); }
});

test('appendRejection refuses an entry with no keyword rather than writing junk', () => {
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(COMMITTED_2, null, 2));
    assert.equal(appendRejection({ reason: 'oops' }, { path: s.path }).added, false);
    assert.equal(JSON.parse(readFileSync(s.path, 'utf8')).length, 2);
  } finally { s.cleanup(); }
});

test('appendRejection leaves the file untouched when the write cannot be staged', () => {
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(COMMITTED_2, null, 2));
    const before = readFileSync(s.path, 'utf8');
    assert.throws(() => appendRejection({ keyword: 'x' }, { path: join(s.dir, 'no', 'such', 'dir', 'f.json'), seedFrom: null }));
    assert.equal(readFileSync(s.path, 'utf8'), before);
  } finally { s.cleanup(); }
});

test('loadRejections returns [] for a missing or unparseable file', () => {
  const s = scratch();
  try {
    assert.deepEqual(loadRejections({ path: s.path }), []);
    writeFileSync(s.path, '{ this is not json');
    assert.deepEqual(loadRejections({ path: s.path }), []);
  } finally { s.cleanup(); }
});

test('loadRejections never returns an entry a reader would crash on', () => {
  const s = scratch();
  try {
    // Eight of the nine readers do `r.keyword.toLowerCase()` with no guard.
    writeFileSync(s.path, JSON.stringify([{ reason: 'no keyword' }, null, { keyword: 'ok' }]));
    const list = loadRejections({ path: s.path });
    assert.deepEqual(list.map((r) => r.keyword), ['ok']);
  } finally { s.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// diffRejections / renderReconcileReport — make the loss impossible to miss
// ─────────────────────────────────────────────────────────────────────────────

test('diffRejections names exactly what a clobber would destroy', () => {
  const d = diffRejections({ base: COMMITTED_2, head: SERVER_EXTRA });
  assert.deepEqual(d.onlyInHead.map((r) => r.keyword).sort(), ['armpit detox', 'jojoba oil for skin']);
  assert.deepEqual(d.onlyInBase, []);
  assert.equal(d.merged.length, 4);
  assert.equal(d.wouldLose, 2);
});

test('diffRejections counts a loss in EITHER direction', () => {
  const d = diffRejections({ base: [{ keyword: 'only-in-git' }], head: [{ keyword: 'only-on-server' }] });
  assert.equal(d.wouldLose, 2);
  assert.equal(d.merged.length, 2);
});

test('diffRejections reports zero drift when both sides agree', () => {
  const d = diffRejections({ base: COMMITTED_2, head: [...COMMITTED_2].reverse() });
  assert.equal(d.wouldLose, 0);
  assert.equal(d.inSync, true);
});

test('renderReconcileReport states the destructive outcome in words, not just counts', () => {
  const d = diffRejections({ base: COMMITTED_2, head: SERVER_EXTRA });
  const text = renderReconcileReport(d, { baseLabel: 'git HEAD', headLabel: 'working tree' });
  assert.match(text, /2 .*only in working tree/i);
  assert.match(text, /armpit detox/);
  assert.match(text, /re-propose/i);   // says WHY losing them costs money
  assert.match(text, /4/);             // the merged total
});

test('renderReconcileReport says so plainly when there is nothing to reconcile', () => {
  const d = diffRejections({ base: COMMITTED_2, head: COMMITTED_2 });
  assert.match(renderReconcileReport(d, {}), /in sync/i);
});
