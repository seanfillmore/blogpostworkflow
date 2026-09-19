import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DROPPED_DIRNAME, RESTORED_DIRNAME, DROP_LOG_FILENAME, README_FILENAME, DROPPED_README,
  DROP_RECORD_SUFFIX, RESTORE_COMMAND,
  calendarPath, droppedDir, restoredDir, backupsDir,
  readCalendar, backupCalendar, writeCalendarItems,
  archiveItems, listDropped, restoreDropped, droppedSizeBytes, buildDropRecord, newRunId,
} from '../../lib/calendar-item-archive.js';

// data/calendar/calendar.json is the file a re-plan REPLACES — 12 of 19
// scheduled items cleared in August 2026 with eight [SKIP] lines in a cron log
// as the only record. And data/briefs/_dropped/ exists because `unlinkSync`
// destroyed three paid-for briefs on a wrong verdict. This module is those two
// lessons in the calendar's shape, and everything below pins them.

function tmpRoot(items = []) {
  const root = mkdtempSync(join(tmpdir(), 'calendar-archive-'));
  mkdirSync(join(root, 'data', 'calendar'), { recursive: true });
  writeFileSync(calendarPath(root), JSON.stringify({
    generated_at: '2026-04-08T03:46:47.858Z',
    regenerated_at: '2026-09-01T00:00:00.000Z',
    items,
  }, null, 2));
  return root;
}

const item = (slug, over = {}) => ({ slug, keyword: slug.replace(/-/g, ' '), publish_date: null, ...over });

const drop = (root, slug, over = {}) => {
  const cal = readCalendar(root);
  const it = cal.items.find((i) => i.slug === slug);
  return {
    slug, keyword: it?.keyword ?? slug, reason: 'ranked query already lands on data/posts/winner',
    item: it, index: cal.items.indexOf(it),
    match: { tier: 'exact', query: it?.keyword, slug: 'winner', page: 'https://x/blogs/news/winner', position: 4.2, impressions: 1400 },
    ...over,
  };
};

// ── archiving ───────────────────────────────────────────────────────────────

test('an archived item is MOVED, not deleted — item, sidecar, log and README all land', () => {
  const root = tmpRoot([item('a'), item('b')]);
  const runId = newRunId();
  const { archived, failed, dir } = archiveItems({ root, drops: [drop(root, 'a')], runId });

  assert.equal(failed.length, 0);
  assert.equal(archived.length, 1);
  assert.equal(dir, droppedDir(root));

  const stored = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'));
  assert.deepEqual(stored, item('a'));

  const record = JSON.parse(readFileSync(join(dir, `a${DROP_RECORD_SUFFIX}`), 'utf8'));
  assert.equal(record.slug, 'a');
  assert.equal(record.run_id, runId);
  assert.equal(record.matched_page, 'data/posts/winner');
  assert.equal(record.matched_query, 'a');
  assert.equal(record.matched_position, 4.2);
  assert.equal(record.matched_impressions, 1400);
  assert.equal(record.calendar_index, 0);
  assert.deepEqual(record.calendar_item, item('a'));
  assert.match(record.restore, new RegExp(`${RESTORE_COMMAND} a$`));

  const log = readFileSync(join(dir, DROP_LOG_FILENAME), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.equal(log[0].event, 'drop');

  assert.equal(readFileSync(join(dir, README_FILENAME), 'utf8'), DROPPED_README);
  assert.ok(droppedSizeBytes({ root }) > 0);
  rmSync(root, { recursive: true, force: true });
});

test('the README reads cold — it says nothing is deleted and how to get an item back', () => {
  assert.match(DROPPED_README, /Nothing here has been deleted/);
  assert.match(DROPPED_README, /--restore/);
  assert.match(DROPPED_README, /never\*{0,2} dropped here/i);
});

test('a repeat drop of the same slug never overwrites the earlier one', () => {
  const root = tmpRoot([item('a')]);
  archiveItems({ root, drops: [drop(root, 'a')], runId: 'r1' });
  archiveItems({ root, drops: [{ ...drop(root, 'a'), reason: 'second time' }], runId: 'r2' });
  const files = readdirSync(droppedDir(root)).filter((f) => f.endsWith('.json') && !f.endsWith(DROP_RECORD_SUFFIX));
  assert.deepEqual(files.sort(), ['a--2.json', 'a.json']);
  const dropped = listDropped({ root });
  assert.deepEqual(dropped.map((d) => d.seq), [1, 2]);
  rmSync(root, { recursive: true, force: true });
});

test('one bad item does not abandon the rest of the run half-archived', () => {
  const root = tmpRoot([item('a'), item('b')]);
  const circular = { slug: 'bad' }; circular.self = circular;
  const { archived, failed } = archiveItems({
    root,
    drops: [drop(root, 'a'), { slug: 'bad', keyword: 'bad', reason: 'x', item: circular }, drop(root, 'b')],
    runId: 'r1',
  });
  assert.deepEqual(archived.map((a) => a.slug), ['a', 'b']);
  assert.deepEqual(failed.map((f) => f.slug), ['bad']);
  rmSync(root, { recursive: true, force: true });
});

// ── the calendar write ──────────────────────────────────────────────────────

test('writeCalendarItems keeps every item it was not asked to remove, byte for byte', () => {
  // Including fields lib/calendar-store.js's normalising writeCalendar would
  // silently drop — `possible_duplicate` and `ranked_match` are exactly the
  // flags PR #921 wired into the prioritizer and the strategist.
  const flagged = item('flagged', { possible_duplicate: true, ranked_match: { tier: 'ranked_phrase', query: 'soap for tattoos' }, custom: 42 });
  const root = tmpRoot([item('a'), flagged, item('c')]);
  const cal = readCalendar(root);
  const kept = cal.items.filter((i) => i.slug !== 'a');

  writeCalendarItems({ root, calendar: cal, items: kept, runId: 'r1' });

  const after = JSON.parse(readFileSync(calendarPath(root), 'utf8'));
  assert.deepEqual(after.items, kept);
  assert.deepEqual(after.items[0], flagged);
  assert.equal(after.generated_at, cal.generated_at);
  assert.equal(after.regenerated_at, cal.regenerated_at);
  assert.equal(readdirSync(join(root, 'data', 'calendar')).filter((f) => f.endsWith('.tmp')).length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('writeCalendarItems refuses rather than leaving a broken calendar behind', () => {
  const root = tmpRoot([item('a')]);
  const cal = readCalendar(root);
  const circular = { slug: 'bad' }; circular.self = circular;
  assert.throws(() => writeCalendarItems({ root, calendar: cal, items: [circular], runId: 'r1' }), /refusing to write/);
  assert.deepEqual(JSON.parse(readFileSync(calendarPath(root), 'utf8')).items, cal.items);
  assert.equal(readdirSync(join(root, 'data', 'calendar')).filter((f) => f.endsWith('.tmp')).length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('readCalendar throws rather than guessing at a missing or shapeless file', () => {
  const root = mkdtempSync(join(tmpdir(), 'calendar-archive-'));
  assert.throws(() => readCalendar(root), /no calendar at/);
  mkdirSync(join(root, 'data', 'calendar'), { recursive: true });
  writeFileSync(calendarPath(root), JSON.stringify({ items: 'nope' }));
  assert.throws(() => readCalendar(root), /no items\[\] array/);
  rmSync(root, { recursive: true, force: true });
});

test('backupCalendar leaves a copy that nothing later removes', () => {
  const root = tmpRoot([item('a')]);
  const before = readFileSync(calendarPath(root), 'utf8');
  const path = backupCalendar({ root });
  writeCalendarItems({ root, calendar: readCalendar(root), items: [], runId: 'r1' });
  restoreDropped({ root, all: true, runId: 'r2' });
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(path.startsWith(backupsDir(root)));
  rmSync(root, { recursive: true, force: true });
});

// ── restore ─────────────────────────────────────────────────────────────────

test('archive → sweep → restore is a byte-exact round trip, item back in its own position', () => {
  const root = tmpRoot([item('a'), item('b'), item('c')]);
  const before = readFileSync(calendarPath(root), 'utf8');
  const cal = readCalendar(root);

  const { archived } = archiveItems({ root, drops: [drop(root, 'b')], runId: 'r1' });
  writeCalendarItems({ root, calendar: cal, items: cal.items.filter((i) => i.slug !== 'b'), runId: 'r1' });
  assert.deepEqual(JSON.parse(readFileSync(calendarPath(root), 'utf8')).items.map((i) => i.slug), ['a', 'c']);
  assert.equal(archived.length, 1);

  const res = restoreDropped({ root, slugs: ['b'], runId: 'r2' });
  assert.deepEqual(res.restored.map((r) => r.slug), ['b']);
  assert.equal(readFileSync(calendarPath(root), 'utf8'), before);

  // The archived copy moved aside; the record stayed as the audit trail.
  assert.ok(!existsSync(join(droppedDir(root), 'b.json')));
  assert.ok(existsSync(join(restoredDir(root), 'b.json')));
  assert.ok(existsSync(join(droppedDir(root), `b${DROP_RECORD_SUFFIX}`)));
  assert.equal(listDropped({ root }).length, 0);

  const log = readFileSync(join(droppedDir(root), DROP_LOG_FILENAME), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((l) => l.event), ['drop', 'restore']);
  rmSync(root, { recursive: true, force: true });
});

test('several items restored together land back in their original order', () => {
  const root = tmpRoot([item('a'), item('b'), item('c'), item('d')]);
  const before = readFileSync(calendarPath(root), 'utf8');
  const cal = readCalendar(root);
  archiveItems({ root, drops: [drop(root, 'c'), drop(root, 'a')], runId: 'r1' });
  writeCalendarItems({ root, calendar: cal, items: cal.items.filter((i) => !['a', 'c'].includes(i.slug)), runId: 'r1' });

  restoreDropped({ root, all: true, runId: 'r2' });
  assert.equal(readFileSync(calendarPath(root), 'utf8'), before);
  rmSync(root, { recursive: true, force: true });
});

test('restore refuses to clobber an item already on the calendar, unless forced', () => {
  const root = tmpRoot([item('a')]);
  const cal = readCalendar(root);
  archiveItems({ root, drops: [drop(root, 'a')], runId: 'r1' });
  // the item is deliberately still on the calendar — the shape a failed
  // calendar write leaves behind
  const res = restoreDropped({ root, slugs: ['a'], runId: 'r2' });
  assert.equal(res.restored.length, 0);
  assert.match(res.skipped[0].reason, /already on the calendar/);
  assert.deepEqual(JSON.parse(readFileSync(calendarPath(root), 'utf8')).items, cal.items);

  const forced = restoreDropped({ root, slugs: ['a'], force: true, runId: 'r3' });
  assert.equal(forced.restored.length, 1);
  assert.equal(JSON.parse(readFileSync(calendarPath(root), 'utf8')).items.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('restoring a slug that was never archived is reported, not invented', () => {
  const root = tmpRoot([item('a')]);
  const res = restoreDropped({ root, slugs: ['never-dropped'], runId: 'r1' });
  assert.equal(res.restored.length, 0);
  assert.match(res.skipped[0].reason, new RegExp(DROPPED_DIRNAME));
  rmSync(root, { recursive: true, force: true });
});

test('restore takes the NEWEST drop of a slug that was dropped twice', () => {
  const root = tmpRoot([item('a')]);
  const cal = readCalendar(root);
  archiveItems({ root, drops: [drop(root, 'a')], runId: 'r1' });
  archiveItems({ root, drops: [{ ...drop(root, 'a'), item: item('a', { keyword: 'the newer one' }) }], runId: 'r2' });
  writeCalendarItems({ root, calendar: cal, items: [], runId: 'r2' });

  restoreDropped({ root, slugs: ['a'], runId: 'r3' });
  const [restored] = JSON.parse(readFileSync(calendarPath(root), 'utf8')).items;
  assert.equal(restored.keyword, 'the newer one');
  rmSync(root, { recursive: true, force: true });
});

test('buildDropRecord records the evidence verbatim, not a summary of it', () => {
  const match = { tier: 'exact', query: 'q', slug: 'winner', position: 4.2, impressions: 1400, clicks: 12 };
  const rec = buildDropRecord({ slug: 'a', keyword: 'q', reason: 'why', item: item('a'), match, archivedFile: 'a.json', runId: 'r1' });
  assert.deepEqual(rec.evidence, match);
  assert.match(rec.note, /MOVED here, not deleted/);
});

test('nothing in this module deletes a calendar item from disk', () => {
  const src = readFileSync(new URL('../../lib/calendar-item-archive.js', import.meta.url), 'utf8');
  // `unlinkSync` appears exactly twice: the EXDEV fallback inside movePath, and
  // the temp-file cleanup in writeCalendarItems. Neither can remove an archived
  // item or the calendar itself.
  assert.equal((src.match(/unlinkSync\(/g) || []).length, 2);
  assert.ok(!/rmSync|rmdirSync/.test(src));
});
