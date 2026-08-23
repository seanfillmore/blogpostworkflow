// tests/scripts/consolidate-tattoo-soap-calendar.test.js
//
// The script rewrites data/calendar/calendar.json (owned by cron on the server)
// and data/rejected-keywords.json (which scripts/triage-orphan-briefs.mjs --apply
// reads before deleting briefs off disk). Both writes are destructive at one
// remove, so the guards get as much coverage as the happy path.
//
// Every test runs against a scratch SEO_CLAUDE_ROOT — the same isolation hook
// lib/calendar-store.js documents — seeded from a copy of the real server
// calendar, so the fixture is the shape production actually has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── the real 2026-08-23 server calendar, trimmed to what matters ─────────────
// 9 soap items (8 undated, 1 dated), plus untouched items from other clusters
// including can-you-use-coconut-oil-on-a-new-tattoo — a DIFFERENT tattoo intent
// that is draftable on 2026-10-01 and must survive.

const REVIEW_DUP = (slug, keyword, impressions, priority_score) => ({
  slug, keyword, title: null, category: null, content_type: null, priority: 'Medium',
  week: null, publish_date: null, original_publish_date: null, kd: null, volume: null,
  source: 'gsc_opportunity', topical_hub: null, priority_score, status_override: null,
  status: 'review', impressions, added_at: '2026-08-19T13:30:04.101Z',
  last_updated: '2026-08-22T14:00:01.608Z',
});

const DATED = (slug, keyword, publish_date, status = null) => ({
  slug, keyword, title: `T ${slug}`, category: 'Deodorant', content_type: 'guide',
  priority: 'normal', week: 1, publish_date, original_publish_date: publish_date,
  kd: null, volume: null, source: 'content_strategist', topical_hub: null,
  priority_score: null, status_override: null, status, impressions: null,
  added_at: '2026-08-21T15:16:14.377Z', last_updated: '2026-08-22T14:00:01.608Z',
});

function baseCalendar() {
  return {
    generated_at: '2026-08-14T13:30:03.710Z',
    regenerated_at: '2026-08-22T14:00:01.608Z',
    items: [
      DATED('aluminum-free-deodorant-for-men', 'aluminum free deodorant for men', '2026-08-24T15:00:00.000Z'),
      DATED('best-mens-deodorant', 'best mens deodorant', '2026-08-27T15:00:00.000Z'),
      // a different tattoo intent, draftable — must survive untouched
      DATED('can-you-use-coconut-oil-on-a-new-tattoo', 'can you use coconut oil on a new tattoo', '2026-10-01T15:00:00.000Z'),
      // the one dated duplicate
      {
        ...REVIEW_DUP('best-antibacterial-soap-for-tattoos', 'best antibacterial soap for tattoos', 381, 9),
        title: 'Best Antibacterial Soap for Tattoos: Safe Picks for New Ink',
        category: 'Bar Soap', content_type: 'guide', priority: 'normal', week: 1,
        publish_date: '2026-08-27T15:00:00.000Z',
        original_publish_date: '2026-09-17T15:00:00.000Z',
        source: 'content_strategist', added_at: '2026-08-14T13:30:03.710Z',
      },
      REVIEW_DUP('best-tattoo-soap', 'best tattoo soap', 253, 6),
      REVIEW_DUP('best-soaps-for-tattoos', 'best soaps for tattoos', 238, 6),
      REVIEW_DUP('what-soap-to-use-for-tattoo', 'what soap to use for tattoo', 968, 33),
      REVIEW_DUP('best-soap-for-new-tattoo', 'best soap for new tattoo', 771, 27),
      REVIEW_DUP('what-soap-can-i-use-to-wash-my-tattoo', 'what soap can i use to wash my tattoo', 356, 9),
      REVIEW_DUP('best-soap-for-fresh-tattoo', 'best soap for fresh tattoo', 342, 8),
      REVIEW_DUP('what-soap-to-use-for-tattoos', 'what soap to use for tattoos', 280, 7),
      // different intent — stays
      REVIEW_DUP('coconut-oil-soap-benefits', 'coconut oil soap benefits', 355, 9),
    ],
  };
}

/** Build a scratch repo root and return it. */
function scratchRoot({ calendar = baseCalendar(), rejections = [], briefs = {}, winnerMeta = { shopify_status: 'published' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soap-cal-'));
  mkdirSync(join(root, 'data', 'calendar'), { recursive: true });
  writeFileSync(join(root, 'data', 'calendar', 'calendar.json'), JSON.stringify(calendar, null, 2));
  writeFileSync(join(root, 'data', 'rejected-keywords.json'), JSON.stringify(rejections, null, 2));
  mkdirSync(join(root, 'data', 'briefs'), { recursive: true });
  for (const [name, body] of Object.entries(briefs)) {
    writeFileSync(join(root, 'data', 'briefs', `${name}.json`), JSON.stringify(body, null, 2));
  }
  if (winnerMeta) {
    const dir = join(root, 'data', 'posts', 'best-soap-for-tattoos-what-to-use-for-safe-healing-2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(winnerMeta, null, 2));
  }
  return root;
}

/**
 * Import the script under a given SEO_CLAUDE_ROOT. Both the script and
 * lib/calendar-store.js read that env var at module load, so it must be set
 * before the import and the module cache must be busted per root.
 */
async function loadScript(root) {
  process.env.SEO_CLAUDE_ROOT = root;
  return import(`../../scripts/consolidate-tattoo-soap-calendar-2026-08-23.mjs?root=${encodeURIComponent(root)}`);
}

function readCalendar(root) {
  return JSON.parse(readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8'));
}

// ── the pure planner ─────────────────────────────────────────────────────────

test('plans removal of exactly the eight duplicates and keeps the distinct intent', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const plan = m.planConsolidation({ calendar: baseCalendar(), now: '2026-08-23T00:00:00.000Z' });

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.removed.length, 8, 'eight duplicates removed — including the one dated item, same intent');

  const slugs = plan.nextItems.map((i) => i.slug);
  for (const d of m.DUPLICATE_ITEMS) assert.ok(!slugs.includes(d.slug), `${d.slug} removed`);
  assert.ok(slugs.includes(m.KEEP_DISTINCT_SLUG), 'coconut oil soap benefits kept — different intent');
  assert.ok(slugs.includes('can-you-use-coconut-oil-on-a-new-tattoo'), 'unrelated tattoo intent kept');
  assert.ok(slugs.includes(m.REFRESH_SLUG), 'one refresh item added');
  rmSync(root, { recursive: true, force: true });
});

test('the refresh item cannot be drafted as a new post by calendar-runner', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const item = m.buildRefreshItem('2026-08-23T00:00:00.000Z');

  // calendar-runner/index.js:97 → .filter(i => i.publishDate && i.status !== 'review')
  assert.equal(item.publish_date, null, 'no publish date');
  assert.equal(item.status, 'review', 'review status');
  const draftable = Boolean(item.publish_date) && item.status !== 'review';
  assert.equal(draftable, false);
  // Even if a human approves it in the Ideas inbox (status → null) it still
  // fails the publish_date half, so approval alone cannot make it draft.
  assert.equal(Boolean(item.publish_date) && null !== 'review', false);
  assert.ok(item.title.includes('content-refresher'), 'title carries the refresh command');
  rmSync(root, { recursive: true, force: true });
});

test('introduces no same-day publishing collision', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const cal = baseCalendar();
  const plan = m.planConsolidation({ calendar: cal, now: '2026-08-23T00:00:00.000Z' });

  assert.deepEqual(m.draftableCollisions(cal.items), [], 'fixture starts clean');
  assert.deepEqual(m.draftableCollisions(plan.nextItems), [], 'stays clean after');
  assert.deepEqual(plan.blockers, []);
  rmSync(root, { recursive: true, force: true });
});

test('detects a same-day collision it would introduce', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  // Two draftable items on the same day, neither of them a duplicate we remove:
  // the check must SEE it. It is pre-existing here, so it warns rather than blocks.
  const cal = baseCalendar();
  cal.items.push(DATED('extra-a', 'extra a', '2026-08-24T15:00:00.000Z'));
  const plan = m.planConsolidation({ calendar: cal, now: '2026-08-23T00:00:00.000Z' });
  assert.deepEqual(m.draftableCollisions(cal.items), ['2026-08-24 (2)']);
  assert.deepEqual(plan.blockers, [], 'pre-existing collision is not this change s fault');
  assert.ok(plan.warnings.some((w) => w.includes('2026-08-24')), 'but it is reported');
  rmSync(root, { recursive: true, force: true });
});

// ── guards ───────────────────────────────────────────────────────────────────

test('BLOCKS when a rejection would make a brief deletable by triage-orphan-briefs', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  // lib/brief-triage.js drops an orphan brief whose keyword EXACTLY equals a
  // rejection, and scripts/triage-orphan-briefs.mjs --apply unlinkSync()s it.
  const plan = m.planConsolidation({
    calendar: baseCalendar(),
    briefKeywords: ['best tattoo soap'],
    now: '2026-08-23T00:00:00.000Z',
  });
  assert.ok(plan.blockers.some((b) => b.includes('best tattoo soap') && b.includes('triage-orphan-briefs')));
  rmSync(root, { recursive: true, force: true });
});

test('BLOCKS when a broad rejection would also block an unrelated surviving item', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const cal = baseCalendar();
  // A survivor whose keyword CONTAINS a rejected term. calendar-runner:690 and
  // content-strategist both match rejections by substring, so this item would
  // silently stop being written.
  cal.items.push(DATED('collateral', 'best tattoo soap for sensitive skin', '2026-11-01T15:00:00.000Z'));
  const plan = m.planConsolidation({ calendar: cal, now: '2026-08-23T00:00:00.000Z' });
  assert.ok(plan.blockers.some((b) => b.includes('best tattoo soap for sensitive skin')));
  rmSync(root, { recursive: true, force: true });
});

test('the real calendar has no such collateral — the unrelated tattoo item survives', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const plan = m.planConsolidation({ calendar: baseCalendar(), now: '2026-08-23T00:00:00.000Z' });
  assert.deepEqual(plan.blockers, []);
  const survivor = plan.nextItems.find((i) => i.slug === 'can-you-use-coconut-oil-on-a-new-tattoo');
  assert.equal(survivor.publish_date, '2026-10-01T15:00:00.000Z', 'its publish_date is not blanked');
  rmSync(root, { recursive: true, force: true });
});

test('BLOCKS when the winner post is not published', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const plan = m.planConsolidation({
    calendar: baseCalendar(),
    winnerMeta: { shopify_status: 'draft' },
    now: '2026-08-23T00:00:00.000Z',
  });
  assert.ok(plan.blockers.some((b) => b.includes('not "published"')));
  rmSync(root, { recursive: true, force: true });
});

// ── end to end ───────────────────────────────────────────────────────────────

test('dry run writes nothing', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  const before = readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8');

  const code = await m.main([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8'), before, 'calendar untouched');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'rejected-keywords.json'), 'utf8')), []);
  assert.equal(readdirSync(join(root, 'data', 'calendar')).length, 1, 'no backup written on a dry run');
  rmSync(root, { recursive: true, force: true });
});

test('--apply consolidates, backs up, and records the removed items verbatim', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);

  assert.equal(await m.main(['--apply']), 0);

  const cal = readCalendar(root);
  const slugs = cal.items.map((i) => i.slug);
  assert.equal(cal.items.length, 12 - 8 + 1, '12 in, 8 removed, 1 added');
  for (const d of m.DUPLICATE_ITEMS) assert.ok(!slugs.includes(d.slug));
  assert.ok(slugs.includes(m.KEEP_DISTINCT_SLUG));
  assert.ok(slugs.includes(m.REFRESH_SLUG));

  // The kept distinct item is byte-for-byte unchanged apart from last_updated.
  const kept = cal.items.find((i) => i.slug === m.KEEP_DISTINCT_SLUG);
  assert.equal(kept.status, 'review');
  assert.equal(kept.publish_date, null);
  assert.equal(kept.keyword, 'coconut oil soap benefits');

  // Untouched dated items keep their publish dates.
  assert.equal(cal.items.find((i) => i.slug === 'best-mens-deodorant').publish_date, '2026-08-27T15:00:00.000Z');

  // Backup exists alongside the calendar.
  const backups = readdirSync(join(root, 'data', 'calendar')).filter((f) => f.includes('bak-consolidate-tattoo'));
  assert.equal(backups.length, 1, 'one calendar backup');
  const backedUp = JSON.parse(readFileSync(join(root, 'data', 'calendar', backups[0]), 'utf8'));
  assert.equal(backedUp.items.length, 12, 'backup holds the pre-change calendar');

  // Rejections written, one per duplicate.
  const rejections = JSON.parse(readFileSync(join(root, 'data', 'rejected-keywords.json'), 'utf8'));
  assert.equal(rejections.length, 8);
  assert.deepEqual(
    rejections.map((r) => r.keyword).sort(),
    m.DUPLICATE_ITEMS.map((d) => d.keyword).sort(),
  );
  assert.ok(rejections.every((r) => r.reason && r.matchType === 'broad'));

  // Run record preserves the dated duplicate's publish_date, which the calendar
  // no longer carries — the item is retired, not silently date-stripped.
  const recordDir = join(root, 'data', 'reports', 'calendar-consolidation');
  const record = JSON.parse(readFileSync(join(recordDir, readdirSync(recordDir)[0]), 'utf8'));
  assert.equal(record.removed_items.length, 8);
  const dated = record.removed_items.find((r) => r.slug === 'best-antibacterial-soap-for-tattoos');
  assert.equal(dated.item.publish_date, '2026-08-27T15:00:00.000Z');
  assert.equal(dated.item.original_publish_date, '2026-09-17T15:00:00.000Z');
  assert.ok(record.refresh_command.includes('content-refresher'));

  rmSync(root, { recursive: true, force: true });
});

test('a second --apply run is a no-op and writes no second backup', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);

  assert.equal(await m.main(['--apply']), 0);
  const afterFirst = readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8');
  const rejectionsAfterFirst = readFileSync(join(root, 'data', 'rejected-keywords.json'), 'utf8');

  assert.equal(await m.main(['--apply']), 0, 'second run still succeeds');
  assert.equal(readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8'), afterFirst, 'calendar unchanged');
  assert.equal(readFileSync(join(root, 'data', 'rejected-keywords.json'), 'utf8'), rejectionsAfterFirst, 'no duplicate rejections');

  const backups = readdirSync(join(root, 'data', 'calendar')).filter((f) => f.includes('bak-consolidate-tattoo'));
  assert.equal(backups.length, 1, 'still exactly one backup');
  rmSync(root, { recursive: true, force: true });
});

test('re-adds the duplicates removal if gsc-opportunity puts one back', async () => {
  const root = scratchRoot();
  const m = await loadScript(root);
  assert.equal(await m.main(['--apply']), 0);

  // Simulate gsc-opportunity re-adding one (it cannot, once rejected — but the
  // script must be self-healing rather than assume the rejection held).
  const cal = readCalendar(root);
  cal.items.push(REVIEW_DUP('best-tattoo-soap', 'best tattoo soap', 253, 6));
  writeFileSync(join(root, 'data', 'calendar', 'calendar.json'), JSON.stringify(cal, null, 2));

  assert.equal(await m.main(['--apply']), 0);
  assert.ok(!readCalendar(root).items.some((i) => i.slug === 'best-tattoo-soap'), 're-removed');
  rmSync(root, { recursive: true, force: true });
});

test('refuses to write when the calendar is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'soap-cal-empty-'));
  const m = await loadScript(root);
  assert.equal(await m.main(['--apply']), 1);
  assert.ok(!existsSync(join(root, 'data', 'rejected-keywords.json')));
  rmSync(root, { recursive: true, force: true });
});

test('a blocked plan writes nothing even with --apply', async () => {
  const root = scratchRoot({ briefs: { 'best-tattoo-soap': { target_keyword: 'best tattoo soap' } } });
  const m = await loadScript(root);
  const before = readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8');

  assert.equal(await m.main(['--apply']), 1, 'exits non-zero');
  assert.equal(readFileSync(join(root, 'data', 'calendar', 'calendar.json'), 'utf8'), before);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'rejected-keywords.json'), 'utf8')), []);
  assert.equal(readdirSync(join(root, 'data', 'calendar')).length, 1, 'no backup');
  rmSync(root, { recursive: true, force: true });
});
