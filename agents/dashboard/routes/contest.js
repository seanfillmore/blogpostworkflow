// agents/dashboard/routes/contest.js
// HTTP surface of the church dish-contest voting app. Public pages and JSON for
// phones and the TV, plus the auth-only admin API. The rules live in lib/contest.js
// and persistence in lib/contest-store.js; this file only parses, rate-limits and
// projects.
//
// This runs inside the shared seo-dashboard process on a public URL, so:
//  - every handler RETURNS its promise (lib/router.js turns a rejection into a 500);
//  - multer is wrapped in a promise inside the handler, never worked in its callback;
//  - every multer temp file is unlinked in a `finally`, success or failure;
//  - ContestError becomes its own status, anything else falls through to the router.
import fs from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import multer from 'multer';
import QRCode from 'qrcode';
import { ROOT } from '../lib/paths.js';
import { readJsonBody } from '../lib/responses.js';
import { createRateLimiter, getClientIp } from '../lib/rate-limit.js';
import { createContestStore } from '../../../lib/contest-store.js';
import {
  ContestError, ALLERGEN_LABELS, isUuidV4, effectivePhase, publicView, adminView, ballotFor,
  castVote, validateDishFields, submitDish, findByToken, updateOwnDish, setDishPhoto,
  setTitle, addCategory, renameCategory, deleteCategory, reorderCategories,
  adminAddDish, adminUpdateDish, approveDish, unapproveDish, deleteDish, reorderDishes,
  setSubmissionsOpen, openVoting, extendDeadline, closeVoting, startReveal, revealNext, revealBack,
} from '../../../lib/contest.js';

const PUBLIC_EXACT = new Set([
  '/contest/vote', '/contest/enter', '/contest/tv', '/contest/qr.svg',
  '/api/contest/public', '/api/contest/vote', '/api/contest/my-ballot',
  '/api/contest/submission-form', '/api/contest/submit', '/api/contest/submission',
]);
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PHOTO_PATH = /^\/contest\/photos\/([^/]+)\.webp$/;

const pathOf = (url) => String(url || '/').split('?')[0];
const queryOf = (url) => new URLSearchParams(String(url || '').split('?')[1] || '');

/** True for exactly the routes a phone or the TV may reach without dashboard auth. */
export function isPublicContestPath(urlPath) {
  const p = pathOf(urlPath);
  if (p.includes('/admin')) return false;
  if (PUBLIC_EXACT.has(p)) return true;
  for (const prefix of ['/contest/assets/', '/contest/photos/']) {
    if (p.startsWith(prefix) && p.length > prefix.length) return true;
  }
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Answer, then drop the socket once the reply has flushed (destroying first loses the reply). */
function refuseAndClose(req, res, status, message) {
  if (typeof res.on === 'function') res.on('finish', () => req.destroy());
  sendJson(res, status, { ok: false, error: message });
}

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'That photo is too large. The limit is 20 MB.',
  LIMIT_FILE_COUNT: 'Please attach only one photo.',
  LIMIT_UNEXPECTED_FILE: 'Please attach only one photo.',
};

class UploadError extends ContestError {}

function runUpload(upload, req, res) {
  return new Promise((resolve, reject) => {
    upload.single('photo')(req, res, (err) => {
      if (!err) return resolve();
      const msg = (err instanceof multer.MulterError && MULTER_MESSAGES[err.code]) || 'That upload could not be read.';
      reject(new UploadError(400, msg));
    });
  });
}

/** Parse a multipart request, run `fn(fields, file)`, always delete the temp file. */
async function withUpload(upload, req, res, fn) {
  try {
    await runUpload(upload, req, res);
    return await fn(req.body || {}, req.file || null);
  } finally {
    if (req.file && req.file.path) await unlink(req.file.path).catch(() => {});
  }
}

function parseAllergens(body) {
  const raw = body.allergens ?? body['allergens[]'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    }
    return t ? [t] : [];
  }
  return [];
}

function dishFields(body) {
  const str = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '');
  return {
    categoryId: str(body.categoryId),
    name: str(body.name),
    cook: str(body.cook),
    ingredients: str(body.ingredients),
    recipe: str(body.recipe),
    allergens: parseAllergens(body),
  };
}

function ownDishView(dish, state, now) {
  return {
    id: dish.id,
    categoryId: dish.categoryId,
    name: dish.name,
    cook: dish.cook,
    ingredients: dish.ingredients,
    recipe: dish.recipe,
    allergens: [...dish.allergens],
    status: dish.status,
    photoUrl: dish.photoVersion > 0 ? `/contest/photos/${dish.id}.webp?v=${dish.photoVersion}` : null,
    editable: state.phase === 'setup' && effectivePhase(state, now) === 'setup',
  };
}

function deadlineFrom(body, now) {
  if (body.deadline != null && body.deadline !== '') return body.deadline;
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new ContestError(400, 'minutes must be between 1 and 1440');
  }
  return new Date(now.getTime() + minutes * 60_000);
}

const removeDishRaw = (id) => (s) => {
  s.dishes = s.dishes.filter((d) => d.id !== id);
  return s;
};

export function createContestRoutes({
  store,
  publicBase = 'https://vote.realskincare.com',
  now = () => new Date(),
  upload,
  publicDir = join(ROOT, 'agents', 'dashboard', 'public', 'contest'),
  limits = {},
} = {}) {
  if (!store) throw new Error('createContestRoutes requires a store');
  if (!upload) throw new Error('createContestRoutes requires an upload (multer) instance');
  const lim = {
    votesPerIp: 600, votesPerVoter: 60, voteWindowMs: 10 * 60_000,
    submitsPerIp: 20, submitWindowMs: 60 * 60_000, ...limits,
  };
  const voteIpLimiter = createRateLimiter({ windowMs: lim.voteWindowMs, max: lim.votesPerIp });
  const voteVoterLimiter = createRateLimiter({ windowMs: lim.voteWindowMs, max: lim.votesPerVoter });
  const submitLimiter = createRateLimiter({ windowMs: lim.submitWindowMs, max: lim.submitsPerIp });
  let qrSvg = null;

  /** ContestError → its status; JSON body errors → 413/400; anything else → router 500. */
  const handle = (fn) => async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof ContestError) {
        return sendJson(res, err.status, { ok: false, error: err.message, ...(err.extra || {}) });
      }
      throw err;
    }
  };

  async function jsonBody(req, res, maxBytes) {
    try {
      return await readJsonBody(req, { maxBytes, destroyOnOverflow: false });
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') {
        if (typeof res.on === 'function') res.on('finish', () => req.destroy());
        throw new ContestError(413, 'That request is too large.');
      }
      throw new ContestError(400, 'bad JSON body');
    }
  }

  async function serveFile(res, file, cacheControl) {
    let buf;
    try {
      buf = await readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return sendText(res, 404, 'Not found');
      throw err;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cacheControl,
    });
    res.end(buf);
  }

  const page = (urlPath, file) => ({
    method: 'GET',
    match: (url) => pathOf(url) === urlPath,
    handler: (req, res) => serveFile(res, join(publicDir, file), 'no-cache'),
  });

  const adminState = () => ({ ok: true, state: adminView(store.read(), now()) });

  /** JSON admin action: run `apply(state, body, now)` through store.update, answer adminView. */
  const admin = (action, apply, after) => ({
    method: 'POST',
    match: (url) => pathOf(url) === `/api/contest/admin/${action}`,
    handler: handle(async (req, res) => {
      const body = await jsonBody(req, res, 64 * 1024);
      const t = now();
      await store.update((s) => apply(s, body, t));
      if (after) await after(body);
      return sendJson(res, 200, adminState());
    }),
  });

  /** Save a photo for a dish that already exists and bump its photoVersion. */
  async function attachPhoto(dishId, file) {
    const buf = await readFile(file.path);
    await store.savePhoto(dishId, buf);
    await store.update((s) => setDishPhoto(s, dishId));
  }

  /** Create a dish (via `create`), then its photo; roll the dish back if the photo fails. */
  async function createWithPhoto(fields, file, create) {
    const state = store.read();
    const v = validateDishFields(fields, state);
    if (!v.ok) throw new ContestError(400, v.error);
    if (!file) throw new ContestError(400, 'A photo of the dish is required.');
    const result = await store.update((s) => create(s, fields));
    const dishId = result.dish.id;
    const editToken = result.editToken;
    try {
      await attachPhoto(dishId, file);
    } catch (err) {
      await store.update(removeDishRaw(dishId)).catch(() => {});
      try { store.deletePhoto(dishId); } catch { /* nothing stored */ }
      if (err instanceof ContestError) throw err;
      throw new ContestError(400, 'That file is not a supported image');
    }
    return { dishId, editToken };
  }

  const routes = [
    // ---- public pages -------------------------------------------------------
    page('/contest/vote', 'vote.html'),
    page('/contest/enter', 'enter.html'),
    page('/contest/tv', 'tv.html'),
    {
      method: 'GET',
      match: (url) => pathOf(url).startsWith('/contest/assets/'),
      handler: (req, res) => {
        const name = pathOf(req.url).slice('/contest/assets/'.length);
        if (!ASSET_NAME.test(name) || name.includes('..')) return sendText(res, 404, 'Not found');
        return serveFile(res, join(publicDir, 'assets', name), 'no-cache');
      },
    },
    {
      method: 'GET',
      match: (url) => PHOTO_PATH.test(pathOf(url)),
      handler: async (req, res) => {
        const id = pathOf(req.url).match(PHOTO_PATH)[1];
        if (!isUuidV4(id)) return sendText(res, 404, 'Not found');
        let buf;
        try {
          buf = await readFile(store.photoPath(id));
        } catch (err) {
          if (err.code === 'ENOENT') return sendText(res, 404, 'Not found');
          throw err;
        }
        res.writeHead(200, {
          'Content-Type': 'image/webp',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(buf);
      },
    },
    {
      method: 'GET',
      match: (url) => pathOf(url) === '/contest/qr.svg',
      handler: async (req, res) => {
        if (!qrSvg) qrSvg = QRCode.toString(`${publicBase}/contest/vote`, { type: 'svg', margin: 1 });
        let svg;
        try {
          svg = await qrSvg;
        } catch (err) {
          qrSvg = null;
          throw err;
        }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
        res.end(svg);
      },
    },

    // ---- public JSON --------------------------------------------------------
    {
      method: 'GET',
      match: (url) => pathOf(url) === '/api/contest/public',
      handler: handle(async (req, res) => sendJson(res, 200, { ok: true, ...publicView(store.read(), now()) })),
    },
    {
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/vote',
      handler: handle(async (req, res) => {
        if (!voteIpLimiter.check(getClientIp(req))) {
          return refuseAndClose(req, res, 429, 'Too many votes from this network. Please wait a few minutes.');
        }
        const body = await jsonBody(req, res, 1024);
        const { voterId, categoryId, dishId } = body;
        if (!isUuidV4(voterId)) throw new ContestError(400, 'invalid voter id');
        if (!voteVoterLimiter.check(voterId)) {
          return sendJson(res, 429, { ok: false, error: 'Too many changes. Please wait a few minutes.' });
        }
        try {
          const result = await store.update((s) => castVote(s, now(), { voterId, categoryId, dishId }));
          return sendJson(res, 200, { ok: true, ballot: { ...result.ballot } });
        } catch (err) {
          if (err instanceof ContestError && err.status === 409) {
            err.extra = { ballot: ballotFor(store.read(), voterId), phase: effectivePhase(store.read(), now()) };
          }
          throw err;
        }
      }),
    },
    {
      method: 'GET',
      match: (url) => pathOf(url) === '/api/contest/my-ballot',
      handler: handle(async (req, res) => {
        const voterId = queryOf(req.url).get('voterId');
        if (!isUuidV4(voterId)) throw new ContestError(400, 'invalid voter id');
        const state = store.read();
        return sendJson(res, 200, { ok: true, ballot: ballotFor(state, voterId), phase: effectivePhase(state, now()) });
      }),
    },
    {
      method: 'GET',
      match: (url) => pathOf(url) === '/api/contest/submission-form',
      handler: handle(async (req, res) => {
        const state = store.read();
        return sendJson(res, 200, {
          ok: true,
          title: state.title,
          submissionsOpen: Boolean(state.submissionsOpen) && state.phase === 'setup',
          categories: state.categories.map(({ id, name }) => ({ id, name })),
          allergens: { ...ALLERGEN_LABELS },
        });
      }),
    },
    {
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/submit',
      handler: handle(async (req, res) => {
        if (!submitLimiter.check(getClientIp(req))) {
          return refuseAndClose(req, res, 429, 'Too many entries from this network. Please try again later.');
        }
        return withUpload(upload, req, res, async (body, file) => {
          const fields = dishFields(body);
          const { editToken } = await createWithPhoto(fields, file, (s, f) => submitDish(s, now(), f));
          return sendJson(res, 200, { ok: true, editUrl: `/contest/enter?edit=${encodeURIComponent(editToken)}` });
        });
      }),
    },
    {
      method: 'GET',
      match: (url) => pathOf(url) === '/api/contest/submission',
      handler: handle(async (req, res) => {
        const state = store.read();
        const dish = findByToken(state, queryOf(req.url).get('token'));
        if (!dish) throw new ContestError(404, 'entry not found');
        return sendJson(res, 200, { ok: true, dish: ownDishView(dish, state, now()) });
      }),
    },
    {
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/submission',
      handler: handle(async (req, res) => withUpload(upload, req, res, async (body, file) => {
        const token = queryOf(req.url).get('token');
        const fields = dishFields(body);
        // Validate token, phase and fields on a copy before touching the photo.
        const { dish } = updateOwnDish(store.read(), now(), token, fields);
        if (file) {
          const buf = await readFile(file.path);
          await store.savePhoto(dish.id, buf);
        }
        await store.update((s) => {
          const r = updateOwnDish(s, now(), token, fields);
          return file ? setDishPhoto(r.state, dish.id) : r.state;
        });
        const state = store.read();
        return sendJson(res, 200, { ok: true, dish: ownDishView(state.dishes.find((d) => d.id === dish.id), state, now()) });
      })),
    },

    // ---- admin (auth enforced by index.js: none of these paths are public) ----
    page('/contest/admin', 'admin.html'),
    {
      method: 'GET',
      match: (url) => pathOf(url) === '/api/contest/admin/state',
      handler: handle(async (req, res) => sendJson(res, 200, adminState())),
    },
    admin('title', (s, b) => setTitle(s, b.title)),
    admin('category-add', (s, b) => addCategory(s, b.name)),
    admin('category-rename', (s, b) => renameCategory(s, b.id, b.name)),
    admin('category-delete', (s, b) => deleteCategory(s, b.id)),
    admin('category-reorder', (s, b) => reorderCategories(s, b.ids)),
    admin('dish-approve', (s, b) => approveDish(s, b.id)),
    admin('dish-unapprove', (s, b) => unapproveDish(s, b.id)),
    admin('dish-delete', (s, b) => deleteDish(s, b.id), (b) => {
      if (isUuidV4(b.id)) store.deletePhoto(b.id);
    }),
    admin('dish-reorder', (s, b) => reorderDishes(s, b.ids)),
    admin('submissions', (s, b) => setSubmissionsOpen(s, b.open)),
    admin('open', (s, b, t) => openVoting(s, t, deadlineFrom(b, t))),
    admin('extend', (s, b, t) => extendDeadline(s, t, deadlineFrom(b, t))),
    admin('close', (s, b, t) => closeVoting(s, t)),
    admin('reveal-start', (s, b, t) => startReveal(s, t)),
    admin('reveal-next', (s) => revealNext(s)),
    admin('reveal-back', (s) => revealBack(s)),
    {
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/admin/reset',
      handler: handle(async (req, res) => {
        const body = await jsonBody(req, res, 64 * 1024);
        await store.archiveAndReset({ keepDishes: body.keepDishes === true });
        return sendJson(res, 200, adminState());
      }),
    },
    {
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/admin/dish-add',
      handler: handle(async (req, res) => withUpload(upload, req, res, async (body, file) => {
        await createWithPhoto(dishFields(body), file, (s, f) => adminAddDish(s, f));
        return sendJson(res, 200, adminState());
      })),
    },
    {
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/admin/dish-update',
      handler: handle(async (req, res) => withUpload(upload, req, res, async (body, file) => {
        const id = typeof body.id === 'string' ? body.id : '';
        const fields = dishFields(body);
        adminUpdateDish(store.read(), id, fields); // validate before touching the photo
        if (file) {
          const buf = await readFile(file.path);
          await store.savePhoto(id, buf);
        }
        await store.update((s) => {
          const next = adminUpdateDish(s, id, fields);
          return file ? setDishPhoto(next, id) : next;
        });
        return sendJson(res, 200, adminState());
      })),
    },
  ];
  return routes;
}

const defaultUploadDir = join(ROOT, 'data', '.uploads-tmp');
fs.mkdirSync(defaultUploadDir, { recursive: true });

export default createContestRoutes({
  store: createContestStore({ dir: join(ROOT, 'data', 'contest') }),
  upload: multer({ dest: defaultUploadDir, limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 40, fieldSize: 16 * 1024 } }),
});
