import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
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

test('savePhoto makes a 1200px webp; non-image rejects; bad id rejects', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    const id = randomUUID();
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#c33' } }).png().toBuffer();
    await store.savePhoto(id, png);
    const meta = await sharp(store.photoPath(id)).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 1200);
    await assert.rejects(store.savePhoto(randomUUID(), Buffer.from('not an image')), (e) => e.status === 400);
    await assert.rejects(store.savePhoto('../evil', png), (e) => e.status === 400);
    assert.deepEqual(fs.readdirSync(join(dir, 'photos')), [`${id}.webp`]);
    store.deletePhoto(id);
    assert.equal(fs.existsSync(store.photoPath(id)), false);
  } finally { rm(dir); }
});

test('archiveAndReset keeps dishes or starts fresh, archives, prunes photos', async () => {
  const dir = tmp();
  try {
    const store = createContestStore({ dir, now: () => NOW });
    await store.update((s) => ({ ...openState(s), title: 'Chili Cookoff', voteEvents: 3, ballots: { v: {} }, submissionsOpen: true, deadline: '2026-10-26T00:00:00Z' }));
    const dish = store.read().dishes[0];
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    await store.savePhoto(dish.id, png);
    const kept = await store.archiveAndReset({ keepDishes: true });
    assert.equal(kept.phase, 'setup');
    assert.equal(kept.dishes.length, 1);
    assert.equal(kept.dishes[0].status, 'approved');
    assert.equal(kept.dishes[0].editedSinceApproval, false);
    assert.deepEqual(kept.ballots, {});
    assert.equal(kept.voteEvents, 0);
    assert.equal(kept.submissionsOpen, false);
    assert.equal(kept.deadline, null);
    assert.equal(fs.readdirSync(join(dir, 'archive')).length, 1);
    assert.equal(fs.existsSync(store.photoPath(dish.id)), true);
    const fresh = await store.archiveAndReset({ keepDishes: false });
    assert.equal(fresh.title, 'Chili Cookoff');
    assert.deepEqual(fresh.dishes, []);
    assert.deepEqual(fresh.categories, []);
    assert.equal(fs.existsSync(store.photoPath(dish.id)), false);
    assert.equal(fs.readdirSync(join(dir, 'archive')).length, 2);
  } finally { rm(dir); }
});
