import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runReview } from '../../agents/trybe-review/index.js';
import { listAll, requestRevision } from '../../lib/trybe.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body, auth: init.headers?.Authorization });
    const path = new URL(url).pathname.replace('/v1', '');
    const handler = routes[`${init.method || 'GET'} ${path}`];
    if (!handler) return new Response('{"error":"not found"}', { status: 404 });
    const { status = 200, json } = handler(url, init);
    return new Response(JSON.stringify(json), { status });
  };
  impl.calls = calls;
  return impl;
}

const claim = { id: 'submission_1', trybe_id: 't1', status: 'pending', media_type: 'video', creator: { name: 'Zena' }, products: [], transcript: { text: 'This healed my eczema.' }, created_at: '2026-09-22T00:00:00Z' };
const silent = { ...claim, id: 'submission_2', trybe_id: 't2', transcript: null };
const routes = (extra = {}) => ({
  'GET /submissions': () => ({ json: { object: 'list', data: [claim, silent], has_more: false, next_cursor: null } }),
  'GET /creator-performance': () => ({ json: { object: 'list', data: [], has_more: false } }),
  ...extra,
});

test('importing the agent does not run it', () => {
  assert.equal(typeof runReview, 'function');
});

test('dry run decides but sends nothing', async () => {
  const f = fakeFetch(routes());
  const run = await runReview({ apiKey: 'k', fetchImpl: f, log: () => {} });
  assert.equal(run.plan.revise.length, 1);
  assert.equal(run.plan.unchecked.length, 1);
  assert.ok(f.calls.every((c) => c.method === 'GET'), 'no write in a dry run');
  assert.ok(f.calls.every((c) => c.auth === 'Bearer k'));
  assert.ok(f.calls[0].url.includes('status=pending'));
});

test('--apply sends one revision request, only for the claim', async () => {
  const f = fakeFetch(routes({ 'POST /submissions/submission_1/request-revision': () => ({ json: { ...claim, status: 'revision_requested' } }) }));
  const run = await runReview({ apiKey: 'k', apply: true, fetchImpl: f, log: () => {} });
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(JSON.parse(posts[0].body).comment, /healed my eczema/);
  assert.equal(run.revised.length, 1);
});

test('a submission reviewed mid-run is "raced", not failed; a 500 is failed', async () => {
  const raced = await runReview({ apiKey: 'k', apply: true, log: () => {}, fetchImpl: fakeFetch(routes({
    'POST /submissions/submission_1/request-revision': () => ({ status: 400, json: { error: 'Submission is not pending' } }),
  })) });
  assert.equal(raced.raced.length, 1);
  assert.equal(raced.failed.length, 0);

  const broken = await runReview({ apiKey: 'k', apply: true, log: () => {}, fetchImpl: fakeFetch(routes({
    'POST /submissions/submission_1/request-revision': () => ({ status: 500, json: { error: 'boom' } }),
  })) });
  assert.equal(broken.failed.length, 1);
});

test('losing the performance read does not lose the review', async () => {
  const f = fakeFetch(routes({ 'GET /creator-performance': () => ({ status: 503, json: { error: 'down' } }) }));
  const run = await runReview({ apiKey: 'k', fetchImpl: f, log: () => {} });
  assert.equal(run.perf, null);
  assert.equal(run.plan.revise.length, 1);
});

test('listAll follows the cursor', async () => {
  const f = fakeFetch({
    'GET /creators': (url) => new URL(url).searchParams.get('after')
      ? { json: { data: [{ id: 'b' }], has_more: false } }
      : { json: { data: [{ id: 'a' }], has_more: true, next_cursor: 'c1' } },
  });
  const rows = await listAll('/creators', { apiKey: 'k', fetchImpl: f });
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
});

test('no key and no comment are refused before any request', async () => {
  await assert.rejects(listAll('/creators', { fetchImpl: fakeFetch({}) }), /no TRYBE_API_KEY/);
  assert.throws(() => requestRevision('s', '  ', { apiKey: 'k' }), /needs a comment/);
});

test('the agent never approves or rejects (source scan)', () => {
  const src = readFileSync(new URL('../../agents/trybe-review/index.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../../lib/trybe.js', import.meta.url), 'utf8');
  assert.ok(!/\/approve['"`]/.test(src), 'no approve call');
  assert.ok(!/\/reject['"`]/.test(src), 'no reject call');
});
