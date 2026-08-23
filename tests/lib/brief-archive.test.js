import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DROPPED_DIRNAME,
  DROP_RECORD_SUFFIX,
  DROP_LOG_FILENAME,
  DROPPED_README,
  SIZE_WARN_BYTES,
  droppedDir,
  allocateArchiveName,
  buildDropRecord,
  newRunId,
  renderDropDigest,
  archiveBriefs,
  listDropped,
  restoreDropped,
  droppedSizeBytes,
} from '../../lib/brief-archive.js';

// Between 2026-08-19 15:00 UTC and 2026-08-23 13:17 UTC lib/cluster-revenue.js
// wrongly stamped the `soap` cluster proven_dud, and
// scripts/triage-orphan-briefs.mjs --drop-non-earning --apply unlinkSync'd
// three paid-for briefs off disk: vegan-soap, oatmeal-soap and
// coconut-oil-soap-benefits. No backup, no report, no digest row. They are
// gone. Everything in this file exists so the next wrong verdict costs a
// `--restore` instead.

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'brief-archive-'));
  mkdirSync(join(root, 'data', 'briefs'), { recursive: true });
  return root;
}

function writeBrief(root, slug, body = {}) {
  const path = join(root, 'data', 'briefs', `${slug}.json`);
  writeFileSync(path, JSON.stringify({ target_keyword: slug.replace(/-/g, ' '), ...body }, null, 2));
  return path;
}

const SOAP_VERDICT = {
  status: 'proven_dud',
  revenue: 0,
  clicks: 268,
  pages: 32,
  evidence: 'attributed $0 on 268 clicks across 32 pages',
};

// ── allocateArchiveName — never overwrite an earlier drop ────────────────────

test('allocateArchiveName uses the bare slug when nothing is archived yet', () => {
  const { brief, record } = allocateArchiveName([], 'vegan-soap');
  assert.equal(brief, 'vegan-soap.json');
  assert.equal(record, `vegan-soap${DROP_RECORD_SUFFIX}`);
});

test('allocateArchiveName suffixes rather than clobbering a brief dropped before', () => {
  const { brief, record } = allocateArchiveName(['vegan-soap.json', `vegan-soap${DROP_RECORD_SUFFIX}`], 'vegan-soap');
  assert.equal(brief, 'vegan-soap--2.json');
  assert.equal(record, `vegan-soap--2${DROP_RECORD_SUFFIX}`);
});

test('allocateArchiveName keeps counting past a gap so no existing name is reused', () => {
  const existing = ['vegan-soap.json', 'vegan-soap--2.json', 'vegan-soap--3.json'];
  assert.equal(allocateArchiveName(existing, 'vegan-soap').brief, 'vegan-soap--4.json');
});

test('allocateArchiveName treats a taken RECORD name as a collision too', () => {
  // A slug literally called `x--2` would otherwise let a later `x` drop
  // overwrite its sidecar while the brief itself got a fresh name.
  const { brief, record } = allocateArchiveName([`vegan-soap--2${DROP_RECORD_SUFFIX}`], 'vegan-soap--2');
  assert.notEqual(record, `vegan-soap--2${DROP_RECORD_SUFFIX}`);
  assert.equal(brief, 'vegan-soap--2--2.json');
});

// ── the record — enough to understand the drop six weeks later ───────────────

test('buildDropRecord preserves when, why, the cluster verdict and the run', () => {
  const rec = buildDropRecord({
    slug: 'vegan-soap',
    keyword: 'vegan soap',
    reason: 'soap cluster does not earn (268 clicks across 32 pages, $0.00)',
    cluster: 'soap',
    clusterStats: SOAP_VERDICT,
    archivedFile: 'vegan-soap.json',
    runId: '2026-08-23T13-17-02-123Z-4242',
    droppedBy: 'scripts/triage-orphan-briefs.mjs',
    now: new Date('2026-08-23T13:17:02.123Z'),
    report: { source: 'data/reports/seo-impact/latest.json', generated_at: '2026-08-22' },
  });

  assert.equal(rec.slug, 'vegan-soap');
  assert.equal(rec.dropped_at, '2026-08-23T13:17:02.123Z');
  assert.equal(rec.run_id, '2026-08-23T13-17-02-123Z-4242');
  assert.equal(rec.cluster, 'soap');
  assert.equal(rec.cluster_verdict.clicks, 268);
  assert.equal(rec.cluster_verdict.evidence, SOAP_VERDICT.evidence, 'the evidence string is the why — keep it verbatim');
  assert.equal(rec.report.generated_at, '2026-08-22');
  assert.equal(rec.archived_file, 'vegan-soap.json');
  // The restore path has to be obvious to someone who has never read this code.
  assert.match(rec.restore, /--restore vegan-soap/);
});

test('newRunId is filename-safe and identifies the run', () => {
  const id = newRunId(new Date('2026-08-23T13:17:02.123Z'), 4242);
  assert.equal(id, '2026-08-23T13-17-02-123Z-4242');
  assert.ok(!/[:/\\]/.test(id));
});

// ── archiveBriefs — the move that replaced unlinkSync ────────────────────────

test('archiveBriefs moves the brief instead of deleting it, byte for byte', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap', { outline: ['why vegan soap'] });
    const before = readFileSync(path, 'utf8');

    const res = archiveBriefs({
      root,
      drops: [{ slug: 'vegan-soap', path, keyword: 'vegan soap', reason: 'soap cluster does not earn', cluster: 'soap', clusterStats: SOAP_VERDICT }],
      runId: 'run-1',
      now: new Date('2026-08-23T13:17:02.123Z'),
    });

    assert.equal(res.archived.length, 1);
    assert.equal(res.failed.length, 0);
    assert.equal(existsSync(path), false, 'it must leave data/briefs/');
    const archivedPath = join(droppedDir(root), 'vegan-soap.json');
    assert.equal(existsSync(archivedPath), true, 'and it must still exist');
    assert.equal(readFileSync(archivedPath, 'utf8'), before, 'unchanged — this is the artifact we failed to keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archiveBriefs writes a sidecar record naming the verdict that condemned it', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'oatmeal-soap');
    archiveBriefs({
      root,
      drops: [{ slug: 'oatmeal-soap', path, keyword: 'oatmeal soap', reason: 'soap cluster does not earn (268 clicks across 32 pages, $0.00)', cluster: 'soap', clusterStats: SOAP_VERDICT }],
      runId: 'run-1',
      now: new Date('2026-08-23T13:17:02.123Z'),
      report: { source: 'data/reports/seo-impact/latest.json', generated_at: '2026-08-22' },
    });

    const rec = JSON.parse(readFileSync(join(droppedDir(root), `oatmeal-soap${DROP_RECORD_SUFFIX}`), 'utf8'));
    assert.equal(rec.cluster, 'soap');
    assert.equal(rec.cluster_verdict.clicks, 268);
    assert.match(rec.reason, /268 clicks/);
    assert.equal(rec.report.generated_at, '2026-08-22');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archiveBriefs never overwrites a brief dropped under the same slug before', () => {
  const root = tmpRoot();
  try {
    writeBrief(root, 'vegan-soap', { round: 'first' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path: join(root, 'data', 'briefs', 'vegan-soap.json'), keyword: 'vegan soap', reason: 'r1' }], runId: 'run-1', now: new Date() });

    writeBrief(root, 'vegan-soap', { round: 'second' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path: join(root, 'data', 'briefs', 'vegan-soap.json'), keyword: 'vegan soap', reason: 'r2' }], runId: 'run-2', now: new Date() });

    const first = JSON.parse(readFileSync(join(droppedDir(root), 'vegan-soap.json'), 'utf8'));
    const second = JSON.parse(readFileSync(join(droppedDir(root), 'vegan-soap--2.json'), 'utf8'));
    assert.equal(first.round, 'first', 'the earlier drop survives the later one');
    assert.equal(second.round, 'second');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archiveBriefs keeps a brief whose JSON will not even parse', () => {
  const root = tmpRoot();
  try {
    const path = join(root, 'data', 'briefs', 'broken.json');
    writeFileSync(path, '{ truncated');
    archiveBriefs({ root, drops: [{ slug: 'broken', path, keyword: '(unreadable)', reason: 'brief JSON will not parse' }], runId: 'run-1', now: new Date() });
    assert.equal(readFileSync(join(droppedDir(root), 'broken.json'), 'utf8'), '{ truncated',
      'unparseable is not the same as worthless — a human can still read it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archiveBriefs appends to log.jsonl and writes the README', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap');
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'vegan soap', reason: 'r' }], runId: 'run-1', now: new Date('2026-08-23T13:17:02.123Z') });

    const log = readFileSync(join(droppedDir(root), DROP_LOG_FILENAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].event, 'drop');
    assert.equal(log[0].slug, 'vegan-soap');
    assert.equal(log[0].run_id, 'run-1');

    const readme = readFileSync(join(droppedDir(root), 'README.md'), 'utf8');
    assert.equal(readme, DROPPED_README, 'deterministic, so re-running does not churn the diff');
    assert.match(readme, /--restore/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archiveBriefs reports a failure instead of throwing the whole run away', () => {
  const root = tmpRoot();
  try {
    const res = archiveBriefs({
      root,
      drops: [{ slug: 'ghost', path: join(root, 'data', 'briefs', 'ghost.json'), keyword: 'ghost', reason: 'r' }],
      runId: 'run-1',
      now: new Date(),
    });
    assert.equal(res.archived.length, 0);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].slug, 'ghost');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── the invariant that matters most: _dropped/ is not a live brief ───────────

test('the archive directory name is invisible to a `.json` filter over data/briefs/', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap');
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'vegan soap', reason: 'r' }], runId: 'run-1', now: new Date() });

    // This is verbatim what all six readers of data/briefs/ do:
    //   readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.json'))
    const seen = readdirSync(join(root, 'data', 'briefs')).filter((f) => f.endsWith('.json'));
    assert.deepEqual(seen, [], 'a dropped brief must not be re-read, re-briefed or re-counted');
    assert.ok(!DROPPED_DIRNAME.endsWith('.json'), 'that invisibility is the whole reason for the name');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nothing under data/briefs/ is recursed into by a plain readdirSync', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap');
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'vegan soap', reason: 'r' }], runId: 'run-1', now: new Date() });
    const entries = readdirSync(join(root, 'data', 'briefs'));
    assert.deepEqual(entries, [DROPPED_DIRNAME], 'one directory entry, and it is not a brief');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── listDropped / restoreDropped — recovery without hand-moving files ────────

test('listDropped reports each archived brief with its record, newest drop last', () => {
  const root = tmpRoot();
  try {
    writeBrief(root, 'vegan-soap', { round: 'first' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path: join(root, 'data', 'briefs', 'vegan-soap.json'), keyword: 'vegan soap', reason: 'r1' }], runId: 'run-1', now: new Date() });
    writeBrief(root, 'vegan-soap', { round: 'second' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path: join(root, 'data', 'briefs', 'vegan-soap.json'), keyword: 'vegan soap', reason: 'r2' }], runId: 'run-2', now: new Date() });

    const list = listDropped({ root });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((d) => d.file), ['vegan-soap.json', 'vegan-soap--2.json']);
    assert.equal(list[1].record.reason, 'r2');
    assert.equal(list[1].slug, 'vegan-soap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listDropped ignores README.md and log.jsonl', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap');
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'vegan soap', reason: 'r' }], runId: 'run-1', now: new Date() });
    assert.deepEqual(listDropped({ root }).map((d) => d.file), ['vegan-soap.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoreDropped puts a named brief back where the pipeline reads it', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap', { outline: ['x'] });
    const before = readFileSync(path, 'utf8');
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'vegan soap', reason: 'r' }], runId: 'run-1', now: new Date() });

    const res = restoreDropped({ root, slugs: ['vegan-soap'], runId: 'run-2', now: new Date() });
    assert.equal(res.restored.length, 1);
    assert.equal(readFileSync(path, 'utf8'), before, 'byte for byte back');
    assert.equal(existsSync(join(droppedDir(root), 'vegan-soap.json')), false);
    assert.equal(existsSync(join(droppedDir(root), `vegan-soap${DROP_RECORD_SUFFIX}`)), true,
      'the record stays — the audit trail outlives the restore');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoreDropped takes the NEWEST drop of a slug that went twice', () => {
  const root = tmpRoot();
  try {
    writeBrief(root, 'vegan-soap', { round: 'first' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path: join(root, 'data', 'briefs', 'vegan-soap.json'), keyword: 'k', reason: 'r1' }], runId: 'run-1', now: new Date() });
    writeBrief(root, 'vegan-soap', { round: 'second' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path: join(root, 'data', 'briefs', 'vegan-soap.json'), keyword: 'k', reason: 'r2' }], runId: 'run-2', now: new Date() });

    restoreDropped({ root, slugs: ['vegan-soap'], runId: 'run-3', now: new Date() });
    const back = JSON.parse(readFileSync(join(root, 'data', 'briefs', 'vegan-soap.json'), 'utf8'));
    assert.equal(back.round, 'second');
    assert.equal(existsSync(join(droppedDir(root), 'vegan-soap.json')), true, 'the older drop is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoreDropped refuses to clobber a live brief unless forced', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap', { round: 'archived' });
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'k', reason: 'r' }], runId: 'run-1', now: new Date() });
    writeBrief(root, 'vegan-soap', { round: 'live' });

    const blocked = restoreDropped({ root, slugs: ['vegan-soap'], runId: 'run-2', now: new Date() });
    assert.equal(blocked.restored.length, 0);
    assert.equal(blocked.skipped.length, 1);
    assert.match(blocked.skipped[0].reason, /already exists/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).round, 'live');

    const forced = restoreDropped({ root, slugs: ['vegan-soap'], force: true, runId: 'run-3', now: new Date() });
    assert.equal(forced.restored.length, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).round, 'archived');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoreDropped --all brings back every archived brief', () => {
  const root = tmpRoot();
  try {
    for (const slug of ['vegan-soap', 'oatmeal-soap', 'coconut-oil-soap-benefits']) {
      const path = writeBrief(root, slug);
      archiveBriefs({ root, drops: [{ slug, path, keyword: slug, reason: 'soap cluster does not earn' }], runId: 'run-1', now: new Date() });
    }
    const res = restoreDropped({ root, all: true, runId: 'run-2', now: new Date() });
    assert.equal(res.restored.length, 3);
    assert.deepEqual(
      readdirSync(join(root, 'data', 'briefs')).filter((f) => f.endsWith('.json')).sort(),
      ['coconut-oil-soap-benefits.json', 'oatmeal-soap.json', 'vegan-soap.json'],
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoreDropped reports an unknown slug instead of silently doing nothing', () => {
  const root = tmpRoot();
  try {
    const res = restoreDropped({ root, slugs: ['never-dropped'], runId: 'run-1', now: new Date() });
    assert.equal(res.restored.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /nothing archived/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoreDropped logs the restore so the history stays complete', () => {
  const root = tmpRoot();
  try {
    const path = writeBrief(root, 'vegan-soap');
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'k', reason: 'r' }], runId: 'run-1', now: new Date() });
    restoreDropped({ root, slugs: ['vegan-soap'], runId: 'run-2', now: new Date() });

    const log = readFileSync(join(droppedDir(root), DROP_LOG_FILENAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => e.event), ['drop', 'restore']);
    assert.equal(log[1].run_id, 'run-2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── size: no retention timer, but never a silent disk problem ────────────────

test('droppedSizeBytes measures the archive and is zero before anything is dropped', () => {
  const root = tmpRoot();
  try {
    assert.equal(droppedSizeBytes({ root }), 0);
    const path = writeBrief(root, 'vegan-soap');
    const size = readFileSync(path).length;
    archiveBriefs({ root, drops: [{ slug: 'vegan-soap', path, keyword: 'k', reason: 'r' }], runId: 'run-1', now: new Date() });
    assert.ok(droppedSizeBytes({ root }) >= size);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the size warning threshold is far below the production box free disk', () => {
  // ~9.9 GB free on the server. A brief is ~25 KB, so this fires around 10k
  // drops — loud long before it is a disk problem, and it deletes nothing.
  assert.ok(SIZE_WARN_BYTES < 1024 * 1024 * 1024, 'must warn well under a gigabyte');
  assert.ok(SIZE_WARN_BYTES > 10 * 1024 * 1024, 'but not nag about a normal archive');
});

// ── the digest row that was missing entirely ─────────────────────────────────

test('renderDropDigest names every brief it dropped', () => {
  const { subject, body } = renderDropDigest({
    dropped: [
      { slug: 'vegan-soap', keyword: 'vegan soap', reason: 'soap cluster does not earn (268 clicks across 32 pages, $0.00)', archivedFile: 'vegan-soap.json' },
      { slug: 'oatmeal-soap', keyword: 'oatmeal soap', reason: 'soap cluster does not earn (268 clicks across 32 pages, $0.00)', archivedFile: 'oatmeal-soap.json' },
    ],
    kept: 12,
    sizeBytes: 1024,
    runId: 'run-1',
  });

  assert.match(subject, /2 brief/);
  assert.match(body, /vegan-soap/);
  assert.match(body, /oatmeal-soap/);
  assert.match(body, /268 clicks/, 'the evidence goes in the digest, not just the console');
  assert.match(body, /--restore/, 'the digest tells the reader how to undo it');
  assert.match(body, /_dropped/);
});

test('renderDropDigest says nothing was deleted, because nothing was', () => {
  const { body } = renderDropDigest({ dropped: [{ slug: 'x', keyword: 'x', reason: 'r', archivedFile: 'x.json' }], kept: 0, sizeBytes: 0, runId: 'r' });
  assert.match(body, /not deleted|moved/i);
});

test('renderDropDigest warns when the archive gets large, and still deletes nothing', () => {
  const { body } = renderDropDigest({ dropped: [{ slug: 'x', keyword: 'x', reason: 'r', archivedFile: 'x.json' }], kept: 0, sizeBytes: SIZE_WARN_BYTES + 1, runId: 'r' });
  assert.match(body, /⚠|large/i);
  assert.doesNotMatch(body, /automatically (deleted|pruned|removed)/i);
});

test('renderDropDigest reports failures so a half-done archive is visible', () => {
  const { subject, body } = renderDropDigest({
    dropped: [], kept: 3, sizeBytes: 0, runId: 'r',
    failed: [{ slug: 'ghost', error: 'ENOENT' }],
  });
  assert.match(subject, /1 failed/);
  assert.match(body, /ghost/);
});
