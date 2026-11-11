import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequest, mergePullRequest, REPO } from '../../lib/github-pr.js';

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  impl.calls = calls;
  return impl;
}

test('repo is seanfillmore/blogpostworkflow', () => {
  assert.equal(REPO, 'seanfillmore/blogpostworkflow');
});

test('createPullRequest POSTs to the pulls path against main with a Bearer token', async () => {
  const fetchImpl = fakeFetch([{ status: 201, json: { number: 42, html_url: 'https://github.com/seanfillmore/blogpostworkflow/pull/42' } }]);
  const r = await createPullRequest({ token: 'TOK', head: 'fix/recap-x', title: 'T', body: 'B', fetchImpl });
  assert.deepEqual(r, { number: 42, url: 'https://github.com/seanfillmore/blogpostworkflow/pull/42' });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://api.github.com/repos/seanfillmore/blogpostworkflow/pulls');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer TOK');
  assert.deepEqual(c.body, { title: 'T', head: 'fix/recap-x', base: 'main', body: 'B' });
});

test('mergePullRequest PUTs merge_method merge and returns the sha', async () => {
  const fetchImpl = fakeFetch([{ status: 200, json: { sha: 'abc123', merged: true } }]);
  const r = await mergePullRequest({ token: 'TOK', number: 42, fetchImpl });
  assert.deepEqual(r, { sha: 'abc123' });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://api.github.com/repos/seanfillmore/blogpostworkflow/pulls/42/merge');
  assert.equal(c.init.method, 'PUT');
  assert.equal(c.init.headers.Authorization, 'Bearer TOK');
  assert.deepEqual(c.body, { merge_method: 'merge' });
});

test('mergePullRequest retries a not-yet-mergeable 405, then succeeds', async () => {
  const fetchImpl = fakeFetch([{ status: 405, json: { message: 'Base branch was modified' } }, { status: 200, json: { sha: 's2', merged: true } }]);
  const r = await mergePullRequest({ token: 'T', number: 1, fetchImpl, sleep: async () => {} });
  assert.equal(r.sha, 's2');
  assert.equal(fetchImpl.calls.length, 2);
});

test('errors carry the status and message but never the token', async () => {
  const fetchImpl = fakeFetch([{ status: 422, json: { message: 'Validation Failed' } }]);
  await assert.rejects(
    createPullRequest({ token: 'SECRET-TOKEN', head: 'h', title: 't', body: 'b', fetchImpl }),
    (e) => /422/.test(e.message) && /Validation Failed/.test(e.message) && !e.message.includes('SECRET-TOKEN'),
  );
});

test('mergePullRequest throws when the API says not merged', async () => {
  const fetchImpl = fakeFetch([{ status: 200, json: { merged: false, message: 'nope' } }]);
  await assert.rejects(mergePullRequest({ token: 'T', number: 1, fetchImpl, sleep: async () => {} }), /not merged/);
});
