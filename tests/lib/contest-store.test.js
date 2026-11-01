import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createContestStore } from '../../lib/contest-store.js';
import { castVote } from '../../lib/contest.js';

const NOW = new Date('2026-10-25T12:00:00Z');
const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'contest-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

function openState(base) {
  return {
    ...base,
    phase: 'open',
    categories: [{ id: 'c1', name: 'Mains' }],
    dishes: [{ id: randomUUID(), categoryId: 'c1', status: 'approved', name: 'Chili', editedSinceApproval: true }],
  };
}

test('200 concurrent updates lose no ballot', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    await store.update((s) => openState(s));
    const dish = store.read().dishes[0];
    await Promise.all(Array.from({ length: 200 }, () =>
      store.update((s) => castVote(s, NOW, { voterId: randomUUID(), categoryId: 'c1', dishId: dish.id }))));
    assert.equal(Object.keys(store.read().ballots).length, 200);
    assert.equal(store.read().voteEvents, 200);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  } finally { rm(dir); }
});

test('update resolves with fn result; failed update does not wedge the chain', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    const r = await store.update((s) => ({ state: { ...s, title: 'X' }, extra: 7 }));
    assert.equal(r.extra, 7);
    await assert.rejects(store.update(() => { throw new Error('boom'); }), /boom/);
    await store.update((s) => ({ ...s, title: 'Y' }));
    assert.equal(store.read().title, 'Y');
  } finally { rm(dir); }
});

test('read returns a clone; new instance reads identical state', async () => {
  const dir = tmp();
  try {
    const a = createContestStore({ dir, now: () => NOW });
    await a.update((s) => openState(s));
    a.read().title = 'mutated';
    assert.notEqual(a.read().title, 'mutated');
    const b = createContestStore({ dir, now: () => NOW });
    assert.deepEqual(b.read(), a.read());
  } finally { rm(dir); }
});

test('corrupt state.json throws and is not replaced', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(join(dir, 'state.json'), '{nope');
    const store = createContestStore({ dir, now: () => NOW });
    assert.throws(() => store.read());
    assert.equal(fs.readFileSync(join(dir, 'state.json'), 'utf8'), '{nope');
  } finally { rm(dir); }
});

// A PNG whose header claims 20000x20000 (400 MP) with almost no data: a decompression bomb.
function pixelBombPng() {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20000, 0); ihdr.writeUInt32BE(20000, 4); ihdr[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]);
}

test('savePhoto makes a versioned 1200px webp; non-image rejects; bad id or version rejects', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    const id = randomUUID();
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#c33' } }).png().toBuffer();
    await store.savePhoto(id, 1, png);
    assert.equal(store.photoPath(id, 1), join(dir, 'photos', `${id}-1.webp`));
    const meta = await sharp(store.photoPath(id, 1)).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 1200);
    await assert.rejects(store.savePhoto(randomUUID(), 1, Buffer.from('not an image')), (e) => e.status === 400);
    await assert.rejects(store.savePhoto('../evil', 1, png), (e) => e.status === 400);
    await assert.rejects(store.savePhoto(id, 0, png), (e) => e.status === 400);
    await assert.rejects(store.savePhoto(id, '2', png), (e) => e.status === 400);
    await store.savePhoto(id, 2, png);
    assert.deepEqual(fs.readdirSync(join(dir, 'photos')).sort(), [`${id}-1.webp`, `${id}-2.webp`]);
    store.deletePhoto(id, 1);
    assert.deepEqual(fs.readdirSync(join(dir, 'photos')), [`${id}-2.webp`]);
    store.deletePhoto(id);
    assert.deepEqual(fs.readdirSync(join(dir, 'photos')), []);
  } finally { rm(dir); }
});

test('savePhoto accepts only jpeg/png/webp/heif and refuses a pixel bomb before decoding', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    const base = sharp({ create: { width: 20, height: 20, channels: 3, background: '#39c' } });
    for (const buf of [await base.clone().jpeg().toBuffer(), await base.clone().webp().toBuffer()]) {
      await store.savePhoto(randomUUID(), 1, buf);
    }
    const refused = [
      await base.clone().gif().toBuffer(),
      await base.clone().tiff().toBuffer(),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'),
      pixelBombPng(),
    ];
    for (const buf of refused) {
      await assert.rejects(store.savePhoto(randomUUID(), 1, buf),
        (e) => e.status === 400 && e.message === 'That file is not a supported image');
    }
    assert.equal(fs.readdirSync(join(dir, 'photos')).length, 2, 'only the jpeg and webp were stored');
  } finally { rm(dir); }
});

test('archiveAndReset keeps dishes (and their statuses) or starts fresh, archives, prunes photos', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    const pendingId = randomUUID();
    await store.update((s) => {
      const st = { ...openState(s), title: 'Chili Cookoff', voteEvents: 3, ballots: { v: {} }, submissionsOpen: true, deadline: '2026-10-26T00:00:00Z' };
      st.dishes[0].photoVersion = 2;
      st.dishes.push({ id: pendingId, categoryId: 'c1', status: 'pending', name: 'Soup', editedSinceApproval: false, photoVersion: 1 });
      return st;
    });
    const dish = store.read().dishes[0];
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    await store.savePhoto(dish.id, 1, png); // stale version: pruned
    await store.savePhoto(dish.id, 2, png);
    await store.savePhoto(pendingId, 1, png);
    const kept = await store.archiveAndReset({ keepDishes: true });
    assert.equal(kept.phase, 'setup');
    assert.equal(kept.dishes.length, 2);
    assert.equal(kept.dishes[0].status, 'approved');
    assert.equal(kept.dishes[0].editedSinceApproval, false);
    assert.equal(kept.dishes[1].status, 'pending', 'a pending dish stays pending');
    assert.deepEqual(kept.ballots, {});
    assert.equal(kept.voteEvents, 0);
    assert.equal(kept.submissionsOpen, false);
    assert.equal(kept.deadline, null);
    assert.equal(fs.readdirSync(join(dir, 'archive')).length, 1);
    assert.deepEqual(fs.readdirSync(join(dir, 'photos')).sort(), [`${dish.id}-2.webp`, `${pendingId}-1.webp`].sort());
    const fresh = await store.archiveAndReset({ keepDishes: false });
    assert.equal(fresh.title, 'Chili Cookoff');
    assert.deepEqual(fresh.dishes, []);
    assert.deepEqual(fresh.categories, []);
    assert.deepEqual(fs.readdirSync(join(dir, 'photos')), []);
    assert.equal(fs.readdirSync(join(dir, 'archive')).length, 2);
  } finally { rm(dir); }
});
