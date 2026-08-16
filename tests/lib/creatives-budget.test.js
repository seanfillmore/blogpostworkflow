import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectImages, measureDir, rejectedVariationDirs, planPurge, enforceBudget, formatBytes,
  DEFAULT_BUDGET_BYTES,
} from '../../lib/creatives-budget.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-16T00:00:00.000Z');

function img(path, bytes, ageDays) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
}

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'creatives-budget-'));
  const cre = join(base, 'creatives');
  const as = join(cre, 'ad-studio');

  // Run A — old, one accepted variation and one rejected.
  const runA = join(as, 'run-a');
  mkdirSync(runA, { recursive: true });
  writeFileSync(join(runA, 'run.json'), JSON.stringify({
    results: [{ conceptSlug: 'manifesto', variations: [{ n: 1, ok: true }, { n: 2, ok: false }] }],
  }));
  img(join(runA, 'manifesto', 'v1', 'plate.jpg'), 1000, 40);
  img(join(runA, 'manifesto', 'v2', 'plate.jpg'), 1000, 40);   // rejected
  img(join(runA, 'manifesto', 'v2', 'comp.jpg'), 1000, 40);    // rejected

  // Run B — recent, nothing eligible on age.
  const runB = join(as, 'run-b');
  mkdirSync(runB, { recursive: true });
  writeFileSync(join(runB, 'run.json'), JSON.stringify({
    results: [{ conceptSlug: 'top-x-review', variations: [{ n: 1, ok: true }] }],
  }));
  img(join(runB, 'top-x-review', 'v1', 'plate.jpg'), 1000, 0);

  // A Creatives-tab session: one idle, one active.
  img(join(cre, 'session-old', 'a.png'), 1000, 60);
  img(join(cre, 'session-live', 'b.png'), 1000, 1);

  return { base, cre, as, runA, runB };
}

// ── measuring ───────────────────────────────────────────────────────────────────────
{
  const { base, cre, runA } = makeTree();
  // measureDir counts EVERYTHING, including the JSON, because the budget is about disk.
  assert.ok(measureDir(cre) > 6000);
  assert.equal(measureDir(join(base, 'nope')), 0);
  assert.equal(measureDir(''), 0);

  // collectImages finds images only — JSON is never a purge candidate.
  const imgs = collectImages(runA);
  assert.equal(imgs.length, 3);
  assert.ok(imgs.every(i => /\.(jpe?g|png|webp)$/i.test(i.path)));
  assert.ok(imgs.every(i => i.bytes === 1000 && typeof i.mtimeMs === 'number'));
  rmSync(base, { recursive: true, force: true });
}

// ── rejected variations come from run.json, never from filenames ────────────────────
{
  const { base, runA, runB } = makeTree();
  const rejected = rejectedVariationDirs(runA);
  assert.equal(rejected.size, 1);
  assert.ok([...rejected][0].endsWith(join('manifesto', 'v2')));
  assert.equal(rejectedVariationDirs(runB).size, 0);

  // A run whose report is missing or unreadable is treated as having NO rejected
  // variations, so tier 1 skips it entirely and tier 2 handles it on age. Erring toward
  // keeping is right when the alternative is deleting something nobody has seen.
  const orphan = join(base, 'creatives', 'ad-studio', 'run-crashed');
  mkdirSync(orphan, { recursive: true });
  assert.equal(rejectedVariationDirs(orphan).size, 0);
  writeFileSync(join(orphan, 'run.json'), 'not json');
  assert.equal(rejectedVariationDirs(orphan).size, 0);
  rmSync(base, { recursive: true, force: true });
}

// ── under budget: plan nothing at all ───────────────────────────────────────────────
{
  const { base, cre } = makeTree();
  const plan = planPurge({ creativesDir: cre, budgetBytes: 10 * 1024 * 1024, now: NOW });
  assert.equal(plan.underBudget, true);
  assert.deepEqual(plan.deletions, []);
  assert.equal(plan.freedBytes, 0);
  rmSync(base, { recursive: true, force: true });
}

// ── over budget: tier order, and STOP as soon as it fits ────────────────────────────
//
// The plan deletes the least it can, not everything it is allowed to.
{
  const { base, cre } = makeTree();
  // Total is ~6.3KB. A 5.5KB budget needs ~800B freed — one file, and it must be the
  // cheapest loss available: a rejected frame.
  const plan = planPurge({ creativesDir: cre, budgetBytes: 5500, now: NOW });
  assert.equal(plan.underBudget, true);
  assert.equal(plan.deletions.length, 1, 'deletes only what it must');
  assert.equal(plan.deletions[0].tier, 1, 'rejected frames go first');
  assert.match(plan.deletions[0].path, /v2/);
  assert.match(plan.deletions[0].path, /comp\.jpg$/, 'ties break on path, so this is reproducible');
  rmSync(base, { recursive: true, force: true });
}

// A tighter budget walks down the tiers in order.
{
  const { base, cre } = makeTree();
  const plan = planPurge({ creativesDir: cre, budgetBytes: 2500, now: NOW });
  const tiers = plan.deletions.map(d => d.tier);
  assert.deepEqual([...tiers].sort(), tiers, 'tiers are consumed in order, never interleaved');
  assert.ok(tiers.includes(1));
  // The recent run and the live session are protected by their age gates, so even a very
  // tight budget cannot reach them.
  assert.ok(!plan.deletions.some(d => /run-b/.test(d.path)), 'a fresh run is never purged');
  assert.ok(!plan.deletions.some(d => /session-live/.test(d.path)), 'an active session is never purged');
  rmSync(base, { recursive: true, force: true });
}

// ── JSON is never deleted, at any tier or any budget ────────────────────────────────
//
// run.json / proof.json / copy.json are a few KB and are the permanent audit trail: a run
// stays explicable after its pixels are gone.
{
  const { base, cre } = makeTree();
  const plan = planPurge({ creativesDir: cre, budgetBytes: 1, now: NOW });
  assert.ok(plan.deletions.length > 0);
  assert.ok(plan.deletions.every(d => !d.path.endsWith('.json')), 'JSON must never be a candidate');
  rmSync(base, { recursive: true, force: true });
}

// ── keepPaths: the run just written is untouchable ──────────────────────────────────
//
// A sweep must never eat the frames the operator is about to look at, however far over
// budget the directory is.
{
  const { base, cre, runA } = makeTree();
  const plan = planPurge({ creativesDir: cre, budgetBytes: 1, keepPaths: [runA], now: NOW });
  assert.ok(plan.deletions.length > 0);
  assert.ok(plan.deletions.every(d => !d.path.startsWith(runA + '/')), 'kept run is excluded entirely');
  rmSync(base, { recursive: true, force: true });
}

// ── when nothing more can be freed, say so rather than pretending ───────────────────
{
  const { base, cre } = makeTree();
  const plan = planPurge({
    creativesDir: cre, budgetBytes: 1, now: NOW,
    // Every age gate wide open means nothing is eligible at all.
    rejectedGraceDays: 9999, runAgeDays: 9999, sessionIdleDays: 9999,
  });
  assert.equal(plan.deletions.length, 0);
  assert.equal(plan.underBudget, false, 'still over, and honest about it');
  assert.ok(plan.overBy > 0);
  rmSync(base, { recursive: true, force: true });
}

// ── enforceBudget: dry by default, deletes only on apply ────────────────────────────
{
  const { base, cre } = makeTree();
  // comp.jpg, not plate.jpg: both rejected frames share an mtime, and the purge breaks
  // that tie on PATH so a destructive operation is reproducible.
  const victim = join(cre, 'ad-studio', 'run-a', 'manifesto', 'v2', 'comp.jpg');

  const dry = enforceBudget({ creativesDir: cre, budgetBytes: 5500, now: NOW });
  assert.equal(dry.applied, false);
  assert.ok(dry.deletions.length > 0, 'a dry run still reports what it would do');
  assert.ok(existsSync(victim), 'and deletes nothing');

  const wet = enforceBudget({ creativesDir: cre, budgetBytes: 5500, now: NOW, apply: true });
  assert.equal(wet.applied, true);
  assert.equal(wet.freedBytes, 1000);
  assert.ok(!existsSync(victim), 'apply actually deletes');
  // The audit trail survives the pixels.
  assert.ok(existsSync(join(cre, 'ad-studio', 'run-a', 'run.json')));
  rmSync(base, { recursive: true, force: true });
}

// Never throws — a budget sweep must not turn a finished, paid run into a failure.
{
  const res = enforceBudget({ creativesDir: '/definitely/not/here', apply: true });
  assert.equal(res.deletions.length, 0);
  assert.equal(res.applied, false);
}

// ── the default budget is the documented one ────────────────────────────────────────
assert.equal(DEFAULT_BUDGET_BYTES, 10 * 1024 * 1024 * 1024, '10 GiB');

assert.equal(formatBytes(0), '0B');
assert.equal(formatBytes(1024), '1.0KB');
assert.equal(formatBytes(10 * 1024 * 1024 * 1024), '10GB');
assert.equal(formatBytes(1536), '1.5KB');
