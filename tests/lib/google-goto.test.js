import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isGotoUrl, chunk, parseConverterResponse, resolveGotoUrls, applyResolvedGotos, applyResolvedToOrganic, GOTO_BATCH_SIZE,
} from '../../lib/google-goto.js';

const G1 = 'https://google.com/goto?url=CAESdQAAA&gsessionid=x';
const G2 = 'https://google.com/goto?url=CAESdQBBB';
const G3 = 'https://www.google.com/goto?url=CAESdQCCC';

function ok(rows) {
  return { tasks: [{ status_code: 20000, result: rows }] };
}

test('isGotoUrl recognises only google.com/goto', () => {
  assert.equal(isGotoUrl(G1), true);
  assert.equal(isGotoUrl(G3), true);
  assert.equal(isGotoUrl('https://www.google.com/search?q=x'), false);
  assert.equal(isGotoUrl('https://notgoogle.com/goto?url=1'), false);
  assert.equal(isGotoUrl('https://www.realskincare.com/goto'), false);
  assert.equal(isGotoUrl('not a url'), false);
  assert.equal(isGotoUrl(null), false);
});

test('chunk splits into batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 4), []);
});

test('parseConverterResponse keeps only real destinations', () => {
  const m = parseConverterResponse(ok([
    { goto: G1, url: 'https://www.realskincare.com/blogs/news/a' },
    { goto: G2, url: G3 }, // resolved to another goto: not a destination
    { goto: 'https://example.com', url: 'https://x.com' }, // not a goto
    null,
  ]));
  assert.deepEqual([...m], [[G1, 'https://www.realskincare.com/blogs/news/a']]);
  assert.equal(parseConverterResponse({ tasks: [{ status_code: 50000, result: null }] }).size, 0);
  assert.equal(parseConverterResponse(null).size, 0);
});

test('resolveGotoUrls batches, retries a failed batch once, and counts what is left', async () => {
  const calls = [];
  let failedOnce = false;
  const fetchImpl = async (_url, init) => {
    const sent = JSON.parse(init.body)[0].goto_urls;
    calls.push(sent);
    if (sent.includes(G3) && !failedOnce) {
      failedOnce = true;
      return { ok: true, json: async () => ({ tasks: [{ status_code: 50000, status_message: 'Internal Error.' }] }) };
    }
    return { ok: true, json: async () => ok(sent.filter((g) => g !== G2).map((g) => ({ goto: g, url: `https://dest.example/${g.slice(-4)}` }))) };
  };
  const urls = ['https://plain.example/a', G1, G2, G1, G3];
  const { resolved, unresolved } = await resolveGotoUrls(urls, { auth: 'x', fetchImpl, batchSize: 2 });
  // plain URL never sent; duplicate G1 sent once
  assert.deepEqual(calls[0], [G1, G2]);
  assert.ok(calls.some((c) => c.length === 1 && c[0] === G2), 'unresolved G2 retried alone');
  assert.equal(resolved.get(G3), `https://dest.example/${G3.slice(-4)}`, 'G3 resolved on retry');
  assert.equal(resolved.has(G2), false);
  assert.equal(unresolved, 1);
});

test('resolveGotoUrls survives a throwing fetch and reports everything unresolved', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const { resolved, unresolved } = await resolveGotoUrls([G1, G2], { auth: 'x', fetchImpl });
  assert.equal(resolved.size, 0);
  assert.equal(unresolved, 2);
});

test('resolveGotoUrls makes no call without goto links or auth', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  assert.equal((await resolveGotoUrls(['https://a.example'], { auth: 'x', fetchImpl })).unresolved, 0);
  assert.equal((await resolveGotoUrls([G1], { auth: '', fetchImpl })).unresolved, 1);
  assert.equal(called, false);
});

test('applyResolvedGotos swaps in order and keeps unresolved links', () => {
  const m = new Map([[G1, 'https://dest.example/1']]);
  assert.deepEqual(applyResolvedGotos(['https://a.example', G1, G2], m), ['https://a.example', 'https://dest.example/1', G2]);
});

test('batch size stays small: Google throttles resolution per SERP page', () => {
  assert.ok(GOTO_BATCH_SIZE <= 5);
});

test('applyResolvedToOrganic rewrites url AND domain, leaves unresolved rows alone', () => {
  const rows = [
    { position: 1, url: G1, domain: 'google.com', title: 'a' },
    { position: 2, url: G2, domain: 'google.com', title: 'b' },
    { position: 3, url: 'https://www.reddit.com/r/x', domain: 'www.reddit.com', title: 'c' },
  ];
  const out = applyResolvedToOrganic(rows, new Map([[G1, 'https://www.harrisamazing.com/p']]));
  assert.deepEqual(out[0], { position: 1, url: 'https://www.harrisamazing.com/p', domain: 'www.harrisamazing.com', title: 'a' });
  assert.equal(out[1], rows[1]);
  assert.equal(out[2], rows[2]);
});

test('getSerpResults resolves goto links before returning organic rows', () => {
  const src = readFileSync(new URL('../../lib/dataforseo.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function getSerpResults'), src.indexOf('// ── Google Ads Transparency'));
  assert.match(fn, /resolveGotoUrls\(/);
  assert.match(fn, /applyResolvedToOrganic\(/);
});

test('AI Overview client resolves goto citations before returning them', () => {
  const src = readFileSync(new URL('../../lib/llm-clients.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function queryGoogleAIOverview'));
  assert.match(fn, /resolveGotoUrls\(/);
  assert.match(fn, /applyResolvedGotos\(/);
});
