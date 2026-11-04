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
const client = (captions, hook = 'Read the label first') => ({
  messages: { create: async () => ({ content: [{ text: JSON.stringify({ caption: captions.shift(), hook }) }] }) },
});
const tmpLedger = () => join(mkdtempSync(join(tmpdir(), 'ugc-reels-')), 'ledger.json');

test('runOnce dry run: writes a caption and posts nothing', async () => {
  const ledgerPath = tmpLedger();
  let published = 0;
  const run = await runOnce({
    apply: false, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
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
    apply: true, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
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
    apply: true, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
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
    apply: true, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [], maxCandidates: 1,
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
  assert.deepEqual(r, { containerId: 'c1', mediaId: 'm1', permalink: 'https://www.instagram.com/reel/abc/', collab: null });
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
    apply: true, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [AD], now: NOV9,
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
    apply: false, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [AD], now: Date.parse('2026-11-08T01:20:00Z'),
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
    apply: true, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [bad], now: NOV9,
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare']),
    publish: async ({ videoUrl }) => { assert.notEqual(videoUrl, bad.video_url); return { mediaId: 'm1', permalink: 'p' }; },
  });
  assert.equal(run.posted.submission_id, 'a');
  assert.ok(run.scheduledNotes.some((n) => /caption failed/.test(n)));
  assert.equal(readLedger(ledgerPath).failures[0].submission_id, 'scheduled:ad-1');
});

// ── on-screen hook, video edit and collab invites (2026-11-03) ────────────────

test('runOnce --apply: posts the EDITED video and invites the tagged creator as collaborator', async () => {
  const ledgerPath = tmpLedger();
  const seen = [];
  const run = await runOnce({
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
    fetchImpl: trybeFetch([sub('a')]),
    socials: { 'kaci smith': { handle: 'kaci.makes' } },
    client: client(['Soft skin, every morning. Link in bio. #realskincare'], 'Soft skin by morning'),
    edit: async (a) => { seen.push(a); return { ok: true, url: 'https://cdn.shopify.com/edited.mp4', file_id: 'gid://f', trimmed_s: 0.8, hook: 'Soft skin by morning' }; },
    publish: async (args) => { seen.push(args); return { mediaId: 'm1', permalink: 'p', collab: null }; },
  });
  assert.equal(seen[0].videoUrl, 'https://cdn.example/a.mp4');
  assert.equal(seen[0].hook, 'Soft skin by morning');
  assert.equal(typeof seen[0].detectText, 'function', 'the text check is always wired');
  assert.equal(seen[1].videoUrl, 'https://cdn.shopify.com/edited.mp4');
  assert.deepEqual(seen[1].collaborators, ['kaci.makes']);
  const post = readLedger(ledgerPath).posts[0];
  assert.equal(post.hook, 'Soft skin by morning');
  assert.deepEqual(post.edit, { ok: true, trimmed_s: 0.8, hook_drawn: true, url: 'https://cdn.shopify.com/edited.mp4', file_id: 'gid://f' });
  assert.ok(run.posted);
});

test('runOnce --apply: a failed edit posts the RAW video and records why', async () => {
  const ledgerPath = tmpLedger();
  let url = null;
  await runOnce({
    apply: true, trybeKey: 'k', token: 't', ledgerPath, scheduled: [],
    fetchImpl: trybeFetch([sub('a')]),
    client: client(['Soft skin, every morning. Link in bio. #realskincare']),
    edit: async () => ({ ok: false, error: 'ffmpeg not available' }),
    publish: async ({ videoUrl }) => { url = videoUrl; return { mediaId: 'm1', permalink: 'p' }; },
    log: () => {},
  });
  assert.equal(url, 'https://cdn.example/a.mp4');
  assert.deepEqual(readLedger(ledgerPath).posts[0].edit, { ok: false, error: 'ffmpeg not available' });
});

test('runOnce: a hook that breaks the rules is rewritten, and a claim in it blocks like one in the caption', async () => {
  const ledgerPath = tmpLedger();
  const hooks = ['Heals eczema fast', 'Soft skin by morning'];
  const c = { messages: { create: async () => ({ content: [{ text: JSON.stringify({ caption: 'Soft skin, every morning. Link in bio. #realskincare', hook: hooks.shift() }) }] }) } };
  const run = await runOnce({ apply: false, editVideos: false, trybeKey: 'k', token: 't', ledgerPath, scheduled: [], fetchImpl: trybeFetch([sub('a')]), client: c });
  assert.equal(run.posted.hook, 'Soft skin by morning');
});

test('publishReel: sends collaborators, and a refused invite retries once WITHOUT them', async () => {
  const bodies = [];
  let refuse = true;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname.endsWith('/media')) {
      const b = new URLSearchParams(init.body);
      bodies.push(b.get('collaborators'));
      if (b.get('collaborators') && refuse) return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid collaborator' } }) };
      return { ok: true, status: 200, json: async () => ({ id: 'c1' }) };
    }
    if (u.pathname.endsWith('/c1')) return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
    if (u.pathname.endsWith('/media_publish')) return { ok: true, status: 200, json: async () => ({ id: 'm1' }) };
    return { ok: true, status: 200, json: async () => ({ permalink: 'p' }) };
  };
  const r = await publishReel({ videoUrl: 'v', caption: 'c', collaborators: ['@Sarah.Fournier1996'] }, { token: 't', fetchImpl, sleep: async () => {} });
  assert.deepEqual(bodies, ['["sarah.fournier1996"]', null]);
  assert.equal(r.mediaId, 'm1');
  assert.deepEqual(r.collab.invited, []);
  assert.match(r.collab.refused, /Invalid collaborator/);
  refuse = false; bodies.length = 0;
  const ok = await publishReel({ videoUrl: 'v', caption: 'c', collaborators: ['sarah.fournier1996'] }, { token: 't', fetchImpl, sleep: async () => {} });
  assert.deepEqual(ok.collab, { invited: ['sarah.fournier1996'] });
});

test('getAccountGrowth reads follows/unfollows and reach by follow_type; renderGrowth compares two weeks', async () => {
  const { getAccountGrowth } = await import('../../lib/instagram-reels.js');
  const { renderGrowth } = await import('../../agents/ugc-reels/index.js');
  const tv = (value, rows) => ({ data: [{ total_value: { value, breakdowns: rows ? [{ results: rows.map(([k, v]) => ({ dimension_values: [k], value: v })) }] : undefined } }] });
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const m = u.searchParams.get('metric');
    const body = m === 'follows_and_unfollows' ? tv(undefined, [['FOLLOWER', 9], ['NON_FOLLOWER', 4]])
      : m === 'reach' ? tv(1000, [['NON_FOLLOWER', 950], ['FOLLOWER', 50]])
      : m === 'profile_views' ? tv(40) : m === 'website_clicks' ? { error: { message: 'nope' } } : { followers_count: 1077 };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
  const g = await getAccountGrowth({ since: 1, until: 2 }, { token: 't', fetchImpl });
  assert.deepEqual(g, { follows: 9, unfollows: 4, profile_views: 40, website_clicks: null, reach: 1000, reach_non_followers: 950, reach_followers: 50, followers: 1077 });
  const text = renderGrowth(g, { ...g, follows: 2, unfollows: 5 });
  assert.match(text, /followers now: 1077/);
  assert.match(text, /this week\s+net\s+\+5/);
  assert.match(text, /last week\s+net\s+-3/);
  assert.match(text, /95\.0% new people/);
  assert.match(text, /visit→follow 22\.5%/);
  assert.match(text, /website clicks \?/, 'a refused metric reads ?, never 0');
});
