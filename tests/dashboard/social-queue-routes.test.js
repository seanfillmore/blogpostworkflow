import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import routes from '../../agents/dashboard/routes/social-queue.js';
import { ITEMS_DIR, newItem, saveItem, readItem } from '../../lib/social-queue.js';

const OK = 'Our body cream starts from a 7-ingredient base.\n\nLink in bio.\n\n#realskincare #bodycream';
const BAD = 'Cures eczema overnight. Link in bio. #realskincare';

function root() { return mkdtempSync(join(tmpdir(), 'social-routes-')); }
const dir = (r) => join(r, ITEMS_DIR);
function put(r, id, over = {}) {
  const it = { ...newItem({ id, image_url: `https://cdn.shopify.com/s/files/${id}.jpg`, caption: `${id} ${OK}`, source: `batch/${id}.png` }), ...over };
  saveItem(dir(r), it);
  return it;
}

function call(method, url, body, ctx) {
  const route = routes.find((x) => x.method === method && x.match(url));
  assert.ok(route, `no route for ${method} ${url}`);
  const req = new EventEmitter();
  req.method = method; req.url = url; req.destroy = () => {};
  const res = { writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); this.done(); } };
  return new Promise((resolve, reject) => {
    res.done = () => resolve(res);
    const p = route.handler(req, res, ctx);
    assert.ok(p && typeof p.then === 'function' || method === 'GET', 'body-reading handlers return their promise');
    Promise.resolve(p).catch(reject);
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      req.emit('end');
    });
  });
}

test('GET groups pending, approved (posting order) and posted, with the gate and known keys', async () => {
  const r = root();
  put(r, 'p-1');
  put(r, 'a-2', { status: 'approved', approved_at: '2026-10-02T00:00:00Z' });
  put(r, 'a-1', { status: 'approved', approved_at: '2026-10-01T00:00:00Z' });
  put(r, 'd-1', { status: 'approved', approved_at: '2026-09-01T00:00:00Z', instagram: { posted_at: 'x', media_id: '1' }, facebook: { posted_at: 'x', post_id: '2' } });
  put(r, 'x-1', { status: 'rejected' });
  const res = await call('GET', '/api/social/items', undefined, { ROOT: r });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.pending.map((i) => i.id), ['p-1']);
  assert.deepEqual(res.body.approved.map((i) => i.id), ['a-1', 'a-2']);
  assert.deepEqual(res.body.posted.map((i) => i.id), ['d-1']);
  assert.equal(res.body.rejected, 1);
  assert.equal(res.body.pending[0].gate.ok, true);
  assert.ok(res.body.known.sources.includes('batch/p-1.png'));
});

test('approve: a failing caption is 422 and stays pending; a clean one approves', async () => {
  const r = root();
  put(r, 'b-1', { caption: BAD });
  const res = await call('POST', '/api/social/items/b-1/approve', {}, { ROOT: r });
  assert.equal(res.status, 422);
  assert.ok(res.body.problems.length);
  assert.equal(readItem(dir(r), 'b-1').status, 'pending');
  put(r, 'g-1');
  assert.equal((await call('POST', '/api/social/items/g-1/approve', {}, { ROOT: r })).status, 200);
  assert.equal(readItem(dir(r), 'g-1').status, 'approved');
  assert.equal((await call('POST', '/api/social/items/g-1/approve', {}, { ROOT: r })).status, 409);
});

test('PATCH saves the edit, strips dashes, and answers 422 when it no longer passes', async () => {
  const r = root();
  put(r, 'e-1', { status: 'approved', approved_at: '2026-10-01T00:00:00Z' });
  const res = await call('PATCH', '/api/social/items/e-1', { caption: BAD }, { ROOT: r });
  assert.equal(res.status, 422);
  assert.equal(res.body.saved, true);
  const after = readItem(dir(r), 'e-1');
  assert.equal(after.caption, BAD);
  assert.equal(after.status, 'pending', 'demoted so the poster cannot pick it up');
  const ok = await call('PATCH', '/api/social/items/e-1', { caption: `Soft — smooth. ${OK}` }, { ROOT: r });
  assert.equal(ok.status, 200);
  assert.ok(!/[—–]/.test(readItem(dir(r), 'e-1').caption));
  assert.equal((await call('PATCH', '/api/social/items/e-1', { caption: '  ' }, { ROOT: r })).status, 400);
});

test('unapprove and reject; a posted item refuses both', async () => {
  const r = root();
  put(r, 'u-1', { status: 'approved', approved_at: '2026-10-01T00:00:00Z' });
  assert.equal((await call('POST', '/api/social/items/u-1/unapprove', {}, { ROOT: r })).status, 200);
  assert.equal(readItem(dir(r), 'u-1').status, 'pending');
  assert.equal((await call('POST', '/api/social/items/u-1/reject', { reason: 'no' }, { ROOT: r })).status, 200);
  assert.equal(readItem(dir(r), 'u-1').status, 'rejected');
  put(r, 'z-1', { status: 'approved', approved_at: 'x', instagram: { posted_at: 'x', media_id: '1' } });
  assert.equal((await call('POST', '/api/social/items/z-1/unapprove', {}, { ROOT: r })).status, 409);
  assert.equal((await call('POST', '/api/social/items/z-1/reject', {}, { ROOT: r })).status, 409);
});

test('bulk approve reports per id, including bad ids', async () => {
  const r = root();
  put(r, 'g-1'); put(r, 'b-1', { caption: BAD });
  const res = await call('POST', '/api/social/items/approve', { ids: ['g-1', 'b-1', '../x', 'nope-1'] }, { ROOT: r });
  assert.equal(res.status, 200);
  assert.equal(res.body.results['g-1'].ok, true);
  assert.equal(res.body.results['b-1'].status, 422);
  assert.equal(res.body.results['../x'].status, 400);
  assert.equal(res.body.results['nope-1'].status, 404);
});

test('ingest creates PENDING items, skips known ids and sources, rejects invalid ones', async () => {
  const r = root();
  put(r, 'have-1');
  const mk = (id, over = {}) => ({ id, image_url: `https://cdn.shopify.com/s/files/${id}.jpg`, caption: OK, source: `batch/${id}.png`, ...over });
  const res = await call('POST', '/api/social/ingest', { items: [
    mk('new-1', { status: 'approved' }), mk('have-1'), mk('dupe-src', { source: 'batch/have-1.png' }), mk('evil-1', { image_url: 'https://evil.example/a.jpg' }),
  ] }, { ROOT: r });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.created, ['new-1']);
  assert.deepEqual(res.body.skipped.map((s) => s.id), ['have-1', 'dupe-src']);
  assert.deepEqual(res.body.invalid.map((s) => s.id), ['evil-1']);
  assert.equal(readItem(dir(r), 'new-1').status, 'pending', 'ingest can never create an approved item');
  assert.equal((await call('POST', '/api/social/ingest', { items: [] }, { ROOT: r })).status, 400);
  assert.equal((await call('POST', '/api/social/ingest', 'null', { ROOT: r })).status, 400);
});

test('bad ids are 400 before any file access', async () => {
  const r = root();
  for (const url of ['/api/social/items/..%2Fx/approve', '/api/social/items/A_B/unapprove', '/api/social/items/x/reject']) {
    assert.equal((await call('POST', url, {}, { ROOT: r })).status, 400, url);
  }
  assert.equal((await call('PATCH', '/api/social/items/..%2F..%2Fetc', { caption: OK }, { ROOT: r })).status, 400);
});
