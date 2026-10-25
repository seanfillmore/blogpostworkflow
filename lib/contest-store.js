// lib/contest-store.js
// Persistence for the dish contest. One process owns the file: state is cached
// in memory after the first read, every write is serialised through a promise
// chain and lands via temp file + rename, so a reader never sees a half file.
import fs from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ContestError, emptyContest, isUuidV4 } from './contest.js';

const isWrapped = (r) => r && r.state && typeof r.state === 'object' && 'phase' in r.state;

export function createContestStore({ dir, now = () => new Date() }) {
  const stateFile = join(dir, 'state.json');
  const photosDir = join(dir, 'photos');
  const archiveDir = join(dir, 'archive');
  let cache = null;
  let chain = Promise.resolve();
  let counter = 0;

  const tmpName = (target) => `${target}.tmp-${process.pid}-${++counter}`;

  function atomicWrite(target, data) {
    fs.mkdirSync(join(target, '..'), { recursive: true });
    const tmp = tmpName(target);
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  function load() {
    if (cache) return cache;
    let raw;
    try {
      raw = fs.readFileSync(stateFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        cache = emptyContest(now());
        return cache;
      }
      throw err;
    }
    cache = JSON.parse(raw); // corrupt file throws; never silently replaced
    return cache;
  }

  function persist(state) {
    atomicWrite(stateFile, JSON.stringify(state, null, 2));
    cache = state;
  }

  function read() {
    return structuredClone(load());
  }

  function serialise(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function update(fn) {
    return serialise(() => {
      const result = fn(structuredClone(load()));
      persist(isWrapped(result) ? result.state : result);
      return result;
    });
  }

  function photoPath(dishId) {
    if (!isUuidV4(dishId)) throw new ContestError(400, 'invalid dish id');
    return join(photosDir, `${dishId}.webp`);
  }

  async function savePhoto(dishId, buffer) {
    const target = photoPath(dishId);
    let out;
    try {
      out = await sharp(buffer).rotate().resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch {
      throw new ContestError(400, 'That file is not a supported image');
    }
    atomicWrite(target, out);
  }

  function deletePhoto(dishId) {
    fs.rmSync(photoPath(dishId), { force: true });
  }

  function archiveAndReset({ keepDishes } = {}) {
    return serialise(() => {
      const old = load();
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      atomicWrite(join(archiveDir, `${stamp}-${++counter}.json`), JSON.stringify(old, null, 2));
      const fresh = emptyContest(now());
      fresh.title = old.title;
      if (keepDishes) {
        fresh.categories = structuredClone(old.categories);
        fresh.dishes = structuredClone(old.dishes).map((d) => ({ ...d, status: 'approved', editedSinceApproval: false }));
      }
      persist(fresh);
      const keep = new Set(fresh.dishes.map((d) => `${d.id}.webp`));
      if (fs.existsSync(photosDir)) {
        for (const f of fs.readdirSync(photosDir)) {
          if (f.endsWith('.webp') && !keep.has(f)) fs.rmSync(join(photosDir, f), { force: true });
        }
      }
      return structuredClone(fresh);
    });
  }

  return { read, update, photoPath, savePhoto, deletePhoto, archiveAndReset };
}
