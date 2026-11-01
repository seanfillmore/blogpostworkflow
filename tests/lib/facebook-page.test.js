import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPageToken, publishPagePhoto, recentPageMessages, getPagePostInsights } from '../../lib/facebook-page.js';

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, params: init.method === 'GET' ? Object.fromEntries(u.searchParams) : Object.fromEntries(init.body) });
    const key = `${init.method} ${u.pathname.replace(/^\/v\d+\.\d+\//, '')}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: { message: `no stub for ${key}` } }) };
    return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
  };
  return { calls, fetchImpl };
}

test('getPageToken exchanges the user token for the page token', async () => {
  const s = stub({ 'GET 113847674946808': { access_token: 'PAGE', id: '113847674946808' } });
  assert.equal(await getPageToken({ userToken: 'USER', fetchImpl: s.fetchImpl }), 'PAGE');
  assert.equal(s.calls[0].params.access_token, 'USER');
  const none = stub({ 'GET 113847674946808': { id: '1' } });
  await assert.rejects(getPageToken({ userToken: 'U', fetchImpl: none.fetchImpl }), /no page access_token/);
});

test('publishPagePhoto posts url + message to the page and reads the permalink', async () => {
  const s = stub({
    'POST 113847674946808/photos': { id: '555', post_id: '113847674946808_777' },
    'GET 113847674946808_777': { permalink_url: 'https://www.facebook.com/x/posts/777' },
  });
  const r = await publishPagePhoto({ imageUrl: 'https://cdn.shopify.com/a.jpg', caption: 'hi' }, { token: 'PAGE', fetchImpl: s.fetchImpl });
  assert.deepEqual(r, { photoId: '555', postId: '113847674946808_777', permalink: 'https://www.facebook.com/x/posts/777' });
  assert.equal(s.calls[0].params.url, 'https://cdn.shopify.com/a.jpg');
  assert.equal(s.calls[0].params.message, 'hi');
  assert.equal(s.calls[0].params.access_token, 'PAGE');
});

test('a Graph error throws with the message', async () => {
  const s = stub({ 'POST 113847674946808/photos': { error: { message: 'bad image' } } });
  await assert.rejects(publishPagePhoto({ imageUrl: 'u', caption: 'c' }, { token: 't', fetchImpl: s.fetchImpl }), /bad image/);
});

test('recentPageMessages and getPagePostInsights', async () => {
  const s = stub({
    'GET 113847674946808/posts': { data: [{ message: 'one' }, {}] },
    'GET 1_2/insights': { data: [{ name: 'post_media_view', values: [{ value: 33 }] }, { name: 'post_total_media_view_unique', values: [{ value: 16 }] }, { name: 'post_total_media_view_unique', values: [{ value: 99 }] }, { name: 'post_clicks', values: [{ value: 0 }] }] },
    'GET 1_2': { reactions: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } },
  });
  assert.deepEqual(await recentPageMessages({}, { token: 't', fetchImpl: s.fetchImpl }), ['one', '']);
  assert.deepEqual(await getPagePostInsights('1_2', { token: 't', fetchImpl: s.fetchImpl }),
    { media_views: 33, unique_viewers: 16, clicks: 0, reactions: 4, comments: 1, shares: 0 });
});
