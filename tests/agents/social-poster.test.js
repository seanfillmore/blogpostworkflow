import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOnce, renderRun, readConfig } from '../../agents/social-poster/index.js';
import { newItem, saveItem, readItem, approveItem, captionProblems } from '../../lib/social-queue.js';
import { planMigration } from '../../scripts/social-queue-migrate.mjs';

const OK = 'Our body cream starts from a 7-ingredient base.\n\nLink in bio.\n\n#realskincare #bodycream';
const NOW = Date.parse('2026-10-24T18:20:00Z');
const CONFIG = { postsPerDay: 1, platforms: ['instagram', 'facebook'] };

function queue(ids) {
  const dir = mkdtempSync(join(tmpdir(), 'social-poster-'));
  ids.forEach((id, i) => {
    const it = newItem({ id, image_url: `https://cdn.shopify.com/s/files/${id}.jpg`, caption: `${id}: ${OK}` }, { now: NOW - 86_400_000 });
    saveItem(dir, approveItem(it, { now: NOW - 86_400_000 + i * 1000 }));
  });
  return dir;
}

function clients({ igFail = false, fbFail = false, igRecent = [], fbRecent = [], fbRecentThrows = false } = {}) {
  const calls = { ig: [], fb: [], insights: [] };
  return {
    calls,
    instagram: {
      recent: async () => igRecent,
      publish: async (a) => { calls.ig.push(a); if (igFail) throw new Error('ig down'); return { media_id: `m-${calls.ig.length}`, permalink: 'https://www.instagram.com/p/x/' }; },
      insights: async (id) => { calls.insights.push(['ig', id]); return { views: 10 }; },
    },
    facebook: {
      recent: async () => { if (fbRecentThrows) throw new Error('nope'); return fbRecent; },
      publish: async (a) => { calls.fb.push(a); if (fbFail) throw new Error('fb down'); return { post_id: `p_${calls.fb.length}`, photo_id: '9', permalink: 'https://www.facebook.com/x' }; },
      insights: async (id) => { calls.insights.push(['fb', id]); return { media_views: 5, reactions: 1 }; },
    },
  };
}

const quiet = () => {};

test('dry run posts nothing and writes nothing', async () => {
  const dir = queue(['a-1', 'b-1']);
  const c = clients();
  const run = await runOnce({ dir, clients: c, config: CONFIG, now: NOW, log: quiet });
  assert.equal(run.posts[0].id, 'a-1');
  assert.deepEqual(run.posts[0].results.map((r) => r.outcome), ['would-post', 'would-post']);
  assert.equal(c.calls.ig.length + c.calls.fb.length, 0);
  assert.equal(readItem(dir, 'a-1').instagram, null);
  assert.match(renderRun(run), /would post/);
});

test('apply posts the oldest approved item to both platforms, then respects posts_per_day', async () => {
  const dir = queue(['a-1', 'b-1']);
  const c = clients();
  const run = await runOnce({ apply: true, dir, clients: c, config: CONFIG, now: NOW, log: quiet });
  assert.deepEqual(run.posts[0].results.map((r) => r.outcome), ['posted', 'posted']);
  assert.equal(c.calls.ig[0].imageUrl, 'https://cdn.shopify.com/s/files/a-1.jpg');
  const a = readItem(dir, 'a-1');
  assert.equal(a.instagram.media_id, 'm-1');
  assert.equal(a.facebook.post_id, 'p_1');
  assert.equal(run.remaining, 1);
  const again = await runOnce({ apply: true, dir, clients: c, config: CONFIG, now: NOW + 3_600_000, log: quiet });
  assert.equal(again.posts.length, 0);
  assert.match(again.reason, /posts_per_day/);
});

test('IG ok + FB failed: next run retries FB only; two FB failures skip FB and report it', async () => {
  const dir = queue(['a-1', 'b-1']);
  await runOnce({ apply: true, dir, clients: clients({ fbFail: true }), config: CONFIG, now: NOW, log: quiet });
  let a = readItem(dir, 'a-1');
  assert.ok(a.instagram.posted_at);
  assert.equal(a.failures.length, 1);

  const day2 = NOW + 86_400_000;
  const c2 = clients({ fbFail: true });
  const r2 = await runOnce({ apply: true, dir, clients: c2, config: CONFIG, now: day2, log: quiet });
  assert.equal(r2.posts[0].kind, 'retry');
  assert.deepEqual(r2.posts[0].results.map((r) => r.platform), ['facebook']);
  assert.equal(r2.posts[1].id, 'b-1', 'the retry does not cost the day its new post');
  assert.equal(c2.calls.ig.length, 1, 'only b-1 went to Instagram');

  const c3 = clients();
  const r3 = await runOnce({ apply: true, dir, clients: c3, config: CONFIG, now: day2 + 86_400_000, log: quiet });
  assert.ok(r3.skipped.some((s) => s.id === 'a-1' && s.platform === 'facebook'));
  assert.ok(!c3.calls.fb.some((x) => x.imageUrl.includes('a-1')));
});

test('a caption already live on a platform is recorded as detected, never posted again', async () => {
  const dir = queue(['a-1']);
  const c = clients({ fbRecent: [`a-1: ${OK}`] });
  const run = await runOnce({ apply: true, dir, clients: c, config: CONFIG, now: NOW, log: quiet });
  assert.deepEqual(run.posts[0].results.map((r) => r.outcome), ['posted', 'detected']);
  assert.equal(c.calls.fb.length, 0);
  assert.equal(readItem(dir, 'a-1').facebook.detected, true);
});

test('unreadable recent posts on one platform: that platform waits, the other posts, no failure recorded', async () => {
  const dir = queue(['a-1']);
  const c = clients({ fbRecentThrows: true });
  const run = await runOnce({ apply: true, dir, clients: c, config: CONFIG, now: NOW, log: quiet });
  assert.deepEqual(run.posts[0].results.map((r) => r.outcome), ['posted', 'unchecked']);
  const a = readItem(dir, 'a-1');
  assert.equal(a.facebook, null);
  assert.equal(a.failures.length, 0);
});

test('insights refresh for both platforms once due', async () => {
  const dir = queue(['a-1']);
  await runOnce({ apply: true, dir, clients: clients(), config: CONFIG, now: NOW, log: quiet });
  const c = clients();
  const run = await runOnce({ apply: true, dir, clients: c, config: CONFIG, now: NOW + 25 * 3_600_000, log: quiet });
  assert.equal(run.insightsRead, 2);
  const a = readItem(dir, 'a-1');
  assert.equal(a.instagram.insights.views, 10);
  assert.equal(a.facebook.insights.reactions, 1);
});

test('config: defaults, and the cron line matches cron_utc', () => {
  const cfg = readConfig();
  assert.equal(cfg.postsPerDay, 1);
  assert.deepEqual(cfg.platforms, ['instagram', 'facebook']);
  assert.equal(cfg.pageId, '113847674946808');
  const raw = JSON.parse(readFileSync(new URL('../../config/social-queue.json', import.meta.url), 'utf8'));
  const cron = readFileSync(new URL('../../scripts/setup-cron.sh', import.meta.url), 'utf8');
  const line = cron.split('\n').find((l) => l.startsWith('DAILY_SOCIAL_POSTER='));
  assert.ok(line, 'DAILY_SOCIAL_POSTER is in setup-cron.sh');
  assert.ok(line.includes(`"${raw.cron_utc[0]} `), 'cron slot matches config');
  assert.ok(line.includes('agents/social-poster/index.js --apply'));
  assert.ok(cron.includes('\n$DAILY_SOCIAL_POSTER\n'), 'installed in the crontab body');
  assert.ok(!/ig-statics\/index\.js/.test(cron), 'the old agent is retired');
});

test('migration: 8 approved items in order; ledger posts carried over as Instagram-posted', () => {
  const { items } = JSON.parse(readFileSync(new URL('../../scripts/social-queue-migrate-ig-statics.json', import.meta.url), 'utf8'));
  assert.equal(items.length, 8);
  for (const i of items) assert.deepEqual(captionProblems(i.caption), [], i.id);
  assert.equal(new Set(items.map((i) => i.caption)).size, 8, 'captions are unique (the duplicate check keys on them)');
  const ledger = { posts: [{ id: items[0].id, media_id: '111', permalink: 'https://www.instagram.com/p/a/', posted_at: '2026-10-24T18:20:05Z' }], failures: [] };
  const plan = planMigration({ items, ledger, now: NOW });
  assert.ok(plan.every((w) => w.action === 'create' && w.item.status === 'approved'));
  const order = plan.map((w) => w.item).sort((a, b) => a.approved_at.localeCompare(b.approved_at)).map((i) => i.id);
  assert.deepEqual(order, items.map((i) => i.id));
  assert.equal(plan[0].item.instagram.media_id, '111');
  assert.equal(plan[0].item.facebook, null, 'still owes Facebook');
  assert.ok(plan.every((w) => w.item.source.startsWith('2026-10-19 Coconut Moisturizer - coconut-breeze/')));
  // Idempotent: existing items are left alone, but a missing IG post is filled in.
  const existing = { [items[0].id]: { ...plan[0].item, instagram: null }, [items[1].id]: plan[1].item };
  const again = planMigration({ items, ledger, existing, now: NOW });
  assert.equal(again[0].action, 'fill-instagram');
  assert.equal(again[1].action, 'exists');
});
