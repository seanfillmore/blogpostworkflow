import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchImages, downloadImage, searchWeb } from '../../lib/tavily.js';

function mockFetch(responses) {
  let idx = 0;
  return async (url, init) => {
    const r = responses[idx++];
    if (typeof r === 'function') return r(url, init);
    return r;
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, headers: { get: () => null } };
}

test('searchImages returns mapped image entries', async () => {
  const fetchImpl = mockFetch([jsonResponse({
    images: [
      { url: 'https://x/a.jpg', description: 'A' },
      { url: 'https://x/b.jpg', description: 'B' },
    ],
  })]);
  const out = await searchImages('key', 'natural deodorant', { fetchImpl });
  assert.deepEqual(out, [
    { url: 'https://x/a.jpg', description: 'A' },
    { url: 'https://x/b.jpg', description: 'B' },
  ]);
});

test('searchImages respects maxResults', async () => {
  const fetchImpl = mockFetch([jsonResponse({
    images: [
      { url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' },
      { url: 'https://x/3.jpg' }, { url: 'https://x/4.jpg' },
    ],
  })]);
  const out = await searchImages('key', 'q', { maxResults: 2, fetchImpl });
  assert.equal(out.length, 2);
});

test('searchImages drops entries without url', async () => {
  const fetchImpl = mockFetch([jsonResponse({
    images: [{ url: 'https://x/a.jpg' }, { description: 'no url' }],
  })]);
  const out = await searchImages('key', 'q', { fetchImpl });
  assert.equal(out.length, 1);
});

test('searchImages returns [] on non-OK response', async () => {
  const fetchImpl = mockFetch([jsonResponse({}, { ok: false, status: 500 })]);
  assert.deepEqual(await searchImages('key', 'q', { fetchImpl }), []);
});

test('searchImages returns [] when fetch throws', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  assert.deepEqual(await searchImages('key', 'q', { fetchImpl }), []);
});

test('searchImages returns [] for missing key or query', async () => {
  assert.deepEqual(await searchImages('', 'q'), []);
  assert.deepEqual(await searchImages('key', ''), []);
});

test('searchWeb returns mapped {url,title,content} results', async () => {
  const fetchImpl = mockFetch([jsonResponse({
    results: [
      { url: 'https://pubmed.ncbi.nlm.nih.gov/123', title: 'SLS study', content: 'SLS degrades the mucin layer...' },
      { url: 'https://example.com/x', title: 'X', content: 'snippet' },
    ],
  })]);
  const out = await searchWeb('key', 'sls oral mucosa', { fetchImpl });
  assert.deepEqual(out, [
    { url: 'https://pubmed.ncbi.nlm.nih.gov/123', title: 'SLS study', content: 'SLS degrades the mucin layer...' },
    { url: 'https://example.com/x', title: 'X', content: 'snippet' },
  ]);
});

test('searchWeb respects maxResults and degrades to [] on error/missing args', async () => {
  const fetchImpl = mockFetch([jsonResponse({ results: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] })]);
  assert.equal((await searchWeb('key', 'q', { maxResults: 2, fetchImpl })).length, 2);
  assert.deepEqual(await searchWeb('key', 'q', { fetchImpl: async () => { throw new Error('x'); } }), []);
  assert.deepEqual(await searchWeb('', 'q'), []);
  assert.deepEqual(await searchWeb('key', ''), []);
});

test('downloadImage returns buffer + mime for valid image response', async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  const out = await downloadImage('https://x/a.jpg', { fetchImpl });
  assert.equal(out.mimeType, 'image/jpeg');
  assert.equal(out.buffer.length, 3);
});

test('downloadImage rejects non-image content-type', async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  });
  assert.equal(await downloadImage('https://x', { fetchImpl }), null);
});

test('downloadImage rejects oversize payloads', async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => new Uint8Array(5 * 1024 * 1024).buffer,
  });
  assert.equal(await downloadImage('https://x', { fetchImpl, maxBytes: 1024 * 1024 }), null);
});
