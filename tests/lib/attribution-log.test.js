import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAttribution, readAttribution, buildProductionRecords, dedupeAgainst, PRODUCTION_STATUSES } from '../../lib/attribution-log.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'attr-'));
  return { path: join(dir, 'attribution.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('appendAttribution creates the file and writes one line per record', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([
      { ts: 't1', date: '2026-06-14', slug: 'a', keyword: 'a', signal_type: 'unmapped', strength: 5000, score: 40, action: 'inject', cluster: null },
      { ts: 't1', date: '2026-06-14', slug: 'b', keyword: 'b', signal_type: 'rank_drop', strength: 8, score: 24, action: 'promote', cluster: 'deodorant' },
    ], { path });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).slug, 'a');
  } finally { cleanup(); }
});

test('appendAttribution appends (does not overwrite) on a second call', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([{ slug: 'a', signal_type: 'unmapped' }], { path });
    appendAttribution([{ slug: 'b', signal_type: 'ai_gap' }], { path });
    assert.equal(readAttribution(path).length, 2);
  } finally { cleanup(); }
});

test('appendAttribution with empty array writes nothing / no error', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([], { path });
    assert.deepEqual(readAttribution(path), []);
  } finally { cleanup(); }
});

test('readAttribution returns [] for a missing file and skips malformed lines', () => {
  const { path, cleanup } = tmpFile();
  try {
    assert.deepEqual(readAttribution(join(path, 'nope.jsonl')), []);
    writeFileSync(path, '{"slug":"ok"}\nNOT JSON\n{"slug":"ok2"}\n');
    assert.deepEqual(readAttribution(path).map((r) => r.slug), ['ok', 'ok2']);
  } finally { cleanup(); }
});

// ── Production-entry attribution (fix/prioritizer-attribution-ledger) ─────────
// Context: the ledger only ever fired on `inject` / `promote`. In steady state the
// buffer is stocked and recurring keywords are already covered, so BOTH are ~never
// emitted — 1 record in 78 days on production — and `priority-tuner` (totalFloor 8,
// minSamplesPerSignal 3) is permanently no-op. These pin the broadened logging.

test('buildProductionRecords emits one record per contributing signal for items in production', () => {
  const scored = [
    { slug: 'vegan-soap', keyword: 'vegan soap', cluster: 'soap',
      contributing: [{ type: 'unmapped', strength: 900, score: 9 }, { type: 'revenue_cluster', strength: 62, score: 12 }] },
    { slug: 'still-an-idea', keyword: 'idea', cluster: null,
      contributing: [{ type: 'unmapped', strength: 700, score: 7 }] },
  ];
  const statusBySlug = new Map([['vegan-soap', 'briefed'], ['still-an-idea', 'pending']]);
  const recs = buildProductionRecords({ scored, statusBySlug, today: '2026-08-31', nowIso: 'T' });

  assert.equal(recs.length, 2, 'only the in-production item is logged, once per signal');
  assert.deepEqual(recs.map((r) => r.signal_type).sort(), ['revenue_cluster', 'unmapped']);
  assert.equal(recs[0].action, 'production');
  assert.equal(recs[0].slug, 'vegan-soap');
  assert.equal(recs[0].cluster, 'soap');
  assert.ok(recs.every((r) => r.date === '2026-08-31' && r.ts === 'T'));
});

test('buildProductionRecords ignores a pending item even when signals contribute', () => {
  const scored = [{ slug: 'p', keyword: 'p', contributing: [{ type: 'ai_gap', strength: 1, score: 12 }] }];
  const recs = buildProductionRecords({ scored, statusBySlug: new Map([['p', 'pending']]), today: 'd', nowIso: 't' });
  assert.deepEqual(recs, [], 'a backlog idea is not yet evidence of anything');
});

test('buildProductionRecords skips an item with no contributing signals', () => {
  const scored = [{ slug: 'organic', keyword: 'o', contributing: [] }];
  const recs = buildProductionRecords({ scored, statusBySlug: new Map([['organic', 'written']]), today: 'd', nowIso: 't' });
  assert.deepEqual(recs, [], 'no signal caused it, so it is not attributable');
});

test('THE DAILY-DUPLICATE BUG: dedupeAgainst suppresses records already in the ledger', () => {
  // The agent runs daily. Without this, the same 7 briefed items are appended every
  // morning and the tuner reads one post as ~78 independent samples.
  const existing = [
    { slug: 'vegan-soap', signal_type: 'unmapped', action: 'production' },
    { slug: 'vegan-soap', signal_type: 'revenue_cluster', action: 'production' },
  ];
  const candidates = [
    { slug: 'vegan-soap', signal_type: 'unmapped', action: 'production' },      // dup
    { slug: 'vegan-soap', signal_type: 'revenue_cluster', action: 'production' }, // dup
    { slug: 'homemade-soap', signal_type: 'unmapped', action: 'production' },   // new
  ];
  const fresh = dedupeAgainst(candidates, existing);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].slug, 'homemade-soap');
});

test('dedupeAgainst also dedupes WITHIN one batch', () => {
  const candidates = [
    { slug: 'a', signal_type: 'unmapped', action: 'production' },
    { slug: 'a', signal_type: 'unmapped', action: 'production' },
  ];
  assert.equal(dedupeAgainst(candidates, []).length, 1);
});

test('dedupeAgainst keeps the SAME slug+signal under a DIFFERENT action', () => {
  // inject → promote → production are three real, separately-meaningful events.
  const existing = [{ slug: 'a', signal_type: 'unmapped', action: 'inject' }];
  const candidates = [
    { slug: 'a', signal_type: 'unmapped', action: 'promote' },
    { slug: 'a', signal_type: 'unmapped', action: 'production' },
    { slug: 'a', signal_type: 'unmapped', action: 'inject' }, // dup of existing
  ];
  const fresh = dedupeAgainst(candidates, existing);
  assert.deepEqual(fresh.map((r) => r.action).sort(), ['production', 'promote']);
});

test('dedupeAgainst tolerates a malformed/empty existing ledger', () => {
  const c = [{ slug: 'a', signal_type: 'unmapped', action: 'production' }];
  assert.equal(dedupeAgainst(c, []).length, 1);
  assert.equal(dedupeAgainst(c, null).length, 1);
  assert.equal(dedupeAgainst(c, undefined).length, 1);
});

test('REAL PRODUCTION SHAPE (2026-08-31): 7 briefed + 16 pending → only the 7 are logged, and a second run adds nothing', () => {
  // Mirrors the live calendar the day this was built: 25 items, 7 of them `briefed`
  // with real publish_dates, the rest pending backlog. This is the steady state in
  // which the OLD code logged nothing at all.
  const briefed = ['scent-free-deodorant', 'best-fragrance-free-lotion', 'vegan-soap',
    'soap-making', 'vaseline-lip-balm', 'homemade-soap', 'glycerin-free-toothpaste'];
  const pending = ['coconut-oil-as-deodorant', 'toothpaste-sls-free', 'toothpaste-no-sls',
    'is-colgate-sls-free', 'best-soap-for-tattoos-refresh'];

  const statusBySlug = new Map([
    ...briefed.map((s) => [s, 'briefed']),
    ...pending.map((s) => [s, 'pending']),
  ]);
  const scored = [...briefed, ...pending].map((slug) => ({
    slug, keyword: slug.replace(/-/g, ' '), cluster: null,
    contributing: [{ type: 'unmapped', strength: 900, score: 9 }],
  }));

  const day1 = buildProductionRecords({ scored, statusBySlug, today: '2026-08-31', nowIso: 'T1' });
  assert.equal(day1.length, 7, 'exactly the in-production items');
  assert.deepEqual(day1.map((r) => r.slug).sort(), [...briefed].sort());

  const ledger = dedupeAgainst(day1, []);
  assert.equal(ledger.length, 7, 'first run writes all 7 — the tuner finally has samples');

  // Tomorrow: same calendar, nothing changed. Must add ZERO.
  const day2 = buildProductionRecords({ scored, statusBySlug, today: '2026-09-01', nowIso: 'T2' });
  assert.equal(dedupeAgainst(day2, ledger).length, 0, 'no daily duplicates');

  // A post advances briefed → written: still one record, not a second.
  statusBySlug.set('vegan-soap', 'written');
  const day3 = buildProductionRecords({ scored, statusBySlug, today: '2026-09-02', nowIso: 'T3' });
  assert.equal(dedupeAgainst(day3, ledger).length, 0, 'advancing status is not a new sample');
});

test('crosses priority-tuner floors: 7 records clears totalFloor 8 within two ship cycles', () => {
  // config totalFloor = 8, minSamplesPerSignal = 3. One steady-state day now yields 7.
  const statusBySlug = new Map();
  const scored = [];
  for (let i = 0; i < 7; i++) {
    statusBySlug.set('s' + i, 'briefed');
    scored.push({ slug: 's' + i, keyword: 'k' + i, contributing: [{ type: 'unmapped', strength: 900, score: 9 }] });
  }
  const recs = buildProductionRecords({ scored, statusBySlug, today: 'd', nowIso: 't' });
  assert.equal(recs.length, 7);
  assert.ok(recs.filter((r) => r.signal_type === 'unmapped').length >= 3, 'clears minSamplesPerSignal');
});
