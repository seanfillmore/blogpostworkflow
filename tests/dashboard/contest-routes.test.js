// tests/dashboard/contest-routes.test.js
// The contest routes are public and live inside the shared seo-dashboard process.
// These tests pin the allowlist, the caps, the rate limits, the temp-file cleanup
// and that no token material ever leaves the server.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { createContestStore } from '../../lib/contest-store.js';
import {
  addCategory, adminAddDish, openVoting, setSubmissionsOpen,
} from '../../lib/contest.js';
import { createContestRoutes, isPublicContestPath } from '../../agents/dashboard/routes/contest.js';
import { dispatch } from '../../agents/dashboard/lib/router.js';

const NOW = new Date('2026-11-01T18:00:00Z');

function tmpDir(tag) {
  return fs.mkdtempSync(join(os.tmpdir(), `contest-${tag}-`));
}

function setup({ publicDir } = {}) {
  const dir = tmpDir('data');
  const uploadDir = tmpDir('upl');
  const store = createContestStore({ dir, now: () => NOW });
  const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 } });
  const routes = createContestRoutes({ store, now: () => NOW, upload, publicDir: publicDir || tmpDir('pub') });
  return { dir, uploadDir, store, routes };
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = null;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = (status, headers = {}) => { res.statusCode = status; Object.assign(res.headers, headers); res.headersSent = true; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (body) => {
    res.body = body == null ? '' : Buffer.isBuffer(body) ? body : String(body);
    res.writableEnded = true;
    res.emit('finish');
    res.emit('done');
  };
  res.done = () => new Promise((r) => (res.writableEnded ? r() : res.once('done', r)));
  res.json = () => JSON.parse(String(res.body));
  return res;
}

function makeReq({ method = 'GET', url, headers = {}, body = null, ip = '1.1.1.1' }) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = { 'x-real-ip': ip, ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroyed = false;
  const origDestroy = req.destroy.bind(req);
  req.destroy = (...a) => { req.destroyed = true; return origDestroy(...a); };
  if (body != null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (!req.headers['content-length']) req.headers['content-length'] = String(buf.length);
    setImmediate(() => req.end(buf));
  } else {
    setImmediate(() => req.end());
  }
  return req;
}

async function call(routes, opts) {
  const req = makeReq(opts);
  const res = makeRes();
  const matched = dispatch(routes, req, res, {});
  if (!matched) return { matched, res };
  await res.done();
  return { matched, res, req };
}

const json = (obj) => ({ body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } });

function multipart(fields, file) {
  const boundary = '----contest' + randomUUID();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    for (const val of Array.isArray(v) ? v : [v]) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${val}\r\n`));
    }
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field || 'photo'}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function seedOpen(store) {
  let catId; let dishId;
  await store.update((s) => {
    const a = addCategory(s, 'Desserts');
    catId = a.category.id;
    const d = adminAddDish(a.state, { categoryId: catId, name: 'Pie', cook: 'Ann', ingredients: 'apples', allergens: ['none'] });
    dishId = d.dish.id;
    return openVoting(d.state, NOW, new Date(NOW.getTime() + 3600_000));
  });
  return { catId, dishId };
}

const filesIn = (d) => fs.readdirSync(d);

test('isPublicContestPath: public exactly for the listed paths, never for admin', () => {
  for (const p of ['/contest/vote', '/contest/enter', '/contest/tv', '/contest/qr.svg',
    '/contest/assets/app.js', '/contest/photos/x.webp', '/api/contest/public', '/api/contest/vote',
    '/api/contest/my-ballot', '/api/contest/submission-form', '/api/contest/submit', '/api/contest/submission']) {
    assert.equal(isPublicContestPath(p), true, p);
  }
  for (const p of ['/api/contest/admin/state', '/contest/admin', '/api/contest/admin/reset',
    '/contest/assets/../admin.html', '/contest/assets/admin.js', '/contest/votes', '/api/contest/', '/contest/assets/']) {
    assert.equal(isPublicContestPath(p), false, p);
  }
});

test('a vote body over 1 KB is a 413 and the socket is not destroyed before the reply', async () => {
  const { routes } = setup();
  const big = JSON.stringify({ voterId: randomUUID(), pad: 'x'.repeat(2000) });
  const { res, req } = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({}), body: big });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().ok, false);
  assert.equal(req.destroyed, true, 'socket torn down after the response flushed');
});

test('the 61st vote from one voterId inside the window is a 429', async () => {
  const { routes, store } = setup();
  const { catId, dishId } = await seedOpen(store);
  const voterId = randomUUID();
  for (let i = 0; i < 60; i++) {
    const { res } = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId, categoryId: catId, dishId }), ip: `10.0.0.${i % 200}` });
    assert.equal(res.statusCode, 200, `vote ${i + 1}: ${res.body}`);
  }
  const { res } = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId, categoryId: catId, dishId }), ip: '10.9.9.9' });
  assert.equal(res.statusCode, 429);
});

test('the 601st vote from one IP is a 429 while another voter on another IP succeeds', async () => {
  const { routes, store } = setup();
  const { catId, dishId } = await seedOpen(store);
  const voters = Array.from({ length: 11 }, () => randomUUID());
  for (let i = 0; i < 600; i++) {
    const { res } = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId: voters[Math.floor(i / 60)], categoryId: catId, dishId }), ip: '9.9.9.9' });
    assert.equal(res.statusCode, 200, `vote ${i + 1}`);
  }
  const blocked = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId: voters[10], categoryId: catId, dishId }), ip: '9.9.9.9' });
  assert.equal(blocked.res.statusCode, 429);
  const other = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId: randomUUID(), categoryId: catId, dishId }), ip: '8.8.8.8' });
  assert.equal(other.res.statusCode, 200);
  assert.ok(other.res.json().ballot[catId] === dishId);
});

test('a bad voterId is a 400; a vote after the deadline is a 409 carrying the final picks', async () => {
  const { routes, store } = setup();
  const { catId, dishId } = await seedOpen(store);
  const bad = await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId: 'nope', categoryId: catId, dishId }) });
  assert.equal(bad.res.statusCode, 400);
  const voterId = randomUUID();
  await call(routes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId, categoryId: catId, dishId }) });
  const late = new Date(NOW.getTime() + 2 * 3600_000);
  const lateRoutes = createContestRoutes({ store, now: () => late, upload: multer({ dest: tmpDir('u2') }), publicDir: tmpDir('p2') });
  const r = await call(lateRoutes, { method: 'POST', url: '/api/contest/vote', ...json({ voterId, categoryId: catId, dishId }) });
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.res.json().error, 'Voting is closed');
  assert.deepEqual(r.res.json().ballot, { [catId]: dishId });
  assert.equal(r.res.headers['Cache-Control'], 'no-store');
});

test('submit with a text file as photo is a 400, nothing stored, and the temp file is deleted', async () => {
  const { routes, store, uploadDir } = setup();
  let catId;
  await store.update((s) => {
    const a = addCategory(s, 'Mains');
    catId = a.category.id;
    return setSubmissionsOpen(a.state, true);
  });
  const mp = multipart(
    { categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: ['milk', 'eggs'] },
    { name: 'notes.txt', type: 'text/plain', data: Buffer.from('not an image at all') },
  );
  const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error, /image/i);
  assert.deepEqual(filesIn(uploadDir), [], 'no multer temp file left behind');
  assert.equal(store.read().dishes.length, 0, 'the half-submission was rolled back');
});

test('submit with a real image stores the dish and returns an edit URL; temp file deleted', async () => {
  const { routes, store, uploadDir, dir } = setup();
  let catId;
  await store.update((s) => {
    const a = addCategory(s, 'Mains');
    catId = a.category.id;
    return setSubmissionsOpen(a.state, true);
  });
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).png().toBuffer();
  const mp = multipart(
    { categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: JSON.stringify(['milk']) },
    { name: 'stew.png', type: 'image/png', data: png },
  );
  const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp });
  assert.equal(res.statusCode, 200, res.body);
  const { editUrl } = res.json();
  assert.match(editUrl, /^\/contest\/enter\?edit=[A-Za-z0-9_-]+$/);
  assert.deepEqual(filesIn(uploadDir), []);
  const dish = store.read().dishes[0];
  assert.equal(dish.photoVersion, 1);
  assert.deepEqual(dish.allergens, ['milk']);
  assert.ok(fs.existsSync(join(dir, 'photos', `${dish.id}.webp`)));

  const token = editUrl.split('edit=')[1];
  const own = await call(routes, { url: `/api/contest/submission?token=${token}` });
  assert.equal(own.res.statusCode, 200);
  assert.equal(own.res.json().dish.name, 'Stew');
  assert.equal(JSON.stringify(own.res.json()).includes('editTokenHash'), false);
});

test('submit without a photo is a 400', async () => {
  const { routes, store, uploadDir } = setup();
  let catId;
  await store.update((s) => {
    const a = addCategory(s, 'Mains');
    catId = a.category.id;
    return setSubmissionsOpen(a.state, true);
  });
  const mp = multipart({ categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' });
  const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /photo/i);
  assert.deepEqual(filesIn(uploadDir), []);
});

test('GET /api/contest/public never carries editTokenHash and sends no-store', async () => {
  const { routes, store } = setup();
  await store.update((s) => {
    const a = addCategory(s, 'Mains');
    const st = setSubmissionsOpen(a.state, true);
    st.dishes.push({ id: randomUUID(), categoryId: a.category.id, name: 'X', cook: 'Y', ingredients: 'z', recipe: '', allergens: ['none'], status: 'approved', source: 'competitor', editedSinceApproval: false, photoVersion: 0, editTokenHash: 'deadbeef'.repeat(8) });
    return st;
  });
  const { res } = await call(routes, { url: '/api/contest/public' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes('editTokenHash'), false);
  assert.equal(res.body.includes('deadbeef'), false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.json().ok, true);
});

test('admin actions map onto the core and return adminView without token hashes', async () => {
  const { routes } = setup();
  const r1 = await call(routes, { method: 'POST', url: '/api/contest/admin/category-add', ...json({ name: 'Sides' }) });
  assert.equal(r1.res.statusCode, 200, r1.res.body);
  assert.equal(r1.res.json().state.categories[0].name, 'Sides');
  const r2 = await call(routes, { method: 'POST', url: '/api/contest/admin/open', ...json({ minutes: 30 }) });
  assert.equal(r2.res.statusCode, 409, 'no approved dishes yet');
  const r3 = await call(routes, { url: '/api/contest/admin/state' });
  assert.equal(r3.res.json().state.effectivePhase, 'setup');
  const r4 = await call(routes, { method: 'POST', url: '/api/contest/admin/title', ...json({ title: 'x'.repeat(81) }) });
  assert.equal(r4.res.statusCode, 400);
});

test('page routes 404 cleanly when the file is missing and serve it when present', async () => {
  const pub = tmpDir('pub');
  const { routes } = setup({ publicDir: pub });
  const miss = await call(routes, { url: '/contest/vote' });
  assert.equal(miss.res.statusCode, 404);
  fs.writeFileSync(join(pub, 'vote.html'), '<p>vote</p>');
  fs.mkdirSync(join(pub, 'assets'));
  fs.writeFileSync(join(pub, 'assets', 'app.js'), 'x');
  const hit = await call(routes, { url: '/contest/vote' });
  assert.equal(hit.res.statusCode, 200);
  assert.equal(hit.res.headers['Cache-Control'], 'no-cache');
  const asset = await call(routes, { url: '/contest/assets/app.js' });
  assert.equal(asset.res.statusCode, 200);
  const trav = await call(routes, { url: '/contest/assets/..%2fvote.html' });
  assert.equal(trav.res.statusCode, 404);
});

test('qr.svg is an SVG of the public vote URL', async () => {
  const { routes } = setup();
  const { res } = await call(routes, { url: '/contest/qr.svg' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /image\/svg\+xml/);
  assert.match(String(res.body), /<svg/);
});
