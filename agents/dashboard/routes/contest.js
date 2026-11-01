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
import { importRecipeFromUrl, RecipeImportError } from '../../../lib/recipe-import.js';
import {
  ContestError, ALLERGEN_LABELS, LIMITS, isUuidV4, effectivePhase, publicView, adminView, ballotFor, photoUrl,
  castVote, validateDishFields, submitDish, findByToken, updateOwnDish, setDishPhoto,
  setTitle, addCategory, renameCategory, deleteCategory, reorderCategories,
  adminAddDish, adminUpdateDish, approveDish, unapproveDish, deleteDish, reorderDishes,
  setSubmissionsOpen, openVoting, extendDeadline, closeVoting, startReveal, revealNext, revealBack,
} from '../../../lib/contest.js';

const PUBLIC_EXACT = new Set([
  '/contest/vote', '/contest/enter', '/contest/tv', '/contest/qr.svg',
  '/api/contest/public', '/api/contest/vote', '/api/contest/my-ballot',
  '/api/contest/submission-form', '/api/contest/submit', '/api/contest/submission',
  '/api/contest/recipe-import',
]);
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Versioned photo files only: /contest/photos/<dishId>-<version>.webp
const PHOTO_PATH = /^\/contest\/photos\/([0-9a-f-]{36})-([1-9][0-9]{0,8})\.webp$/i;

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
  LIMIT_FIELD_VALUE: 'Some of the text you entered is too long. Please shorten it and try again.',
  LIMIT_FIELD_COUNT: 'That form has too many fields. Please reload the page and try again.',
};

/** Multer limits for the contest uploads (photo 20 MB, text fields 64 KB each). */
export const UPLOAD_LIMITS = { fileSize: 20 * 1024 * 1024, files: 1, fields: 40, fieldSize: 64 * 1024 };

/**
 * Default rate limits. Votes are per 10 minutes, submissions and recipe imports per hour.
 * maxConcurrentImports caps outbound recipe fetches process-wide (each may hold up to
 * 3 MB for up to 8 s on a 961 MB box shared with the whole dashboard).
 */
export const DEFAULT_LIMITS = {
  votesPerIp: 3000, votesPerVoter: 60, voteWindowMs: 10 * 60_000,
  submitsPerIp: 60, submitWindowMs: 60 * 60_000,
  importsPerIp: 30, importWindowMs: 60 * 60_000, maxConcurrentImports: 4,
};

const OPEN_FAILED = "We couldn't open that page. Check the link, or type your recipe below.";
const UNREADABLE = "That link isn't a recipe page we can read. You can type your recipe below.";
const NOT_A_LINK = "That doesn't look like a web link. Paste the full address, starting with https://";
/** RecipeImportError code → [status, message]. Plain words, never the fetched content. */
export const RECIPE_IMPORT_MESSAGES = {
  no_recipe: [422, "We couldn't find a recipe card on that page. You can type your ingredients and recipe below."],
  unreachable: [422, OPEN_FAILED],
  http_error: [422, OPEN_FAILED],
  site_blocked: [422, "That site doesn't let us read its recipes automatically. Please type your ingredients and recipe below."],
  timeout: [422, 'That site took too long to answer. Try again, or type your recipe below.'],
  not_html: [422, UNREADABLE],
  too_large: [422, UNREADABLE],
  bad_url: [400, NOT_A_LINK],
  blocked_url: [400, NOT_A_LINK],
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
    photoUrl: photoUrl(dish),
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
  importRecipe = importRecipeFromUrl,
} = {}) {
  if (!store) throw new Error('createContestRoutes requires a store');
  if (!upload) throw new Error('createContestRoutes requires an upload (multer) instance');
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const voteIpLimiter = createRateLimiter({ windowMs: lim.voteWindowMs, max: lim.votesPerIp });
  const voteVoterLimiter = createRateLimiter({ windowMs: lim.voteWindowMs, max: lim.votesPerVoter });
  const submitLimiter = createRateLimiter({ windowMs: lim.submitWindowMs, max: lim.submitsPerIp });
  const importLimiter = createRateLimiter({ windowMs: lim.importWindowMs, max: lim.importsPerIp });
  let importsInFlight = 0;
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

  // One photo operation per dish at a time, so two uploads never stage the same version.
  const dishLocks = new Map();
  function withDishLock(dishId, fn) {
    const prior = dishLocks.get(dishId) || Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => {});
    dishLocks.set(dishId, tail);
    tail.then(() => { if (dishLocks.get(dishId) === tail) dishLocks.delete(dishId); });
    return run;
  }

  /**
   * Replace a dish's photo: stage photos/<id>-<v+1>.webp FIRST, then run `mutate(state, v)`
   * (which must bump photoVersion via setDishPhoto(state, id, v)) in one store update. A failed
   * update deletes the staged file; a successful one deletes the previous version's file.
   */
  function withNewPhoto(dishId, file, mutate) {
    return withDishLock(dishId, async () => {
      const dish = store.read().dishes.find((d) => d.id === dishId);
      if (!dish) throw new ContestError(404, 'dish not found');
      const prev = dish.photoVersion || 0;
      const buf = await readFile(file.path);
      await store.savePhoto(dishId, prev + 1, buf);
      let result;
      try {
        result = await store.update((s) => mutate(s, prev));
      } catch (err) {
        try { store.deletePhoto(dishId, prev + 1); } catch { /* nothing staged */ }
        throw err;
      }
      if (prev > 0) {
        try { store.deletePhoto(dishId, prev); } catch { /* already gone */ }
      }
      return result;
    });
  }

  /** Save a photo for a dish that already exists and bump its photoVersion. */
  function attachPhoto(dishId, file) {
    return withNewPhoto(dishId, file, (s, prev) => setDishPhoto(s, dishId, prev));
  }

  /** Create a dish (via `create`), then its photo; roll the dish back if the photo fails. */
  async function createWithPhoto(fields, file, create, { requirePhoto = true } = {}) {
    const state = store.read();
    const v = validateDishFields(fields, state);
    if (!v.ok) throw new ContestError(400, v.error);
    if (!file && requirePhoto) throw new ContestError(400, 'A photo of the dish is required.');
    const result = await store.update((s) => create(s, fields));
    const dishId = result.dish.id;
    const editToken = result.editToken;
    if (!file) return { dishId, editToken };
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
        const [, id, version] = pathOf(req.url).match(PHOTO_PATH);
        if (!isUuidV4(id)) return sendText(res, 404, 'Not found');
        let buf;
        try {
          buf = await readFile(store.photoPath(id, Number(version)));
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
        // Refuse before parsing the upload, so a closed or full contest never reads 20 MB.
        const st = store.read();
        if (!st.submissionsOpen || st.phase !== 'setup') {
          return refuseAndClose(req, res, 409, 'dish entries are closed');
        }
        if (st.dishes.length >= LIMITS.maxDishes) {
          return refuseAndClose(req, res, 409, `the contest is full (${LIMITS.maxDishes} dishes)`);
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
      handler: handle(async (req, res) => {
        if (!submitLimiter.check(getClientIp(req))) {
          return refuseAndClose(req, res, 429, 'Too many changes from this network. Please try again later.');
        }
        const token = queryOf(req.url).get('token');
        // Refuse before parsing the upload: unknown token or a contest past setup.
        const st = store.read();
        if (!findByToken(st, token)) return refuseAndClose(req, res, 404, 'entry not found');
        if (st.phase !== 'setup') return refuseAndClose(req, res, 409, 'entries can no longer be edited');
        return withUpload(upload, req, res, async (body, file) => {
          const fields = dishFields(body);
          // Validate token, phase and fields on a copy before touching the photo.
          const { dish } = updateOwnDish(store.read(), now(), token, fields);
          if (file) {
            await withNewPhoto(dish.id, file, (s, prev) => {
              const r = updateOwnDish(s, now(), token, fields, { newPhoto: true });
              return setDishPhoto(r.state, dish.id, prev);
            });
          } else {
            await store.update((s) => updateOwnDish(s, now(), token, fields).state);
          }
          const state = store.read();
          return sendJson(res, 200, { ok: true, dish: ownDishView(state.dishes.find((d) => d.id === dish.id), state, now()) });
        });
      }),
    },
    {
      // Read a recipe card from a link the cook pasted. Public, so: per-IP limit, a
      // process-wide in-flight cap, a 2 KB body, setup phase only, and the importer
      // (lib/recipe-import.js) does the private-address guard, byte cap and timeout.
      method: 'POST',
      match: (url) => pathOf(url) === '/api/contest/recipe-import',
      handler: handle(async (req, res) => {
        if (!importLimiter.check(getClientIp(req))) {
          return refuseAndClose(req, res, 429, 'You have fetched a lot of recipes. Please wait a while, or type your recipe below.');
        }
        if (store.read().phase !== 'setup') {
          return refuseAndClose(req, res, 409, 'Entries can no longer be changed, so recipe links are closed.');
        }
        const body = await jsonBody(req, res, 2048);
        const fail = (code) => {
          const [status, error] = RECIPE_IMPORT_MESSAGES[code] || RECIPE_IMPORT_MESSAGES.unreachable;
          return sendJson(res, status, { ok: false, code: RECIPE_IMPORT_MESSAGES[code] ? code : 'unreachable', error });
        };
        const url = body && typeof body.url === 'string' ? body.url.trim() : '';
        if (!url) return fail('bad_url');
        if (importsInFlight >= lim.maxConcurrentImports) {
          return sendJson(res, 429, { ok: false, code: 'busy', error: 'Lots of people are fetching recipes right now. Please try again in a minute.' });
        }
        importsInFlight += 1;
        try {
          const recipe = await importRecipe(url);
          return sendJson(res, 200, { ok: true, recipe });
        } catch (err) {
          return fail(err instanceof RecipeImportError ? err.code : 'unreachable');
        } finally {
          importsInFlight -= 1;
        }
      }),
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
      if (isUuidV4(b.id)) store.deletePhoto(b.id); // every version
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
        // The admin may add a dish without a photo (competitor entries still need one).
        await createWithPhoto(dishFields(body), file, (s, f) => adminAddDish(s, f), { requirePhoto: false });
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
          await withNewPhoto(id, file, (s, prev) => setDishPhoto(adminUpdateDish(s, id, fields), id, prev));
        } else {
          await store.update((s) => adminUpdateDish(s, id, fields));
        }
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
  upload: multer({ dest: defaultUploadDir, limits: UPLOAD_LIMITS }),
});
