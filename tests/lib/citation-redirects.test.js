import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectGroundingRedirects, resolveOne, resolveGroundingRedirects,
  loadRedirectCache, saveRedirectCache, MAX_RESOLVE,
} from '../../lib/citation-redirects.js';

const R = (t) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${t}`;

// A fetch stub shaped like the real one: `redirect: 'manual'` means a 3xx comes
// back with a Location header rather than being followed.
function stubFetch(routes, { onCall } = {}) {
  return async (url) => {
    onCall?.(url);
    const r = routes[url];
    if (r === undefined) return { status: 404, headers: new Headers() };
    if (r instanceof Error) throw r;
    return { status: r.status ?? 302, headers: new Headers(r.headers || {}) };
  };
}

const snapshots = [{
  results: [
    {
      prompt: 'best natural deodorant',
      responses: {
        gemini: { citations: ['vertexaisearch.cloud.google.com'], citation_urls: [R('A'), R('B')] },
        perplexity: { citations: ['gq.com'], citation_urls: ['https://www.gq.com/story/x'] },
        chatgpt: { error: 'API 429', citations: [], citation_urls: [] },
      },
    },
    {
      prompt: 'aluminum free deodorant',
      responses: { gemini: { citations: [], citation_urls: [R('A'), R('C')] } },
    },
  ],
}];

test('collectGroundingRedirects finds only redirects, deduped, in first-seen order', () => {
  assert.deepEqual(collectGroundingRedirects(snapshots), [R('A'), R('B'), R('C')]);
});

test('collectGroundingRedirects tolerates junk and errored responses', () => {
  assert.deepEqual(collectGroundingRedirects([]), []);
  assert.deepEqual(collectGroundingRedirects(undefined), []);
  assert.deepEqual(collectGroundingRedirects([{}, { results: null }]), []);
  // An errored engine is skipped — the same rule aggregateCitations applies.
  assert.deepEqual(
    collectGroundingRedirects([{ results: [{ responses: { gemini: { error: 'x', citation_urls: [R('Z')] } } }] }]),
    []);
});

test('resolveOne returns the publisher URL from a 302 Location', async () => {
  const fetchImpl = stubFetch({ [R('A')]: { status: 302, headers: { location: 'https://lonekauri.com/blogs/news/x' } } });
  assert.equal(await resolveOne(R('A'), { fetchImpl }), 'https://lonekauri.com/blogs/news/x');
});

test('resolveOne returns null rather than a guess on every failure shape', async () => {
  const cases = {
    // Not a redirect at all — the token expired, or Google served an interstitial.
    [R('ok200')]: { status: 200, headers: { location: 'https://e.com/x' } },
    [R('noloc')]: { status: 302, headers: {} },
    // A relative Location resolves back onto the redirector, which is the very
    // domain we are trying to get rid of.
    [R('rel')]: { status: 302, headers: { location: '/somewhere' } },
    // A redirect onto the redirector tells us nothing.
    [R('loop')]: { status: 302, headers: { location: R('B') } },
    [R('boom')]: new Error('socket hang up'),
  };
  const fetchImpl = stubFetch(cases);
  for (const key of Object.keys(cases)) {
    assert.equal(await resolveOne(key, { fetchImpl }), null, key);
  }
  // Unknown URL → 404 from the stub.
  assert.equal(await resolveOne(R('missing'), { fetchImpl }), null);
});

test('resolveOne survives a fetch that throws and one that returns nothing usable', async () => {
  assert.equal(await resolveOne(R('A'), { fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.equal(await resolveOne(R('A'), { fetchImpl: async () => undefined }), null);
});

test('resolveGroundingRedirects resolves what it can and counts what it cannot', async () => {
  const fetchImpl = stubFetch({
    [R('A')]: { headers: { location: 'https://lonekauri.com/a' } },
    [R('B')]: { status: 200 },
  });
  const out = await resolveGroundingRedirects([R('A'), R('B')], { fetchImpl, concurrency: 2 });
  assert.equal(out.resolved.get(R('A')), 'https://lonekauri.com/a');
  assert.equal(out.resolved.has(R('B')), false);
  assert.equal(out.attempted, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.fromCache, 0);
  assert.equal(out.skipped, 0);
});

test('a cached hit is never re-fetched, and a cached MISS is not retried either', async () => {
  const calls = [];
  const fetchImpl = stubFetch({ [R('C')]: { headers: { location: 'https://e.com/c' } } }, { onCall: (u) => calls.push(u) });
  // null is a real cache value: an expired token is still expired next week, and
  // re-fetching thousands of known failures every run is the cost this avoids.
  const cache = new Map([[R('A'), 'https://lonekauri.com/a'], [R('B'), null]]);
  const out = await resolveGroundingRedirects([R('A'), R('B'), R('C')], { fetchImpl, cache });
  assert.deepEqual(calls, [R('C')]);
  assert.equal(out.fromCache, 2);
  assert.equal(out.attempted, 1);
  assert.equal(out.resolved.get(R('A')), 'https://lonekauri.com/a');
  assert.equal(out.resolved.has(R('B')), false);
  assert.equal(out.resolved.get(R('C')), 'https://e.com/c');
});

test('resolveGroundingRedirects records results into the caller\'s cache', async () => {
  const cache = new Map();
  const fetchImpl = stubFetch({
    [R('A')]: { headers: { location: 'https://e.com/a' } },
    [R('B')]: { status: 200 },
  });
  await resolveGroundingRedirects([R('A'), R('B')], { fetchImpl, cache });
  assert.equal(cache.get(R('A')), 'https://e.com/a');
  assert.equal(cache.get(R('B')), null, 'a miss is remembered as null, not left absent');
});

test('the limit is a hard ceiling, and what it skips is counted rather than dropped silently', async () => {
  const calls = [];
  const fetchImpl = stubFetch({}, { onCall: (u) => calls.push(u) });
  const out = await resolveGroundingRedirects([R('A'), R('B'), R('C')], { fetchImpl, limit: 2 });
  assert.equal(calls.length, 2);
  assert.equal(out.attempted, 2);
  assert.equal(out.skipped, 1);
  assert.ok(MAX_RESOLVE >= 3796, 'the measured four-week window must fit under the default ceiling');
});

test('an empty input list does no work and throws nothing', async () => {
  const fetchImpl = stubFetch({}, { onCall: () => assert.fail('must not fetch') });
  const out = await resolveGroundingRedirects([], { fetchImpl });
  assert.equal(out.resolved.size, 0);
  assert.equal(out.attempted, 0);
  assert.equal(out.skipped, 0);
  assert.deepEqual((await resolveGroundingRedirects(undefined, { fetchImpl })).resolved.size, 0);
});

test('concurrency does not lose or duplicate work', async () => {
  const urls = Array.from({ length: 50 }, (_, i) => R(`T${i}`));
  const seen = [];
  const fetchImpl = async (u) => {
    seen.push(u);
    await new Promise((r) => setTimeout(r, 1));
    return { status: 302, headers: new Headers({ location: `https://e.com/${u.slice(-3)}` }) };
  };
  const out = await resolveGroundingRedirects(urls, { fetchImpl, concurrency: 8 });
  assert.equal(out.attempted, 50);
  assert.equal(out.resolved.size, 50);
  assert.equal(new Set(seen).size, 50, 'each URL fetched exactly once');
});

// ── Cache persistence ────────────────────────────────────────────────────────

test('cache round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redir-'));
  const path = join(dir, 'redirect-cache.json');
  const cache = new Map([[R('A'), 'https://e.com/a'], [R('B'), null]]);
  const kept = saveRedirectCache(path, cache, [R('A'), R('B')]);
  assert.equal(kept, 2);
  const back = loadRedirectCache(path);
  assert.equal(back.get(R('A')), 'https://e.com/a');
  assert.equal(back.get(R('B')), null);
});

test('saving PRUNES to the keys of the window just processed', () => {
  // Bounded by pruning rather than by a timer, so the file can never outgrow
  // the four-week window however long the agent runs.
  const dir = mkdtempSync(join(tmpdir(), 'redir-'));
  const path = join(dir, 'c.json');
  const cache = new Map([[R('OLD'), 'https://e.com/old'], [R('NEW'), 'https://e.com/new']]);
  saveRedirectCache(path, cache, [R('NEW')]);
  const back = loadRedirectCache(path);
  assert.equal(back.size, 1);
  assert.equal(back.has(R('OLD')), false);
});

test('an absent, corrupt or foreign cache file reads as empty rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redir-'));
  assert.equal(loadRedirectCache(join(dir, 'nope.json')).size, 0);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(loadRedirectCache(bad).size, 0);
  const foreign = join(dir, 'foreign.json');
  writeFileSync(foreign, '{"something":"else"}');
  assert.equal(loadRedirectCache(foreign).size, 0);
});

test('an unwritable cache path fails the save, never the run', () => {
  // A cache that cannot be saved must not fail a run that already has its report.
  assert.doesNotThrow(() => {
    const kept = saveRedirectCache('/proc/definitely/not/writable/c.json', new Map([[R('A'), 'x']]), [R('A')]);
    assert.equal(kept, 0);
  });
});

test('saved cache is valid JSON carrying a timestamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redir-'));
  const path = join(dir, 'c.json');
  saveRedirectCache(path, new Map([[R('A'), 'https://e.com/a']]), [R('A')]);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(raw.saved_at);
  assert.equal(raw.entries[R('A')], 'https://e.com/a');
});
