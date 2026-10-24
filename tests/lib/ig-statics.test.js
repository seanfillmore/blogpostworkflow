import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captionProblems, pickNextStatic, alreadyOnAccount, insightsDueStatics } from '../../lib/ig-statics.js';
import { runOnce } from '../../agents/ig-statics/index.js';

const OK = 'Our body cream starts from a 7-ingredient base.\n\nLink in bio.\n\n#realskincare #bodycream';
const item = (id, over = {}) => ({ id, image_url: `https://cdn.example/${id}.jpg`, caption: `${id}: ${OK}`, ...over });

test('captionProblems: a clean caption passes', () => {
  assert.deepEqual(captionProblems(OK), []);
});

test('captionProblems: dashes, links, missing hashtag/CTA and claims are refused', () => {
  assert.ok(captionProblems(`${OK} — nice`).some((p) => /dash/.test(p)));
  assert.ok(captionProblems(`${OK} https://x.co`).some((p) => /link/.test(p)));
  assert.ok(captionProblems('Link in bio. #bodycream').some((p) => /#realskincare/.test(p)));
  assert.ok(captionProblems('Nice cream. #realskincare').some((p) => /link in bio/.test(p)));
  assert.ok(captionProblems(`Heals eczema fast. ${OK}`).some((p) => /claim/.test(p)));
});

test('every queued caption passes the gate', () => {
  const { items } = JSON.parse(readFileSync(new URL('../../config/ig-statics.json', import.meta.url), 'utf8'));
  assert.ok(items.length > 0);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'ids are unique');
  assert.equal(new Set(items.map((i) => i.caption)).size, items.length, 'captions are unique (the repost check keys on them)');
  for (const i of items) {
    assert.deepEqual(captionProblems(i.caption), [], i.id);
    assert.match(i.image_url, /^https:\/\/cdn\.shopify\.com\/.+\.jpg/, i.id);
  }
});

test('pickNextStatic: queue order, each once, skipping posted and already-live captions', () => {
  const q = [item('a'), item('b'), item('c')];
  assert.equal(pickNextStatic(q, { posts: [] }).item.id, 'a');
  assert.equal(pickNextStatic(q, { posts: [{ id: 'a' }] }).item.id, 'b');
  const r = pickNextStatic(q, { posts: [{ id: 'a' }] }, [`  B: ${OK.toUpperCase()} `]);
  assert.equal(r.item.id, 'c', 'b is already on the account even though the ledger lost it');
  const done = pickNextStatic(q, { posts: q.map((x) => ({ id: x.id })) });
  assert.equal(done.item, null);
  assert.match(done.reason, /queue is empty/);
});

test('pickNextStatic: a bad caption or repeated failure is skipped, never stalls the queue', () => {
  const q = [item('bad', { caption: 'cures eczema #realskincare link in bio' }), item('flaky'), item('good')];
  const r = pickNextStatic(q, { failures: [{ id: 'flaky' }, { id: 'flaky' }] });
  assert.equal(r.item.id, 'good');
  assert.deepEqual(r.skipped.map((s) => s.item.id), ['bad', 'flaky']);
});

test('alreadyOnAccount ignores whitespace and case', () => {
  assert.ok(alreadyOnAccount('A  b\nc', ['a b c']));
  assert.ok(!alreadyOnAccount('a b', ['a b c']));
});

test('insightsDueStatics: from 24 h old, at most daily, never after final', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const posts = [
    { id: 'new', media_id: '1', posted_at: '2026-10-24T12:00:00Z' },
    { id: 'due', media_id: '2', posted_at: '2026-10-22T00:00:00Z' },
    { id: 'fresh', media_id: '3', posted_at: '2026-10-22T00:00:00Z', insights_at: '2026-10-24T20:00:00Z' },
    { id: 'final', media_id: '4', posted_at: '2026-09-01T00:00:00Z', insights_final: true },
  ];
  assert.deepEqual(insightsDueStatics({ posts }, now).map((p) => p.id), ['due']);
});

test('runOnce: dry run posts nothing; apply posts the next item and records it', async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'igs-')), 'ledger.json');
  const queue = [item('a'), item('b')];
  let published = 0;
  const publish = async () => { published++; return { mediaId: 'm1', permalink: 'https://instagram.com/p/x' }; };
  const captionsFn = async () => [];
  const dry = await runOnce({ queue, ledgerPath, publish, captionsFn, log: () => {} });
  assert.equal(dry.posted.dryRun, true);
  assert.equal(published, 0);
  const live = await runOnce({ apply: true, queue, ledgerPath, publish, captionsFn, log: () => {} });
  assert.equal(live.posted.id, 'a');
  assert.equal(live.remaining, 1);
  const next = await runOnce({ apply: true, queue, ledgerPath, publish, captionsFn, log: () => {} });
  assert.equal(next.posted.id, 'b');
  assert.equal(published, 2);
});

test('runOnce: a publish failure is recorded, not thrown', async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'igs-')), 'ledger.json');
  const r = await runOnce({ apply: true, queue: [item('a')], ledgerPath, publish: async () => { throw new Error('boom'); }, captionsFn: async () => [], log: () => {} });
  assert.equal(r.posted, null);
  assert.equal(r.error, 'boom');
  assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).failures.length, 1);
});
