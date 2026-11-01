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
  addCategory, adminAddDish, approveDish, openVoting, setSubmissionsOpen, LIMITS,
} from '../../lib/contest.js';
import {
  createContestRoutes, isPublicContestPath, DEFAULT_LIMITS, UPLOAD_LIMITS,
} from '../../agents/dashboard/routes/contest.js';
import { dispatch } from '../../agents/dashboard/lib/router.js';
import { RecipeImportError } from '../../lib/recipe-import.js';

const NOW = new Date('2026-11-01T18:00:00Z');

function tmpDir(tag) {
  return fs.mkdtempSync(join(os.tmpdir(), `contest-${tag}-`));
}

function setup({ publicDir, limits, wrapStore, importRecipe } = {}) {
  const dir = tmpDir('data');
  const uploadDir = tmpDir('upl');
  const store = createContestStore({ dir, now: () => NOW });
  const upload = multer({ dest: uploadDir, limits: UPLOAD_LIMITS });
  const routes = createContestRoutes({
    store: wrapStore ? wrapStore(store) : store, now: () => NOW, upload, publicDir: publicDir || tmpDir('pub'), limits,
    importRecipe: importRecipe || (async () => { throw new Error('importRecipe not stubbed for this test'); }),
  });
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
    '/api/contest/my-ballot', '/api/contest/submission-form', '/api/contest/submit', '/api/contest/submission',
    '/api/contest/recipe-import']) {
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

test('rate limit defaults: 3000 votes / 10 min / IP, 60 / voter, 60 submissions and 30 recipe imports / hour / IP', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    votesPerIp: 3000, votesPerVoter: 60, voteWindowMs: 10 * 60_000, submitsPerIp: 60, submitWindowMs: 60 * 60_000,
    importsPerIp: 30, importWindowMs: 60 * 60_000, maxConcurrentImports: 4,
  });
  assert.equal(UPLOAD_LIMITS.fieldSize, 64 * 1024);
  assert.equal(UPLOAD_LIMITS.fileSize, 20 * 1024 * 1024);
});

test('the per-IP vote cap is a 429 while another voter on another IP succeeds', async () => {
  const { routes, store } = setup({ limits: { votesPerIp: 600 } });
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
  assert.ok(fs.existsSync(join(dir, 'photos', `${dish.id}-1.webp`)));

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

// ---- final-review fix wave -------------------------------------------------

const pngOf = (color) => sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).png().toBuffer();

async function openSubmissions(store) {
  let catId;
  await store.update((s) => {
    const a = addCategory(s, 'Mains');
    catId = a.category.id;
    return setSubmissionsOpen(a.state, true);
  });
  return catId;
}

async function submitWithPhoto(routes, catId, ip = '1.1.1.1') {
  const mp = multipart(
    { categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' },
    { name: 'stew.png', type: 'image/png', data: await pngOf('#c33') },
  );
  const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp, ip });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().editUrl.split('edit=')[1];
}

test('a cook photo edit on an approved dish re-pends it, versions the file and deletes the old one', async () => {
  const { routes, store, dir, uploadDir } = setup();
  const catId = await openSubmissions(store);
  const token = await submitWithPhoto(routes, catId);
  const id = store.read().dishes[0].id;
  await store.update((s) => approveDish(s, id));

  // Text-only edit: stays approved, flagged.
  const text = multipart({ categoryId: catId, name: 'Beef stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' });
  const t = await call(routes, { method: 'POST', url: `/api/contest/submission?token=${token}`, ...text });
  assert.equal(t.res.statusCode, 200, t.res.body);
  assert.equal(store.read().dishes[0].status, 'approved');
  assert.equal(store.read().dishes[0].editedSinceApproval, true);

  // New photo: back to pending, version 2, v1 file gone.
  const mp = multipart(
    { categoryId: catId, name: 'Beef stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' },
    { name: 'new.png', type: 'image/png', data: await pngOf('#3c3') },
  );
  const p = await call(routes, { method: 'POST', url: `/api/contest/submission?token=${token}`, ...mp });
  assert.equal(p.res.statusCode, 200, p.res.body);
  const dish = store.read().dishes[0];
  assert.equal(dish.status, 'pending');
  assert.equal(dish.photoVersion, 2);
  assert.equal(p.res.json().dish.photoUrl, `/contest/photos/${id}-2.webp`);
  assert.deepEqual(filesIn(join(dir, 'photos')), [`${id}-2.webp`]);
  assert.deepEqual(filesIn(uploadDir), []);

  const img = await call(routes, { url: `/contest/photos/${id}-2.webp` });
  assert.equal(img.res.statusCode, 200);
  assert.equal(img.res.headers['Content-Type'], 'image/webp');
  assert.match(img.res.headers['Cache-Control'], /immutable/);
  const old = await call(routes, { url: `/contest/photos/${id}-1.webp` });
  assert.equal(old.res.statusCode, 404);
  const legacy = await call(routes, { url: `/contest/photos/${id}.webp` });
  assert.equal(legacy.matched, false, 'unversioned photo URLs are no longer served');
  const pub = await call(routes, { url: '/api/contest/public' });
  assert.equal(pub.res.json().dishes.length, 0, 'the re-pended dish left the public list');
});

test('if the state update fails after staging a photo, the staged file is deleted and the old one kept', async () => {
  let failUpdates = false;
  const { routes, store, dir, uploadDir } = setup({
    wrapStore: (real) => ({
      ...real,
      update: (fn) => (failUpdates ? Promise.reject(new Error('disk full')) : real.update(fn)),
    }),
  });
  let catId; let id;
  await store.update((s) => {
    const a = addCategory(s, 'Mains');
    catId = a.category.id;
    const d = adminAddDish(a.state, { categoryId: catId, name: 'Pie', cook: 'Ann', ingredients: 'apples', allergens: ['none'] });
    id = d.dish.id;
    return { ...d.state, dishes: d.state.dishes.map((x) => ({ ...x, photoVersion: 1 })) };
  });
  await store.savePhoto(id, 1, await pngOf('#c33'));
  failUpdates = true;
  const mp = multipart(
    { id, categoryId: catId, name: 'Pie', cook: 'Ann', ingredients: 'apples', allergens: 'none' },
    { name: 'pie.png', type: 'image/png', data: await pngOf('#33c') },
  );
  const r = await call(routes, { method: 'POST', url: '/api/contest/admin/dish-update', ...mp }).catch((e) => e);
  assert.notEqual(r?.res?.statusCode, 200);
  assert.deepEqual(filesIn(join(dir, 'photos')), [`${id}-1.webp`], 'staged v2 removed, v1 intact');
  assert.equal(store.read().dishes[0].photoVersion, 1);
  assert.deepEqual(filesIn(uploadDir), []);
});

test('admin dish-update with a photo bumps the version and deletes the old file', async () => {
  const { routes, store, dir } = setup();
  const { catId, dishId } = await seedOpen(store);
  const add = (color) => pngOf(color).then((data) => multipart(
    { id: dishId, categoryId: catId, name: 'Pie', cook: 'Ann', ingredients: 'apples', allergens: 'none' },
    { name: 'pie.png', type: 'image/png', data },
  ));
  for (const color of ['#111', '#222']) {
    const r = await call(routes, { method: 'POST', url: '/api/contest/admin/dish-update', ...(await add(color)) });
    assert.equal(r.res.statusCode, 200, r.res.body);
  }
  assert.equal(store.read().dishes[0].photoVersion, 2);
  assert.equal(store.read().dishes[0].status, 'approved', 'an admin edit never re-pends');
  assert.deepEqual(filesIn(join(dir, 'photos')), [`${dishId}-2.webp`]);
});

test('admin dish-add may have no photo; competitor submit still needs one', async () => {
  const { routes, store } = setup();
  const catId = await openSubmissions(store);
  const mp = multipart({ categoryId: catId, name: 'Rolls', cook: 'Cy', ingredients: 'flour', allergens: 'wheat' });
  const r = await call(routes, { method: 'POST', url: '/api/contest/admin/dish-add', ...mp });
  assert.equal(r.res.statusCode, 200, r.res.body);
  const dish = store.read().dishes[0];
  assert.equal(dish.photoVersion, 0);
  assert.equal(dish.status, 'approved');
  assert.equal(r.res.json().state.dishes[0].name, 'Rolls');
});

test('submit is refused before the upload is parsed when entries are closed or the contest is full', async () => {
  const { routes, store, uploadDir } = setup();
  let catId;
  await store.update((s) => { const a = addCategory(s, 'Mains'); catId = a.category.id; return a.state; });
  const mp = multipart(
    { categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' },
    { name: 'stew.png', type: 'image/png', data: await pngOf('#c33') },
  );
  const closed = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp });
  assert.equal(closed.res.statusCode, 409);
  assert.equal(closed.res.json().error, 'dish entries are closed');
  assert.equal(closed.req.destroyed, true);
  assert.deepEqual(filesIn(uploadDir), [], 'multer never ran');

  await store.update((s) => {
    const st = setSubmissionsOpen(s, true);
    st.dishes = Array.from({ length: LIMITS.maxDishes }, () => ({ id: randomUUID(), categoryId: catId, name: 'x', cook: 'y', ingredients: 'z', recipe: '', allergens: ['none'], status: 'pending', source: 'competitor', editedSinceApproval: false, photoVersion: 0 }));
    return st;
  });
  const full = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp });
  assert.equal(full.res.statusCode, 409);
  assert.match(full.res.json().error, /full/);
  assert.deepEqual(filesIn(uploadDir), []);
});

test('own-dish update is refused before parsing for an unknown token or a contest past setup', async () => {
  const { routes, store, uploadDir } = setup();
  const catId = await openSubmissions(store);
  const token = await submitWithPhoto(routes, catId);
  const mp = () => pngOf('#c33').then((data) => multipart(
    { categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' },
    { name: 'stew.png', type: 'image/png', data },
  ));
  const bad = await call(routes, { method: 'POST', url: '/api/contest/submission?token=nope', ...(await mp()) });
  assert.equal(bad.res.statusCode, 404);
  assert.equal(bad.req.destroyed, true);
  await store.update((s) => openVoting(approveDish(s, s.dishes[0].id), NOW, new Date(NOW.getTime() + 3600_000)));
  const late = await call(routes, { method: 'POST', url: `/api/contest/submission?token=${token}`, ...(await mp()) });
  assert.equal(late.res.statusCode, 409);
  assert.equal(late.req.destroyed, true);
  assert.deepEqual(filesIn(uploadDir), []);
});

test('own-dish updates share the per-IP submission limiter', async () => {
  const { routes, store } = setup({ limits: { submitsPerIp: 3 } });
  const catId = await openSubmissions(store);
  const token = await submitWithPhoto(routes, catId, '5.5.5.5');
  const text = () => multipart({ categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' });
  for (let i = 0; i < 2; i++) {
    const r = await call(routes, { method: 'POST', url: `/api/contest/submission?token=${token}`, ...text(), ip: '5.5.5.5' });
    assert.equal(r.res.statusCode, 200, r.res.body);
  }
  const blocked = await call(routes, { method: 'POST', url: `/api/contest/submission?token=${token}`, ...text(), ip: '5.5.5.5' });
  assert.equal(blocked.res.statusCode, 429);
  const other = await call(routes, { method: 'POST', url: `/api/contest/submission?token=${token}`, ...text(), ip: '6.6.6.6' });
  assert.equal(other.res.statusCode, 200);
});

test('the 61st submission from one IP inside an hour is a 429', async () => {
  const { routes, store } = setup();
  const catId = await openSubmissions(store);
  const mp = () => multipart({ categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' });
  for (let i = 0; i < 60; i++) {
    const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp(), ip: '7.7.7.7' });
    assert.equal(res.statusCode, 400, `submit ${i + 1}: ${res.body}`); // no photo, but counted
  }
  const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp(), ip: '7.7.7.7' });
  assert.equal(res.statusCode, 429);
});

test('a text field over 64 KB and too many fields are plain 400s with no temp file left', async () => {
  const { routes, store, uploadDir } = setup();
  const catId = await openSubmissions(store);
  const long = multipart(
    { categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'x'.repeat(64 * 1024 + 10), allergens: 'none' },
    { name: 'stew.png', type: 'image/png', data: await pngOf('#c33') },
  );
  const r1 = await call(routes, { method: 'POST', url: '/api/contest/submit', ...long });
  assert.equal(r1.res.statusCode, 400);
  assert.match(r1.res.json().error, /too long/);
  const many = {};
  for (let i = 0; i < 41; i++) many[`f${i}`] = 'x';
  const r2 = await call(routes, { method: 'POST', url: '/api/contest/submit', ...multipart(many) });
  assert.equal(r2.res.statusCode, 400);
  assert.match(r2.res.json().error, /too many fields/);
  assert.deepEqual(filesIn(uploadDir), []);
  assert.equal(store.read().dishes.length, 0);
});

test('a GIF or SVG submitted as the photo is a plain 400 and nothing is stored', async () => {
  const { routes, store, uploadDir, dir } = setup();
  const catId = await openSubmissions(store);
  const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#c33' } }).gif().toBuffer();
  for (const [name, type, data] of [['a.gif', 'image/gif', gif], ['a.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>')]]) {
    const mp = multipart({ categoryId: catId, name: 'Stew', cook: 'Bo', ingredients: 'beef', allergens: 'none' }, { name, type, data });
    const { res } = await call(routes, { method: 'POST', url: '/api/contest/submit', ...mp });
    assert.equal(res.statusCode, 400, name);
    assert.equal(res.json().error, 'That file is not a supported image');
  }
  assert.equal(store.read().dishes.length, 0);
  assert.deepEqual(filesIn(uploadDir), []);
  assert.equal(fs.existsSync(join(dir, 'photos')) ? filesIn(join(dir, 'photos')).length : 0, 0);
});

test('a vote whose body is JSON null, an array or a scalar is a 400, never a 500', async () => {
  const { routes, store } = setup();
  await seedOpen(store);
  for (const body of ['null', '[]', '"x"', '42']) {
    const { res } = await call(routes, { method: 'POST', url: '/api/contest/vote', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.statusCode, 400, `${body}: ${res.body}`);
    assert.equal(res.json().ok, false);
  }
});

// ---- recipe import ---------------------------------------------------------------

const RECIPE = {
  name: 'Smoked Turkey Recipe', ingredients: ['turkey', 'rub'], steps: ['Smoke it.'], headings: [],
  recipeYield: '12', totalMinutes: 370, siteName: 'Dinner at the Zoo',
};
const importCall = (routes, url = 'https://www.dinneratthezoo.com/smoked-turkey-recipe/', ip = '2.2.2.2') => call(routes, {
  method: 'POST', url: '/api/contest/recipe-import', ...json({ url }), ip,
});

test('isPublicContestPath: the recipe import route is public', () => {
  assert.equal(isPublicContestPath('/api/contest/recipe-import'), true);
  assert.equal(isPublicContestPath('/api/contest/admin/recipe-import'), false);
});

test('recipe import: success returns the recipe and passes ONLY the url to the importer', async () => {
  const seen = [];
  const { routes } = setup({ importRecipe: async (...args) => { seen.push(args); return RECIPE; } });
  const { res } = await importCall(routes);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, recipe: RECIPE });
  assert.deepEqual(seen, [['https://www.dinneratthezoo.com/smoked-turkey-recipe/']]);
});

test('recipe import: every failure code maps to its status and plain message', async () => {
  const cases = [
    ['no_recipe', 422, "We couldn't find a recipe card on that page. You can type your ingredients and recipe below."],
    ['unreachable', 422, "We couldn't open that page. Check the link, or type your recipe below."],
    ['http_error', 422, "We couldn't open that page. Check the link, or type your recipe below."],
    ['timeout', 422, 'That site took too long to answer. Try again, or type your recipe below.'],
    ['site_blocked', 422, "That site doesn't let us read its recipes automatically. Please type your ingredients and recipe below."],
    ['not_html', 422, "That link isn't a recipe page we can read. You can type your recipe below."],
    ['too_large', 422, "That link isn't a recipe page we can read. You can type your recipe below."],
    ['bad_url', 400, "That doesn't look like a web link. Paste the full address, starting with https://"],
    ['blocked_url', 400, "That doesn't look like a web link. Paste the full address, starting with https://"],
  ];
  for (const [code, status, error] of cases) {
    const { routes } = setup({ importRecipe: async () => { throw new RecipeImportError(code, 'secret <html> from the page'); } });
    const { res } = await importCall(routes);
    assert.equal(res.statusCode, status, code);
    assert.deepEqual(res.json(), { ok: false, code, error }, code);
    assert.equal(/—/.test(error), false, 'no em dashes');
  }
});

test('recipe import: an unexpected error is a 422 unreachable, never a 500, and never echoes the error', async () => {
  const { routes } = setup({ importRecipe: async () => { throw new TypeError('boom: fetched <script>evil</script>'); } });
  const { res } = await importCall(routes);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.json(), { ok: false, code: 'unreachable', error: "We couldn't open that page. Check the link, or type your recipe below." });
  assert.equal(String(res.body).includes('evil'), false);
});

test('recipe import: a missing or non-string url is a bad_url 400 without calling the importer', async () => {
  let called = 0;
  const { routes } = setup({ importRecipe: async () => { called += 1; return RECIPE; } });
  for (const body of [{}, { url: 42 }, { url: '' }, { url: ['https://a.example'] }]) {
    const { res } = await call(routes, { method: 'POST', url: '/api/contest/recipe-import', ...json(body) });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().code, 'bad_url');
  }
  assert.equal(called, 0);
});

test('recipe import: 409 once the contest has left setup, before the importer runs', async () => {
  let called = 0;
  const { routes, store } = setup({ importRecipe: async () => { called += 1; return RECIPE; } });
  await seedOpen(store);
  const { res } = await importCall(routes);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().ok, false);
  assert.equal(called, 0);
});

test('recipe import: works in setup even when new entries are closed (edit links still use it)', async () => {
  const { routes, store } = setup({ importRecipe: async () => RECIPE });
  await store.update((s) => setSubmissionsOpen(s, false));
  const { res } = await importCall(routes);
  assert.equal(res.statusCode, 200);
});

test('recipe import: the 31st request from one IP inside an hour is a 429; another IP still works', async () => {
  assert.equal(DEFAULT_LIMITS.importsPerIp, 30);
  assert.equal(DEFAULT_LIMITS.importWindowMs, 60 * 60_000);
  const { routes } = setup({ importRecipe: async () => RECIPE });
  for (let i = 0; i < 30; i += 1) {
    const { res } = await importCall(routes);
    assert.equal(res.statusCode, 200, `request ${i + 1}`);
  }
  const blocked = await importCall(routes);
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.res.json().ok, false);
  const other = await importCall(routes, undefined, '3.3.3.3');
  assert.equal(other.res.statusCode, 200);
});

test('recipe import: the per-IP limit is overridable through the factory', async () => {
  const { routes } = setup({ limits: { importsPerIp: 2 }, importRecipe: async () => RECIPE });
  assert.equal((await importCall(routes)).res.statusCode, 200);
  assert.equal((await importCall(routes)).res.statusCode, 200);
  assert.equal((await importCall(routes)).res.statusCode, 429);
});

test('recipe import: a body over 2 KB is a 413 and the importer never runs', async () => {
  let called = 0;
  const { routes } = setup({ importRecipe: async () => { called += 1; return RECIPE; } });
  const big = JSON.stringify({ url: `https://a.example/${'x'.repeat(2100)}` });
  const { res, req } = await call(routes, { method: 'POST', url: '/api/contest/recipe-import', ...json({}), body: big });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().ok, false);
  assert.equal(req.destroyed, true);
  assert.equal(called, 0);
});

test('recipe import: only a few fetches run at once process-wide; the rest get a 429', async () => {
  const gates = [];
  const { routes } = setup({
    limits: { maxConcurrentImports: 2 },
    importRecipe: () => new Promise((resolve) => gates.push(() => resolve(RECIPE))),
  });
  const p1 = importCall(routes, undefined, '4.4.4.1');
  const p2 = importCall(routes, undefined, '4.4.4.2');
  for (let i = 0; gates.length < 2 && i < 200; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 2, 'both imports in flight');
  const busy = await importCall(routes, undefined, '4.4.4.3');
  assert.equal(busy.res.statusCode, 429);
  assert.equal(busy.res.json().code, 'busy');
  gates.forEach((g) => g());
  assert.equal((await p1).res.statusCode, 200);
  assert.equal((await p2).res.statusCode, 200);
  // Slots are released, failures included.
  const againP = importCall(routes, undefined, '4.4.4.4');
  for (let i = 0; gates.length < 3 && i < 200; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 3, 'a slot was free again');
  gates[2]();
  assert.equal((await againP).res.statusCode, 200);
});
