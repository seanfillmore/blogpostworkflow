import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captionProblems, alreadyPosted, newItem, editCaption, approveItem, unapproveItem, rejectItem,
  postingOrder, planRun, nextInRotation, insightsDue, loadItems, saveItem, readItem, updateItem, ID_RE, MAX_PLATFORM_FAILURES,
} from '../../lib/social-queue.js';

const OK = 'Our body cream starts from a 7-ingredient base.\n\nLink in bio.\n\n#realskincare #bodycream';
const NOW = Date.parse('2026-10-24T18:20:00Z');
const item = (id, over = {}) => ({
  ...newItem({ id, image_url: `https://cdn.shopify.com/s/files/${id}.jpg`, caption: `${id}: ${OK}` }, { now: NOW - 86_400_000 }),
  ...over,
});
const approved = (id, at, over = {}) => item(id, { status: 'approved', approved_at: at, ...over });

test('captionProblems: clean passes; dashes, links, missing hashtag/CTA and claims are refused', () => {
  assert.deepEqual(captionProblems(OK), []);
  assert.ok(captionProblems(`${OK} — nice`).some((p) => /dash/.test(p)));
  assert.ok(captionProblems(`${OK} https://x.co`).some((p) => /link/.test(p)));
  assert.ok(captionProblems('Link in bio. #bodycream').some((p) => /#realskincare/.test(p)));
  assert.ok(captionProblems('Nice cream. #realskincare').some((p) => /link in bio/.test(p)));
  assert.ok(captionProblems(`Heals eczema fast. ${OK}`).some((p) => /claim/.test(p)));
  assert.deepEqual(captionProblems(''), ['empty caption']);
});

test('alreadyPosted ignores case and whitespace', () => {
  assert.equal(alreadyPosted(OK, [`  ${OK.toUpperCase().replace(/\n/g, ' ')} `]), true);
  assert.equal(alreadyPosted(OK, ['something else']), false);
  assert.equal(alreadyPosted('', ['']), false);
});

test('newItem validates id and image host, strips dashes, starts pending', () => {
  assert.throws(() => newItem({ id: '../x', image_url: 'https://cdn.shopify.com/a.jpg' }), /slug/);
  assert.throws(() => newItem({ id: 'abc-1', image_url: 'https://evil.example/a.jpg' }), /cdn.shopify.com/);
  const i = newItem({ id: 'abc-1', image_url: 'https://cdn.shopify.com/a.jpg', suggested_caption: `Soft — smooth. ${OK}` });
  assert.equal(i.status, 'pending');
  assert.ok(!/[—–]/.test(i.caption));
  assert.equal(i.caption, i.suggested_caption);
  assert.equal(i.instagram, null);
  assert.ok(ID_RE.test('2026-10-19-coconut-moisturizer-coconut-breeze-c1-aurora-sky'));
});

test('approve refuses a failing caption; edit, unapprove and reject follow the rules', () => {
  const bad = item('bad-1', { caption: 'no cta here #realskincare' });
  assert.throws(() => approveItem(bad), (e) => Array.isArray(e.problems) && e.problems.length > 0);
  const a = approveItem(item('good-1'), { now: NOW });
  assert.equal(a.status, 'approved');
  assert.equal(a.approved_at, new Date(NOW).toISOString());
  assert.throws(() => approveItem(a), /not pending/);
  const back = editCaption(a, 'cures eczema #realskincare link in bio');
  assert.equal(back.status, 'pending', 'an approved item whose edit fails the gate goes back to pending');
  assert.equal(unapproveItem(a).status, 'pending');
  const posted = { ...a, instagram: { media_id: '1', posted_at: new Date(NOW).toISOString() } };
  assert.throws(() => unapproveItem(posted), /already posted/);
  assert.throws(() => editCaption(posted, OK), /already posted/);
  assert.throws(() => rejectItem(posted), /already posted/);
  assert.equal(rejectItem(item('r-1'), { reason: 'meh' }).status, 'rejected');
});

test('postingOrder: oldest approval first, pending and rejected excluded', () => {
  const items = [approved('b-1', '2026-10-02T00:00:00Z'), approved('a-1', '2026-10-01T00:00:00Z'), item('p-1'), item('r-2', { status: 'rejected' })];
  assert.deepEqual(postingOrder(items).map((i) => i.id), ['a-1', 'b-1']);
});

test('planRun: fresh item in approval order, both platforms', () => {
  const p = planRun([approved('b-1', '2026-10-02T00:00:00Z'), approved('a-1', '2026-10-01T00:00:00Z')], { now: NOW });
  assert.equal(p.fresh.item.id, 'a-1');
  assert.deepEqual(p.fresh.platforms, ['instagram', 'facebook']);
  assert.equal(p.retry, null);
});

test('planRun: an item on IG only is retried for FB alone, and does not cost the day', () => {
  const partial = approved('a-1', '2026-10-01T00:00:00Z', { instagram: { media_id: 'm', posted_at: '2026-10-23T18:20:00Z' } });
  const p = planRun([partial, approved('b-1', '2026-10-02T00:00:00Z')], { now: NOW });
  assert.equal(p.retry.item.id, 'a-1');
  assert.deepEqual(p.retry.platforms, ['facebook']);
  assert.equal(p.fresh.item.id, 'b-1');
});

test('planRun: posts_per_day counts items started today; detected posts do not count', () => {
  const today = new Date(NOW - 60_000).toISOString();
  const done = approved('a-1', '2026-10-01T00:00:00Z', { instagram: { media_id: 'm', posted_at: today }, facebook: { post_id: 'p', posted_at: today } });
  const p = planRun([done, approved('b-1', '2026-10-02T00:00:00Z')], { now: NOW, postsPerDay: 1 });
  assert.equal(p.fresh, null);
  assert.match(p.reason, /already started 1/);
  const detected = approved('a-1', '2026-10-01T00:00:00Z', { instagram: { posted_at: today, detected: true }, facebook: { posted_at: today, detected: true } });
  assert.equal(planRun([detected, approved('b-1', '2026-10-02T00:00:00Z')], { now: NOW }).fresh.item.id, 'b-1');
  assert.equal(planRun([done, approved('b-1', '2026-10-02T00:00:00Z')], { now: NOW, postsPerDay: 2 }).fresh.item.id, 'b-1');
});

test('planRun: a platform that failed twice is skipped and reported; a bad caption skips the item', () => {
  const fails = Array.from({ length: MAX_PLATFORM_FAILURES }, () => ({ platform: 'facebook', at: 'x', error: 'boom' }));
  const flaky = approved('a-1', '2026-10-01T00:00:00Z', { failures: fails });
  const bad = approved('b-1', '2026-10-02T00:00:00Z', { caption: 'cures eczema #realskincare link in bio' });
  const p = planRun([flaky, bad, approved('c-1', '2026-10-03T00:00:00Z')], { now: NOW });
  assert.equal(p.fresh.item.id, 'a-1');
  assert.deepEqual(p.fresh.platforms, ['instagram']);
  assert.ok(p.skipped.some((s) => s.id === 'a-1' && s.platform === 'facebook'));
  assert.ok(p.skipped.some((s) => s.id === 'b-1' && /claim/.test(s.reason)));
  const ig = approved('d-1', '2026-10-01T00:00:00Z', { instagram: { media_id: 'm', posted_at: '2026-10-20T00:00:00Z' }, failures: fails });
  const none = planRun([ig], { now: NOW });
  assert.equal(none.retry, null, 'nothing left to try on that item');
  assert.match(none.reason, /nothing approved/);
});

test('insightsDue: from 24h, every ~20h, final at 30 days, per platform', () => {
  const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
  const items = [
    approved('a-1', 'x', { instagram: { media_id: 'm1', posted_at: at(2) } }),
    approved('b-1', 'x', { instagram: { media_id: 'm2', posted_at: at(30) }, facebook: { post_id: 'p2', posted_at: at(30), insights_at: at(5) } }),
    approved('c-1', 'x', { facebook: { post_id: 'p3', posted_at: at(24 * 31) } }),
    approved('d-1', 'x', { instagram: { posted_at: at(48), detected: true } }),
  ];
  const due = insightsDue(items, NOW);
  assert.deepEqual(due.map((d) => `${d.id}/${d.platform}`), ['b-1/instagram', 'c-1/facebook']);
  assert.equal(due.find((d) => d.id === 'c-1').final, true);
});

test('store: atomic save, read, update; an unreadable file is skipped, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'social-q-'));
  saveItem(dir, item('a-1'));
  writeFileSync(join(dir, 'broken.json'), '{nope');
  const warned = [];
  assert.deepEqual(loadItems(dir, undefined, { onError: (n) => warned.push(n) }).map((i) => i.id), ['a-1']);
  assert.deepEqual(warned, ['broken.json']);
  updateItem(dir, 'a-1', (c) => ({ ...c, caption: 'changed' }));
  assert.equal(readItem(dir, 'a-1').caption, 'changed');
  assert.equal(readItem(dir, '../etc'), null);
  assert.equal(readItem(dir, 'nope-1'), null);
  assert.ok(!readdirSync(dir).some((n) => n.includes('.tmp-')), 'no temp files left behind');
  assert.throws(() => saveItem(dir, { id: '../x' }), /slug/);
});

// ── rotation and post_by (2026-10-24: three a day, rotate between products) ──
const POSTED = (at) => ({ media_id: 'm', posted_at: at });

test('planRun rotates: the product posted least recently goes next, never-posted first', () => {
  const items = [
    approved('cream-1', '2026-10-20T00:00:00Z', { product: 'cream', instagram: POSTED('2026-10-24T03:20:00Z'), facebook: POSTED('2026-10-24T03:20:00Z') }),
    approved('cream-2', '2026-10-20T00:00:01Z', { product: 'cream' }),
    approved('tp-1', '2026-10-21T00:00:00Z', { product: 'toothpaste', instagram: POSTED('2026-10-23T22:20:00Z'), facebook: POSTED('2026-10-23T22:20:00Z') }),
    approved('tp-2', '2026-10-21T00:00:01Z', { product: 'toothpaste' }),
    approved('soap-1', '2026-10-22T00:00:00Z', { product: 'soap' }),
  ];
  assert.equal(planRun(items, { postsPerDay: 3, now: NOW }).fresh.item.id, 'soap-1', 'a product that never posted goes first');
  const soapDone = items.map((i) => (i.id === 'soap-1' ? { ...i, instagram: POSTED('2026-10-24T18:20:00Z'), facebook: POSTED('2026-10-24T18:20:00Z') } : i));
  assert.equal(planRun(soapDone, { postsPerDay: 3, now: NOW }).fresh.item.id, 'tp-2', 'then the least recently posted product, not the oldest approval');
});

test('post_by goes first within its product, and is skipped once the day has passed', () => {
  const i = newItem({ id: 'hw-1', image_url: 'https://cdn.shopify.com/a.jpg', post_by: '2026-10-31' });
  assert.equal(i.post_by, '2026-10-31');
  assert.equal(newItem({ id: 'hw-2', image_url: 'https://cdn.shopify.com/a.jpg', post_by: 'Halloween' }).post_by, null);
  const items = [
    approved('tp-a', '2026-10-20T00:00:00Z', { product: 'toothpaste' }),
    approved('tp-halloween', '2026-10-23T00:00:00Z', { product: 'toothpaste', post_by: '2026-10-31' }),
  ];
  assert.equal(planRun(items, { postsPerDay: 3, now: NOW }).fresh.item.id, 'tp-halloween');
  const late = planRun(items, { postsPerDay: 3, now: Date.parse('2026-11-01T18:20:00Z') });
  assert.equal(late.fresh.item.id, 'tp-a');
  assert.ok(late.skipped.some((s) => s.id === 'tp-halloween' && /post-by/.test(s.reason)));
});

test('three runs in a day post three different products, then the cap stops a fourth', () => {
  let items = ['cream', 'toothpaste', 'soap', 'lotion'].flatMap((p) => [1, 2].map((n) => approved(`${p}-${n}`, `2026-10-2${n}T00:00:00Z`, { product: p })));
  const posted = [];
  const day = Date.parse('2026-10-25T00:00:00Z');
  for (const h of [3, 18, 22, 23]) {
    const now = day + h * 3_600_000;
    const plan = planRun(items, { postsPerDay: 3, now });
    if (!plan.fresh) { assert.match(plan.reason, /posts_per_day 3/); continue; }
    const at = new Date(now).toISOString();
    posted.push(plan.fresh.item.product);
    items = items.map((i) => (i.id === plan.fresh.item.id ? { ...i, instagram: POSTED(at), facebook: POSTED(at) } : i));
  }
  assert.equal(posted.length, 3);
  assert.equal(new Set(posted).size, 3);
});

test('nextInRotation: nothing to choose is null', () => {
  assert.equal(nextInRotation([], []), null);
});
