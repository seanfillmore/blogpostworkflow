import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce, readLedger, buildPrompt } from '../../agents/ugc-reels/index.js';
import { publishReel, waitForContainer } from '../../lib/instagram-reels.js';

const sub = (id, over = {}) => ({
  id, trybe_id: id, status: 'approved', media_type: 'video', version: 1, revision_of: null,
  creator: { name: 'Kaci Smith' },
  products: [{ name: 'Coconut Moisturizer | 4oz' }],
  transcript: { text: 'I love how soft my skin feels with this coconut moisturizer every morning.' },
  asset: { url: `https://cdn.example/${id}.mp4` },
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

// Trybe's /submissions endpoint, paginated shape.
const trybeFetch = (subs) => async () => { const b = JSON.stringify({ data: subs, has_more: false }); return { ok: true, status: 200, text: async () => b, json: async () => JSON.parse(b) }; };
const client = (captions) => ({
  messages: { create: async () => ({ content: [{ text: JSON.stringify({ caption: captions.shift() }) }] }) },
});
const tmpLedger = () => join(mkdtempSync(join(tmpdir(), 'ugc-reels-')), 'ledger.json');

test('runOnce dry run: writes a caption and posts nothing', async () => {
  const ledgerPath = tmpLedger();
  let published = 0;
  const run = await runOnce({
    apply: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare']),
    publish: async () => { published++; },
  });
  assert.equal(published, 0);
  assert.equal(existsSync(ledgerPath), false);
  assert.equal(run.posted.dryRun, true);
  assert.match(run.posted.caption, /🎥 Kaci$/);
});

test('runOnce --apply: publishes and records the post before returning', async () => {
  const ledgerPath = tmpLedger();
  const run = await runOnce({
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare']),
    publish: async () => ({ mediaId: 'm1', permalink: 'https://instagram.com/reel/x' }),
  });
  assert.equal(run.posted.media_id, 'm1');
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.posts.length, 1);
  assert.equal(ledger.posts[0].cycle, 1);
  assert.ok(ledger.posts[0].hook_style);
});

test('runOnce: a caption that fails the gate twice skips to the next video', async () => {
  const ledgerPath = tmpLedger();
  const run = await runOnce({
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
    fetchImpl: trybeFetch([sub('a'), sub('b', { created_at: '2026-10-02T00:00:00Z' })]),
    client: client(['Heals your eczema fast', 'Cures eczema overnight', 'Soft skin, every morning. Link in bio.']),
    publish: async () => ({ mediaId: 'm2', permalink: null }),
  });
  assert.equal(run.attempts.length, 1);
  assert.match(run.attempts[0].error, /gate twice/);
  assert.equal(run.posted.submission.id, 'b');
  assert.equal(readLedger(ledgerPath).failures[0].kind, 'caption');
});

test('runOnce: an Instagram refusal is recorded as a failure, not a post', async () => {
  const ledgerPath = tmpLedger();
  const run = await runOnce({
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [], maxCandidates: 1,
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio.']),
    publish: async () => { throw new Error('instagram: container ERROR'); },
  });
  assert.equal(run.posted, null);
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.posts.length, 0);
  assert.equal(ledger.failures.length, 1);
});

test('readLedger: an unreadable ledger throws instead of reading as "nothing posted"', () => {
  const p = tmpLedger();
  writeFileSync(p, '{"posts": [');
  assert.throws(() => readLedger(p));
});

test('buildPrompt: fences the transcript and carries earlier captions on a repeat', () => {
  const prompt = buildPrompt({ submission: sub('a'), style: 'pov', previous: [{ hook_style: 'question', body: 'Old caption here' }], learnings: '', constraint: '' });
  assert.match(prompt, /<transcript>[\s\S]*<\/transcript>/);
  assert.match(prompt, /Old caption here/);
  assert.match(prompt, /POV:/);
});

// ── lib/instagram-reels.js ───────────────────────────────────────────────────

test('publishReel: create, wait for FINISHED, publish, read permalink', async () => {
  const calls = [];
  const statuses = ['IN_PROGRESS', 'FINISHED'];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname.split('/').slice(2).join('/')}`);
    let body = {};
    if (init.method === 'POST' && u.pathname.endsWith('/media')) {
      body = { id: 'c1' };
      assert.equal(new URLSearchParams(init.body).get('media_type'), 'REELS');
    } else if (init.method === 'GET' && u.pathname.endsWith('/c1')) body = { status_code: statuses.shift() };
    else if (u.pathname.endsWith('/media_publish')) body = { id: 'm1' };
    else body = { id: 'm1', permalink: 'https://www.instagram.com/reel/abc/' };
    return { ok: true, status: 200, json: async () => body };
  };
  const r = await publishReel({ videoUrl: 'https://cdn.example/a.mp4', caption: 'hi' }, { token: 't', fetchImpl, sleep: async () => {} });
  assert.deepEqual(r, { containerId: 'c1', mediaId: 'm1', permalink: 'https://www.instagram.com/reel/abc/' });
  assert.equal(calls.filter((c) => c.endsWith('media_publish')).length, 1);
});

test('waitForContainer: ERROR throws with Instagram\'s reason', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status_code: 'ERROR', status: 'Error: unsupported video' }) });
  await assert.rejects(waitForContainer('c1', { token: 't', fetchImpl }), /ERROR: Error: unsupported video/);
});

test('the committed exclusion list parses and names the zeeey.xo video', async () => {
  const { loadExcluded } = await import('../../agents/ugc-reels/index.js');
  assert.ok(loadExcluded().some((e) => e.trybe_id === 'c2ba0f1d'));
});

const AD = {
  id: 'ad-1', not_before: '2026-11-08T16:00:00Z', product_key: 'Coconut Moisturizer (ad)',
  video_url: 'https://cdn.shopify.com/videos/ad.mp4',
  caption: 'It starts from a 7-ingredient base. Link in bio.\n\nMade with AI.\n\n#bodycream',
};
const NOV9 = Date.parse('2026-11-09T16:20:00Z');

test('runOnce: a due scheduled ad takes the slot, is recorded as an ad, and posts once', async () => {
  const ledgerPath = tmpLedger();
  const urls = [];
  const opts = {
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [AD], now: NOV9,
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare', 'Soft skin again. Link in bio. #realskincare']),
    publish: async ({ videoUrl }) => { urls.push(videoUrl); return { mediaId: `m${urls.length}`, permalink: 'p' }; },
  };
  const first = await runOnce(opts);
  assert.equal(first.posted.kind, 'ad');
  assert.deepEqual(urls, [AD.video_url]);
  const second = await runOnce(opts);
  assert.equal(second.posted.submission_id, 'a', 'next run is a creator video again');
  const ledger = readLedger(ledgerPath);
  assert.deepEqual(ledger.posts.map((p) => p.submission_id), ['scheduled:ad-1', 'a']);
  assert.equal(ledger.posts[0].hook_style, 'ad');
});

test('runOnce: a scheduled ad before its date is ignored', async () => {
  const ledgerPath = tmpLedger();
  const run = await runOnce({
    apply: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [AD], now: Date.parse('2026-11-08T01:20:00Z'),
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare']),
    publish: async () => { throw new Error('no'); },
  });
  assert.equal(run.posted.submission.id, 'a');
});

test('runOnce: a scheduled caption that fails the claim gate is not posted and the run falls back', async () => {
  const ledgerPath = tmpLedger();
  const bad = { ...AD, caption: 'Heals eczema overnight. Link in bio.' };
  const run = await runOnce({
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [bad], now: NOV9,
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare']),
    publish: async ({ videoUrl }) => { assert.notEqual(videoUrl, bad.video_url); return { mediaId: 'm1', permalink: 'p' }; },
  });
  assert.equal(run.posted.submission_id, 'a');
  assert.ok(run.scheduledNotes.some((n) => /caption failed/.test(n)));
  assert.equal(readLedger(ledgerPath).failures[0].submission_id, 'scheduled:ad-1');
});
