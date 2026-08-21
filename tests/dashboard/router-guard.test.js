// tests/dashboard/router-guard.test.js
//
// Layer 1 of the route hardening: dispatch() must contain a handler failure
// instead of letting it reach the process.
//
// Deliberately uses a SYNTHETIC route table and imports no real route module.
// If this file imported routes/, a future route fix could silently mask a
// regression in the guard itself — and the guard is the floor everything else
// stands on.

import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { dispatch } from '../../agents/dashboard/lib/router.js';

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false, writableEnded: false, destroyed: false };
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  res.end = (body) => { res.body = body === undefined ? null : body; res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

const makeReq = (method, url) => ({ method, url, headers: {}, on() { return this; } });

const rejections = [];
const onUnhandled = (reason) => { rejections.push(reason); };
before(() => { process.on('unhandledRejection', onUnhandled); });
after(() => { process.off('unhandledRejection', onUnhandled); });

async function drain() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test('a handler that throws synchronously produces a 500, not a crash', async () => {
  rejections.length = 0;
  const routes = [{ method: 'POST', match: '/boom', handler() { throw new Error('sync boom'); } }];
  const res = makeRes();

  const matched = dispatch(routes, makeReq('POST', '/boom'), res, {});
  await drain();

  assert.equal(matched, true, 'the route still counts as matched');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'internal error' });
  assert.deepEqual(rejections, []);
});

test('a handler whose promise rejects produces a 500, not an unhandled rejection', async () => {
  rejections.length = 0;
  const routes = [{ method: 'POST', match: '/boom', async handler() { throw new Error('async boom'); } }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/boom'), res, {});
  await drain();

  assert.equal(res.statusCode, 500);
  assert.deepEqual(rejections, [], 'nothing reached the process-level handler');
});

test('the 500 body never contains the exception message', async () => {
  rejections.length = 0;
  const secret = '/root/seo-claude/.env token sk-leak-me';
  const routes = [{ method: 'POST', match: '/boom', async handler() { throw new Error(secret); } }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/boom'), res, {});
  await drain();

  assert.ok(!String(res.body).includes('sk-leak-me'), 'exception text must not reach the client');
  assert.ok(!String(res.body).includes('/root/'), 'paths must not reach the client');
});

test('a handler that already answered is not written to twice', async () => {
  rejections.length = 0;
  const routes = [{
    method: 'POST',
    match: '/late',
    async handler(req, res) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      throw new Error('threw after responding');
    },
  }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/late'), res, {});
  await drain();

  assert.equal(res.statusCode, 200, 'the original response stands');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(res.destroyed, true, 'the connection is torn down instead of double-written');
  assert.deepEqual(rejections, []);
});

test('a handler that succeeds is completely unaffected', async () => {
  rejections.length = 0;
  const routes = [{
    method: 'GET',
    match: '/fine',
    handler(req, res) { res.writeHead(200); res.end('ok'); },
  }];
  const res = makeRes();

  assert.equal(dispatch(routes, makeReq('GET', '/fine'), res, {}), true);
  await drain();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
});

test('a non-matching request still returns false and touches nothing', async () => {
  const routes = [{ method: 'POST', match: '/boom', handler() { throw new Error('never called'); } }];
  const res = makeRes();

  assert.equal(dispatch(routes, makeReq('GET', '/other'), res, {}), false);
  assert.equal(res.statusCode, null);
});
