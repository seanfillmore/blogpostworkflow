import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import routes from '../../agents/dashboard/routes/press-outreach.js';
import { OPT_OUT_LINE, signature, postalLine } from '../../lib/press-outreach.js';

const ADDR = '1623 Central Ave STE 201, Cheyenne, WY 82001, United States';
const GOOD = `Hi Ada,\n\nLoved your piece on clean skincare. Could I send samples?\n\nYou can find it at realskincare.com.\n\n${signature()}\n\n${OPT_OUT_LINE}\n${postalLine(ADDR)}`;
const NO_OPT = 'Hi Ada,\n\nLoved your piece. Could I send samples?\n\nSean';

function root() {
  const r = mkdtempSync(join(tmpdir(), 'press-routes-'));
  mkdirSync(join(r, 'data/press/drafts'), { recursive: true });
  mkdirSync(join(r, 'data/brand'), { recursive: true });
  writeFileSync(join(r, 'data/brand/brand-kit.json'), JSON.stringify({ postal_address: ADDR }));
  return r;
}
function put(r, id, over = {}) {
  const d = { id, kind: 'pitch', contact_id: id.split('-')[1], to: 'ada@example.com', subject: 'Samples for you', text: GOOD, status: 'pending', created_at: `2026-10-0${id[7]}T10:00:00.000Z`, concept: 'c', ...over };
  writeFileSync(join(r, 'data/press/drafts', `${id}.json`), JSON.stringify(d));
  return d;
}
const read = (r, id) => JSON.parse(readFileSync(join(r, 'data/press/drafts', `${id}.json`), 'utf8'));

function call(method, url, body, ctx) {
  const route = routes.find((x) => x.method === method && x.match(url));
  assert.ok(route, `no route for ${method} ${url}`);
  const req = new EventEmitter();
  req.method = method; req.url = url; req.destroy = () => {};
  const res = {
    writeHead(s) { this.status = s; },
    end(b) { this.body = JSON.parse(b); this.done(); },
  };
  return new Promise((resolve, reject) => {
    res.done = () => resolve(res);
    Promise.resolve(route.handler(req, res, ctx)).catch(reject);
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  });
}

const A = '20261001-ada-pitch';
const B = '20261002-bob-pitch';

test('GET lists pending and approved drafts newest first, with gate', async () => {
  const r = root();
  put(r, A); put(r, B, { status: 'approved' }); put(r, '20261003-cy-pitch', { status: 'rejected' });
  const res = await call('GET', '/api/press/drafts', undefined, { ROOT: r });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.drafts.map((d) => d.id), [B, A]);
  assert.equal(res.body.drafts[0].gate.ok, true);
});

test('approving a draft with no opt-out line is refused and stays pending', async () => {
  const r = root();
  put(r, A, { text: NO_OPT });
  const res = await call('POST', `/api/press/drafts/${A}/approve`, {}, { ROOT: r });
  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.problems.length);
  assert.equal(read(r, A).status, 'pending');
});

test('approving a good draft sets approved', async () => {
  const r = root();
  put(r, A);
  const res = await call('POST', `/api/press/drafts/${A}/approve`, {}, { ROOT: r });
  assert.equal(res.status, 200);
  assert.equal(read(r, A).status, 'approved');
});

test('reject without a reason is 400; with one it rejects', async () => {
  const r = root();
  put(r, A);
  assert.equal((await call('POST', `/api/press/drafts/${A}/reject`, {}, { ROOT: r })).status, 400);
  assert.equal(read(r, A).status, 'pending');
  assert.equal((await call('POST', `/api/press/drafts/${A}/reject`, { reason: 'off topic' }, { ROOT: r })).status, 200);
  assert.equal(read(r, A).status, 'rejected');
});

test('approve-many approves good ids and reports the bad one', async () => {
  const r = root();
  put(r, A); put(r, B, { text: NO_OPT });
  const res = await call('POST', '/api/press/drafts/approve', { ids: [A, B, '../x'] }, { ROOT: r });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[A].ok, true);
  assert.equal(res.body.results[B].ok, false);
  assert.equal(res.body.results['../x'].ok, false);
  assert.equal(read(r, A).status, 'approved');
  assert.equal(read(r, B).status, 'pending');
});

test('PATCH strips dashes and stores the edit', async () => {
  const r = root();
  put(r, A);
  const res = await call('PATCH', `/api/press/drafts/${A}`, { text: GOOD.replace('Loved', 'Loved — truly') }, { ROOT: r });
  assert.equal(res.status, 200);
  assert.ok(!/[—–]/.test(read(r, A).text));
});

test('PATCH that fails the gate saves the edit and answers 422', async () => {
  const r = root();
  put(r, A);
  const res = await call('PATCH', `/api/press/drafts/${A}`, { text: NO_OPT }, { ROOT: r });
  assert.equal(res.status, 422);
  assert.equal(read(r, A).text, NO_OPT);
});

test('bad ids are 400 before any file access', async () => {
  const r = root();
  for (const url of ['/api/press/drafts/..%2Fx/approve', '/api/press/drafts/abc/approve']) {
    assert.equal((await call('POST', url, {}, { ROOT: r })).status, 400);
  }
  assert.equal((await call('PATCH', '/api/press/drafts/nope', { text: 'x' }, { ROOT: r })).status, 400);
});

test('unknown valid id is 404', async () => {
  const r = root();
  assert.equal((await call('POST', `/api/press/drafts/${A}/approve`, {}, { ROOT: r })).status, 404);
});

test('PATCH on an approved draft that stays clean stays approved', async () => {
  const r = root();
  put(r, A, { status: 'approved', approved_at: '2026-10-01T11:00:00.000Z' });
  const res = await call('PATCH', `/api/press/drafts/${A}`, { subject: 'New subject' }, { ROOT: r });
  assert.equal(res.status, 200);
  assert.equal(read(r, A).status, 'approved');
  assert.equal(read(r, A).subject, 'New subject');
});

test('PATCH on an approved draft that fails the gate is demoted to pending', async () => {
  const r = root();
  put(r, A, { status: 'approved', approved_at: '2026-10-01T11:00:00.000Z' });
  const res = await call('PATCH', `/api/press/drafts/${A}`, { text: NO_OPT }, { ROOT: r });
  assert.equal(res.status, 422);
  assert.equal(read(r, A).status, 'pending');
});

test('reject on an approved draft works', async () => {
  const r = root();
  put(r, A, { status: 'approved', approved_at: '2026-10-01T11:00:00.000Z' });
  const res = await call('POST', `/api/press/drafts/${A}/reject`, { reason: 'changed mind' }, { ROOT: r });
  assert.equal(res.status, 200);
  assert.equal(read(r, A).status, 'rejected');
});

test('M1: GET passes address_source through, and the Outreach card shows it escaped (or "address source unknown")', async () => {
  const r = root();
  put(r, A, { address_source: 'published:https://example.com/about' });
  const res = await call('GET', '/api/press/drafts', undefined, { ROOT: r });
  assert.equal(res.body.drafts[0].address_source, 'published:https://example.com/about');

  const src = readFileSync(new URL('../../agents/dashboard/public/js/dashboard.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function renderOutreachTab(');
  assert.ok(start > 0);
  const fn = src.slice(start, src.indexOf('\nasync function ', start + 10) > 0 ? src.indexOf('\nasync function ', start + 10) : start + 6000);
  assert.match(fn, /esc\(x\.address_source\)/, 'address_source is rendered through esc()');
  assert.match(fn, /address source unknown/);
  // Never rendered raw.
  assert.doesNotMatch(fn, /\+ x\.address_source \+/);
});
