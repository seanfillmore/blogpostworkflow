import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrape, metaAdLibraryUrl } from '../../lib/firecrawl.js';

test('metaAdLibraryUrl encodes the brand query', () => {
  const u = metaAdLibraryUrl('Native Cos');
  assert.ok(u.includes('q=Native%20Cos'));
  assert.ok(u.includes('active_status=active'));
  assert.ok(u.includes('country=US'));
});

test('metaAdLibraryUrl returns null for empty input', () => {
  assert.equal(metaAdLibraryUrl(''), null);
  assert.equal(metaAdLibraryUrl(null), null);
});

test('metaAdLibraryUrl supports country override', () => {
  const u = metaAdLibraryUrl('Brand', { country: 'GB' });
  assert.ok(u.includes('country=GB'));
});

test('scrape returns null without apiKey or url', async () => {
  assert.equal(await scrape('', 'https://x'), null);
  assert.equal(await scrape('key', ''), null);
});

test('scrape returns the data block on success', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ success: true, data: { markdown: '# hi', links: [] } }),
  });
  const out = await scrape('key', 'https://x', { fetchImpl });
  assert.equal(out.markdown, '# hi');
});

test('scrape returns null when API returns success=false', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ success: false, error: 'rate limited' }),
  });
  assert.equal(await scrape('key', 'https://x', { fetchImpl }), null);
});

test('scrape returns null on non-OK response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await scrape('key', 'https://x', { fetchImpl }), null);
});

test('scrape returns null when fetch throws', async () => {
  const fetchImpl = async () => { throw new Error('eh'); };
  assert.equal(await scrape('key', 'https://x', { fetchImpl }), null);
});

test('scrape sends auth + body with correct shape', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = { url: _url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ success: true, data: {} }) };
  };
  await scrape('mykey', 'https://example.com', { fetchImpl, waitFor: 2000 });
  assert.equal(captured.url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(captured.headers.Authorization, 'Bearer mykey');
  assert.equal(captured.body.url, 'https://example.com');
  assert.equal(captured.body.waitFor, 2000);
  assert.deepEqual(captured.body.formats, ['markdown', 'links']);
});
