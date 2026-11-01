import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// `writeCalendar` REBUILT every item as a fresh object literal over 19 named
// fields, so anything else a producer set was destroyed on write. Measured on
// production: 0 of 45 calendar items carried `possible_duplicate`, and
// `agents/pipeline-prioritizer`'s `Boolean(it.possible_duplicate)` read —
// commented as "carried into the backlog so the demotion holds on every later
// run" — therefore always saw `false`. Same shape as the `meta.json` allowlist
// bug CLAUDE.md records, in a second file.
//
// Everything below pins BOTH halves: unknown fields survive, and the 19 owned
// fields keep their exact prior normalisation and fallbacks.

// lib/calendar-store.js resolves its paths from SEO_CLAUDE_ROOT at MODULE LOAD,
// so each case needs the env var set before a cache-busted import.
async function withStore(fn, { seed = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'calendar-store-'));
  mkdirSync(join(root, 'data', 'calendar'), { recursive: true });
  if (seed) writeFileSync(join(root, 'data', 'calendar', 'calendar.json'), JSON.stringify(seed, null, 2));
  const prev = process.env.SEO_CLAUDE_ROOT;
  process.env.SEO_CLAUDE_ROOT = root;
  try {
    const store = await import(`../../lib/calendar-store.js?t=${Date.now()}-${Math.random()}`);
    return await fn({ store, root, read: () => JSON.parse(readFileSync(store.CALENDAR_JSON_PATH, 'utf8')) });
  } finally {
    if (prev === undefined) delete process.env.SEO_CLAUDE_ROOT; else process.env.SEO_CLAUDE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

const seeded = (items) => ({ generated_at: '2026-04-08T03:46:47.858Z', regenerated_at: '2026-09-01T00:00:00.000Z', items });

// ── preserve-by-default ─────────────────────────────────────────────────────

test('an unknown field a producer sets survives a writeCalendar round trip', () => withStore(async ({ store, read }) => {
  store.writeCalendar({
    items: [{
      slug: 'soap-for-tattoos', keyword: 'soap for tattoos',
      // Seven fields real producers set today, none of them in the 19.
      possible_duplicate: true,
      ranked_match: { tier: 'ranked_phrase', query: 'soap for tattoos', position: 4.2 },
      duplicate_tier: 'ranked_phrase',
      duplicate_of: 'best-soap-for-tattoos',
      validation_source: 'amazon',
      search_intent: 'commercial',
      task_type: 'refresh',
    }],
  });

  const [item] = read().items;
  assert.equal(item.possible_duplicate, true);
  assert.deepEqual(item.ranked_match, { tier: 'ranked_phrase', query: 'soap for tattoos', position: 4.2 });
  assert.equal(item.duplicate_tier, 'ranked_phrase');
  assert.equal(item.duplicate_of, 'best-soap-for-tattoos');
  assert.equal(item.validation_source, 'amazon');
  assert.equal(item.search_intent, 'commercial');
  assert.equal(item.task_type, 'refresh');
}));

test('THE REGRESSION: possible_duplicate: true round-trips and still reads true', () => withStore(async ({ store, read }) => {
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a', possible_duplicate: true }] });
  // This is verbatim what agents/pipeline-prioritizer does with a backlog item.
  assert.equal(Boolean(read().items[0].possible_duplicate), true);
}));

test('an unknown field survives upsertItem too', () => withStore(async ({ store, read }) => {
  store.upsertItem({ slug: 'a', keyword: 'a', possible_duplicate: true, ranked_match: { tier: 'exact' } });
  assert.equal(read().items[0].possible_duplicate, true);

  // And an update through the same path does not strip it back off.
  store.upsertItem({ slug: 'a', keyword: 'a', priority: 'High' });
  const after = read().items[0];
  assert.equal(after.possible_duplicate, true);
  assert.deepEqual(after.ranked_match, { tier: 'exact' });
  assert.equal(after.priority, 'High');
}));

test('a field present ONLY on the stored item is not lost by a partial write', () => withStore(async ({ store, read }) => {
  // agents/pipeline-prioritizer's promote step passes four fields and nothing
  // else; going through writeCalendar directly must not erase the rest.
  store.writeCalendar({ items: [{ slug: 'a', publish_date: '2026-10-01T08:00:00-07:00' }] });
  const after = read().items[0];
  assert.equal(after.possible_duplicate, true, 'stored-only flag survived a caller that never knew about it');
  assert.equal(after.validation_source, 'amazon');
}, { seed: seeded([{ slug: 'a', keyword: 'a', possible_duplicate: true, validation_source: 'amazon' }]) }));

test('an explicit value on the incoming item WINS over the stored one, including false and null', () => withStore(async ({ store, read }) => {
  // How a producer CLEARS a flag: gsc-opportunity stamps
  // `possible_duplicate: Boolean(r.possible_duplicate)`, which is often `false`.
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a', possible_duplicate: false, ranked_match: null }] });
  const after = read().items[0];
  assert.equal(after.possible_duplicate, false);
  assert.equal(after.ranked_match, null);
}, { seed: seeded([{ slug: 'a', keyword: 'a', possible_duplicate: true, ranked_match: { tier: 'exact' } }]) }));

test('preserve_metadata: false reads no prev at all, for unknown fields as well as known ones', () => withStore(async ({ store, read }) => {
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a' }], preserve_metadata: false });
  const after = read().items[0];
  assert.equal('possible_duplicate' in after, false, 'nothing is carried across when preservation is off');
  assert.equal(after.source, 'gap_report', 'and the known fields fall back to their defaults, not to prev');
}, { seed: seeded([{ slug: 'a', keyword: 'a', possible_duplicate: true, source: 'quick_win' }]) }));

test('a normalised value can never be shadowed by a raw one', () => withStore(async ({ store, read }) => {
  const before = new Date().toISOString();
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a', last_updated: '2020-01-01T00:00:00.000Z' }] });
  const after = read().items[0];
  assert.ok(after.last_updated >= before, 'writeCalendar owns last_updated and stamps it now');

  // The camelCase input spellings are consumed by the normaliser, so neither is
  // left behind as a second, un-normalised copy of a field just written.
  store.writeCalendar({ items: [{ slug: 'b', keyword: 'b', contentType: 'Blog Post — TOF', publishDate: '2026-10-01T08:00:00-07:00' }] });
  const b = read().items.find((i) => i.slug === 'b');
  assert.equal(b.content_type, 'Blog Post — TOF');
  assert.equal(b.publish_date, new Date('2026-10-01T08:00:00-07:00').toISOString());
  assert.equal('contentType' in b, false);
  assert.equal('publishDate' in b, false);
}));

// ── the 19 owned fields keep their exact prior behaviour ────────────────────

test('defaults and null-coercion on the owned fields are unchanged', () => withStore(async ({ store, read }) => {
  const before = new Date().toISOString();
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a' }] });
  const it = read().items[0];
  assert.equal(it.title, null);
  assert.equal(it.category, null);
  assert.equal(it.content_type, null);
  assert.equal(it.priority, 'Medium');
  assert.equal(it.week, null);
  assert.equal(it.publish_date, null);
  assert.equal(it.original_publish_date, null);
  assert.equal(it.kd, null);
  assert.equal(it.volume, null);
  assert.equal(it.source, 'gap_report');
  assert.equal(it.topical_hub, null);
  assert.equal(it.priority_score, null);
  assert.equal(it.status_override, null);
  assert.equal(it.status, null);
  assert.equal(it.impressions, null);
  assert.ok(it.added_at >= before);
  assert.ok(it.last_updated >= before);
}));

test('original_publish_date and added_at are preserved from the stored item', () => withStore(async ({ store, read }) => {
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a', publish_date: '2026-12-25T08:00:00.000Z' }] });
  const it = read().items[0];
  assert.equal(it.publish_date, '2026-12-25T08:00:00.000Z', 'the move itself lands');
  assert.equal(it.original_publish_date, '2026-04-15T15:00:00.000Z', 'but the original is held');
  assert.equal(it.added_at, '2026-04-08T00:00:00.000Z');
}, {
  seed: seeded([{
    slug: 'a', keyword: 'a',
    publish_date: '2026-04-15T15:00:00.000Z', original_publish_date: '2026-04-15T15:00:00.000Z',
    added_at: '2026-04-08T00:00:00.000Z',
  }]),
}));

test('source, topical_hub, priority_score, status_override, status and impressions fall back to prev', () => withStore(async ({ store, read }) => {
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a' }] });
  const it = read().items[0];
  assert.equal(it.source, 'quick_win');
  assert.equal(it.topical_hub, 'soap');
  assert.equal(it.priority_score, 85);
  assert.equal(it.status_override, 'rush');
  assert.equal(it.status, 'review');
  assert.equal(it.impressions, 1400);
}, {
  seed: seeded([{
    slug: 'a', keyword: 'a', source: 'quick_win', topical_hub: 'soap',
    priority_score: 85, status_override: 'rush', status: 'review', impressions: 1400,
  }]),
}));

test('status is cleared when the item carries the key explicitly, prev notwithstanding', () => withStore(async ({ store, read }) => {
  // `'status' in item` — the approve route sends `status: null` to take an idea
  // out of review, and a `??` fallback would have silently put it back.
  store.writeCalendar({ items: [{ slug: 'a', keyword: 'a', status: null }] });
  assert.equal(read().items[0].status, null);
}, { seed: seeded([{ slug: 'a', keyword: 'a', status: 'review' }]) }));
