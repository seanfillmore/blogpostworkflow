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

  const PHOTO_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);
  const MAX_INPUT_PIXELS = 100_000_000;

  /** Photos are versioned: photos/<dishId>-<version>.webp, version an integer >= 1. */
  function photoPath(dishId, version) {
    if (!isUuidV4(dishId)) throw new ContestError(400, 'invalid dish id');
    if (!Number.isInteger(version) || version < 1) throw new ContestError(400, 'invalid photo version');
    return join(photosDir, `${dishId}-${version}.webp`);
  }

  async function savePhoto(dishId, version, buffer) {
    const target = photoPath(dishId, version);
    let out;
    try {
      // Read the header first: refuse anything that is not a photo format before decoding it.
      const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      if (!PHOTO_FORMATS.has(meta.format)) throw new Error('unsupported format');
      out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate().resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch {
      throw new ContestError(400, 'That file is not a supported image');
    }
    atomicWrite(target, out);
  }

  /** Delete one version, or (no version) every photo file this dish has. */
  function deletePhoto(dishId, version) {
    if (version !== undefined) {
      fs.rmSync(photoPath(dishId, version), { force: true });
      return;
    }
    if (!isUuidV4(dishId) || !fs.existsSync(photosDir)) return;
    for (const f of fs.readdirSync(photosDir)) {
      if (f.startsWith(`${dishId}-`) && f.endsWith('.webp')) fs.rmSync(join(photosDir, f), { force: true });
    }
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
        // Statuses carry over: a pending dish stays pending for the next event's review.
        fresh.dishes = structuredClone(old.dishes).map((d) => (d.status === 'approved' ? { ...d, editedSinceApproval: false } : d));
      }
      persist(fresh);
      const keep = new Set(fresh.dishes.filter((d) => d.photoVersion > 0).map((d) => `${d.id}-${d.photoVersion}.webp`));
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
