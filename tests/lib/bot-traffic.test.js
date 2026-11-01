import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_EVENTS_PATH,
  contaminatedDays,
  dayOf,
  exclusionLine,
  loadBotTrafficEvents,
  partitionSnapshotDays,
} from '../../lib/bot-traffic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EVENTS = [
  { id: 'a', affects: ['ga4', 'rum'], ga4_days: ['2026-09-14'] },
  { id: 'b', affects: ['rum'], ga4_days: [] },
];
const stub = (events) => () => ({ available: true, events, reason: null });

test('the shipped config parses and declares the wave we measured', () => {
  const loaded = loadBotTrafficEvents();
  assert.equal(loaded.available, true);
  assert.ok(loaded.events.length >= 2);
  const days = contaminatedDays(loaded.events, 'ga4');
  assert.ok(days.has('2026-09-14'), 'the 2026-09-15 UTC wave lands on the 2026-09-14 GA4 day');
});

test('every declared event carries evidence and a non-size identifier', () => {
  // The whole reason this is a list and not a threshold. An entry that cannot say
  // what identified it — other than being big — must not be here: the real paid
  // campaign ran at 3.5x-15x the median day.
  const { events } = loadBotTrafficEvents();
  for (const e of events) {
    assert.ok(e.id, 'every event needs an id');
    assert.ok(Array.isArray(e.evidence) && e.evidence.length, `${e.id} needs evidence`);
    assert.ok(e.not_excluded_because_of_size, `${e.id} must name a non-size identifier`);
    assert.ok(Array.isArray(e.affects) && e.affects.length, `${e.id} must say what it affects`);
  }
});

test('the paid giveaway campaign is NOT excluded', () => {
  // 2026-08-19 -> 08-29 ran at 3.5x-15x the median day and was real paid traffic.
  // If a future edit ever lists one of these, this fails.
  const days = contaminatedDays(loadBotTrafficEvents().events, 'ga4');
  for (const d of ['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25', '2026-08-28', '2026-08-29']) {
    assert.equal(days.has(d), false, `${d} is real paid campaign traffic and must stay in`);
  }
});

test('a dataset only gets the days declared for it', () => {
  assert.deepEqual([...contaminatedDays(EVENTS, 'ga4')], ['2026-09-14']);
  assert.deepEqual([...contaminatedDays(EVENTS, 'clarity')], [], 'an undeclared dataset excludes nothing');
});

test('a window alone never implies a day — the UTC/Pacific conversion is explicit', () => {
  const windowOnly = [{ id: 'x', affects: ['ga4'], window_utc: { start: '2026-09-15T03:59:00Z', end: '2026-09-15T06:49:00Z' } }];
  assert.equal(contaminatedDays(windowOnly, 'ga4').size, 0);
});

test('partitionSnapshotDays splits filenames and keeps everything else', () => {
  const files = ['2026-09-13.json', '2026-09-14.json', '2026-09-15.json'];
  const r = partitionSnapshotDays(files, { dataset: 'ga4', load: stub(EVENTS) });
  assert.deepEqual(r.kept, ['2026-09-13.json', '2026-09-15.json']);
  assert.deepEqual(r.excluded, ['2026-09-14.json']);
});

test('a file whose day cannot be read is KEPT, not dropped', () => {
  const r = partitionSnapshotDays(['latest.json', 'garbage', '2026-09-14.json'], { dataset: 'ga4', load: stub(EVENTS) });
  assert.deepEqual(r.kept, ['latest.json', 'garbage']);
  assert.deepEqual(r.excluded, ['2026-09-14.json']);
});

test('it FAILS OPEN — an unreadable or malformed config excludes nothing', () => {
  const files = ['2026-09-14.json'];
  for (const load of [
    () => ({ available: false, events: [], reason: 'config not readable (ENOENT)' }),
    () => ({ available: false, events: [], reason: 'config is not valid JSON' }),
    () => ({ available: false, events: [], reason: 'config has no events array' }),
  ]) {
    const r = partitionSnapshotDays(files, { dataset: 'ga4', load });
    assert.deepEqual(r.kept, files, 'nothing may be excluded when the record is unavailable');
    assert.equal(r.excluded.length, 0);
    assert.match(exclusionLine(r), /exclusions are OFF/, 'and it must SAY it is off');
  }
});

test('loading a missing file does not throw', () => {
  const r = loadBotTrafficEvents({ path: join(ROOT, 'config', 'does-not-exist.json') });
  assert.equal(r.available, false);
  assert.match(r.reason, /not readable/);
  assert.deepEqual(r.events, []);
});

test('loading a malformed file does not throw', () => {
  const r = loadBotTrafficEvents({ path: join(ROOT, 'package.json') }); // valid JSON, no events array
  assert.equal(r.available, false);
  assert.match(r.reason, /no events array/);
});

test('partitionSnapshotDays never throws on junk input', () => {
  assert.deepEqual(partitionSnapshotDays(undefined, { load: stub(EVENTS) }).kept, []);
  assert.deepEqual(partitionSnapshotDays('not an array', { load: stub(EVENTS) }).excluded, []);
  assert.equal(partitionSnapshotDays([null, 42], { load: stub(EVENTS) }).kept.length, 2);
});

test('dayOf reads a day out of a filename or returns null', () => {
  assert.equal(dayOf('2026-09-14.json'), '2026-09-14');
  assert.equal(dayOf('2026-09-14'), '2026-09-14');
  assert.equal(dayOf('latest.json'), null);
  assert.equal(dayOf(undefined), null);
});

test('exclusionLine names the days it skipped, and says so when it skipped none', () => {
  const r = partitionSnapshotDays(['2026-09-14.json', '2026-09-15.json'], { dataset: 'ga4', load: stub(EVENTS) });
  assert.match(exclusionLine(r), /skipped 1 ga4 day\(s\)/);
  assert.match(exclusionLine(r), /2026-09-14/);
  const none = partitionSnapshotDays(['2026-09-15.json'], { dataset: 'ga4', load: stub(EVENTS) });
  assert.match(exclusionLine(none), /none applied/);
});

test('Clarity declares its OWN day, and it is not the GA4 day', () => {
  // Clarity buckets by UTC and GA4 by Pacific, so the same 03:59Z-06:49Z wave
  // lands on 09-15 in one and 09-14 in the other. Getting this wrong excludes a
  // clean day and keeps the dirty one — which is why a window never implies a day.
  const { events } = loadBotTrafficEvents();
  const ga4 = contaminatedDays(events, 'ga4');
  const clarity = contaminatedDays(events, 'clarity');
  assert.ok(clarity.has('2026-09-15'), 'the Clarity wave is on the UTC day');
  assert.ok(ga4.has('2026-09-14'), 'the GA4 wave is on the Pacific day');
  assert.equal(clarity.has('2026-09-14'), false, 'the GA4 day must not leak into Clarity');
  assert.equal(ga4.has('2026-09-15'), false, 'the Clarity day must not leak into GA4');
});

test('NO event may ever declare shopify days — bots buy nothing', () => {
  // Shopify snapshots are ORDERS. The two wave days carry one real order each
  // ($130.90, $9.35), so excluding either deletes real revenue to remove zero
  // contamination — and order data feeds the $0-cluster gate that pauses spend.
  const { events } = loadBotTrafficEvents();
  for (const e of events) {
    assert.equal(e.shopify_days, undefined, `${e.id} must not declare shopify_days`);
    assert.equal((e.affects || []).includes('shopify'), false, `${e.id} must not affect shopify`);
  }
  assert.equal(contaminatedDays(events, 'shopify').size, 0);
});

test('cro-analyzer opts Clarity in and leaves Shopify alone', () => {
  const src = readFileSync(join(ROOT, 'agents/cro-analyzer/index.js'), 'utf8');
  assert.match(src, /CLARITY_DIR, 7, \{ dataset: 'clarity' \}/, 'Clarity must be gated');
  assert.doesNotMatch(src, /SHOPIFY_DIR[^)]*dataset/, 'Shopify must NOT be gated');
});

test('the single-file picker in cro-deep-dive-content is gated', () => {
  // It reads exactly ONE snapshot, so a bot day is the whole analysis.
  const src = readFileSync(join(ROOT, 'agents/cro-deep-dive-content/index.js'), 'utf8');
  assert.match(src, /from '\.\.\/\.\.\/lib\/bot-traffic\.js'/);
  assert.match(src, /mostRecentFile\(CLARITY_DIR, \{ dataset: 'clarity' \}\)/);
});

test('the three wired consumers read the exclusions, and commercial-cvr does NOT', () => {
  // A source scan: importing these agents runs them. commercial-cvr already
  // excludes the whole giveaway funnel by landing page, so adding this there
  // would exclude the same sessions twice.
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');
  for (const p of [
    'agents/ga4-content-analyzer/index.js',
    'agents/device-weights/index.js',
    'agents/cro-analyzer/index.js',
  ]) {
    assert.match(read(p), /from '\.\.\/\.\.\/lib\/bot-traffic\.js'/, `${p} must import the shared record`);
    assert.match(read(p), /partitionSnapshotDays/, `${p} must apply it`);
  }
  assert.doesNotMatch(read('lib/commercial-cvr.js'), /bot-traffic\.js/,
    'commercial-cvr excludes the giveaway funnel already — a second exclusion would double-count');
});
