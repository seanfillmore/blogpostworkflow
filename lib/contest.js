// lib/contest.js
// Pure rules for the church dish-contest voting app. No I/O: every function
// takes a state object and returns a NEW one (or throws ContestError). Time is
// always passed in as a Date.
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export class ContestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ContestError';
    this.status = status;
  }
}

export const ALLOWED_ALLERGENS = [
  'milk', 'eggs', 'fish', 'shellfish', 'tree-nuts', 'peanuts', 'wheat', 'soy', 'sesame', 'citrus',
];

export const ALLERGEN_LABELS = {
  milk: 'Milk',
  eggs: 'Eggs',
  fish: 'Fish',
  shellfish: 'Shellfish',
  'tree-nuts': 'Tree nuts',
  peanuts: 'Peanuts',
  wheat: 'Wheat',
  soy: 'Soy',
  sesame: 'Sesame',
  citrus: 'Citrus',
  none: 'None of these',
};

export const LIMITS = {
  cookName: 80,
  dishName: 80,
  ingredients: 2000,
  recipe: 8000,
  categoryName: 40,
  title: 80,
  maxCategories: 5,
  maxDishes: 80,
  maxVoters: 1000,
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(s) {
  return typeof s === 'string' && UUID_V4.test(s);
}

const clone = (s) => structuredClone(s);

function cleanText(value, field, max, { required = true } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) {
    if (required) throw new ContestError(400, `${field} is required`);
    return '';
  }
  if (v.length > max) throw new ContestError(400, `${field} must be ${max} characters or fewer`);
  return v;
}

export function emptyContest(now) {
  return {
    title: 'Dish Contest',
    phase: 'setup',
    deadline: null,
    closedAt: null,
    submissionsOpen: false,
    categories: [],
    dishes: [],
    ballots: {},
    voteEvents: 0,
    reveal: { categoryIndex: 0, step: 0 },
    createdAt: now.toISOString(),
  };
}

export function effectivePhase(state, now) {
  if (state.phase === 'open' && state.deadline && now.getTime() > new Date(state.deadline).getTime()) {
    return 'closed';
  }
  return state.phase;
}

// ---- title and categories -------------------------------------------------

export function setTitle(state, title) {
  const s = clone(state);
  s.title = cleanText(title, 'title', LIMITS.title);
  return s;
}

export function addCategory(state, name) {
  const s = clone(state);
  const clean = cleanText(name, 'category name', LIMITS.categoryName);
  if (s.categories.length >= LIMITS.maxCategories) {
    throw new ContestError(400, `at most ${LIMITS.maxCategories} categories`);
  }
  const category = { id: randomUUID(), name: clean };
  s.categories.push(category);
  return { state: s, category };
}

export function renameCategory(state, id, name) {
  const s = clone(state);
  const cat = s.categories.find((c) => c.id === id);
  if (!cat) throw new ContestError(404, 'category not found');
  cat.name = cleanText(name, 'category name', LIMITS.categoryName);
  return s;
}

function applyOrder(list, ids, label) {
  if (!Array.isArray(ids) || ids.length !== list.length || new Set(ids).size !== ids.length) {
    throw new ContestError(400, `${label} order must list every item exactly once`);
  }
  const byId = new Map(list.map((x) => [x.id, x]));
  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new ContestError(400, `${label} order lists an unknown id`);
    return item;
  });
}

export function reorderCategories(state, ids) {
  const s = clone(state);
  s.categories = applyOrder(s.categories, ids, 'category');
  return s;
}

export function deleteCategory(state, id) {
  const s = clone(state);
  if (!s.categories.some((c) => c.id === id)) throw new ContestError(404, 'category not found');
  if (s.dishes.some((d) => d.categoryId === id)) {
    throw new ContestError(409, 'remove the dishes in this category first');
  }
  s.categories = s.categories.filter((c) => c.id !== id);
  return s;
}

// ---- phase transitions ----------------------------------------------------

function asDate(d, what) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) throw new ContestError(400, `${what} is not a valid date`);
  return date;
}

export function openVoting(state, now, deadline) {
  const s = clone(state);
  const canOpen = s.phase === 'setup'
    || (s.phase === 'closed' && s.reveal.step === 0 && s.reveal.categoryIndex === 0);
  if (!canOpen) throw new ContestError(409, 'voting cannot be opened from this phase');
  const dl = asDate(deadline, 'deadline');
  if (dl.getTime() <= now.getTime()) throw new ContestError(400, 'deadline must be in the future');
  const approved = s.dishes.some((d) => d.status === 'approved');
  if (!approved) throw new ContestError(409, 'approve at least one dish before opening voting');
  s.phase = 'open';
  s.deadline = dl.toISOString();
  s.closedAt = null;
  s.submissionsOpen = false;
  return s;
}

export function extendDeadline(state, now, deadline) {
  if (effectivePhase(state, now) !== 'open') throw new ContestError(409, 'voting is not open');
  const s = clone(state);
  const dl = asDate(deadline, 'deadline');
  if (dl.getTime() <= now.getTime()) throw new ContestError(400, 'deadline must be in the future');
  s.deadline = dl.toISOString();
  return s;
}

export function closeVoting(state, now) {
  if (state.phase !== 'open') throw new ContestError(409, 'voting is not open');
  const s = clone(state);
  s.phase = 'closed';
  s.closedAt = now.toISOString();
  if (!s.deadline || new Date(s.deadline).getTime() > now.getTime()) s.deadline = now.toISOString();
  return s;
}

// ---- voting ---------------------------------------------------------------

export function castVote(state, now, { voterId, categoryId, dishId } = {}) {
  if (effectivePhase(state, now) !== 'open') throw new ContestError(409, 'Voting is closed');
  if (!isUuidV4(voterId)) throw new ContestError(400, 'invalid voter id');
  if (!state.categories.some((c) => c.id === categoryId)) throw new ContestError(404, 'category not found');
  const dish = state.dishes.find((d) => d.id === dishId);
  if (!dish || dish.status !== 'approved' || dish.categoryId !== categoryId) {
    throw new ContestError(404, 'dish not found in this category');
  }
  const s = clone(state);
  const isNew = !Object.hasOwn(s.ballots, voterId);
  if (isNew && Object.keys(s.ballots).length >= LIMITS.maxVoters) {
    throw new ContestError(409, 'the contest has reached its voter limit');
  }
  const ballot = isNew ? {} : s.ballots[voterId];
  if (ballot[categoryId] !== dishId) {
    ballot[categoryId] = dishId;
    s.voteEvents += 1;
  }
  s.ballots[voterId] = ballot;
  return { state: s, ballot: ballotFor(s, voterId) };
}

export function ballotFor(state, voterId) {
  const raw = Object.hasOwn(state.ballots, voterId) ? state.ballots[voterId] : {};
  const out = {};
  for (const [categoryId, dishId] of Object.entries(raw)) {
    const dish = state.dishes.find((d) => d.id === dishId);
    if (dish && dish.status === 'approved' && dish.categoryId === categoryId) out[categoryId] = dishId;
  }
  return out;
}

// ---- ranking and reveal ---------------------------------------------------

const PLACE_FOR_STEP = { 1: 3, 2: 2, 3: 1 };

function approvedIn(state, categoryId) {
  return state.dishes.filter((d) => d.status === 'approved' && d.categoryId === categoryId);
}

function countsFor(state, categoryId) {
  const counts = new Map(approvedIn(state, categoryId).map((d) => [d.id, 0]));
  for (const ballot of Object.values(state.ballots)) {
    const pick = ballot[categoryId];
    if (counts.has(pick)) counts.set(pick, counts.get(pick) + 1);
  }
  return counts;
}

/** Competition ranking per category. Ties share a place; 0 votes or place > 3 gets null. */
export function tally(state) {
  const out = {};
  for (const cat of state.categories) {
    const rows = [...countsFor(state, cat.id)].map(([dishId, votes]) => ({ dishId, votes }));
    rows.sort((x, y) => y.votes - x.votes); // stable: ties keep admin order
    out[cat.id] = rows.map((row, i) => {
      const place = 1 + rows.filter((r) => r.votes > row.votes).length;
      return { dishId: row.dishId, votes: row.votes, place: row.votes > 0 && place <= 3 ? place : null, _i: i };
    }).map(({ _i, ...r }) => r);
  }
  return out;
}

/** The reveal steps that actually have a dish behind them: step 1 = 3rd, 2 = 2nd, 3 = 1st. */
export function revealSteps(state, categoryId) {
  const rows = tally(state)[categoryId] || [];
  const steps = [];
  for (const step of [1, 2, 3]) {
    const place = PLACE_FOR_STEP[step];
    const held = rows.filter((r) => r.place === place);
    if (held.length) steps.push({ step, place, dishIds: held.map((r) => r.dishId) });
  }
  return steps;
}

export function startReveal(state, now) {
  if (effectivePhase(state, now) !== 'closed') throw new ContestError(409, 'voting must be closed first');
  const s = clone(state);
  if (s.phase === 'open') {
    s.closedAt = s.deadline;
  }
  s.phase = 'revealing';
  s.reveal = { categoryIndex: 0, step: 0 };
  return s;
}

function lastStepOf(state, categoryId) {
  const steps = revealSteps(state, categoryId);
  return steps.length ? steps[steps.length - 1].step : 0;
}

export function revealNext(state) {
  if (state.phase !== 'revealing') throw new ContestError(409, 'not revealing');
  const s = clone(state);
  const cat = s.categories[s.reveal.categoryIndex];
  const next = revealSteps(s, cat.id).find((st) => st.step > s.reveal.step);
  if (next) {
    s.reveal.step = next.step;
  } else if (s.reveal.categoryIndex + 1 < s.categories.length) {
    s.reveal = { categoryIndex: s.reveal.categoryIndex + 1, step: 0 };
  } else {
    s.phase = 'done';
  }
  return s;
}

export function revealBack(state) {
  if (state.phase !== 'revealing' && state.phase !== 'done') throw new ContestError(409, 'not revealing');
  const s = clone(state);
  if (s.phase === 'done') {
    s.phase = 'revealing';
    s.reveal = {
      categoryIndex: s.reveal.categoryIndex,
      step: lastStepOf(s, s.categories[s.reveal.categoryIndex].id),
    };
    return s;
  }
  const cat = s.categories[s.reveal.categoryIndex];
  if (s.reveal.step > 0) {
    const prior = revealSteps(s, cat.id).filter((st) => st.step < s.reveal.step);
    s.reveal.step = prior.length ? prior[prior.length - 1].step : 0;
  } else if (s.reveal.categoryIndex > 0) {
    const idx = s.reveal.categoryIndex - 1;
    s.reveal = { categoryIndex: idx, step: lastStepOf(s, s.categories[idx].id) };
  }
  return s;
}

// ---- projections ----------------------------------------------------------

function revealedFor(state, categoryId, upToStep) {
  const tallyRows = tally(state)[categoryId] || [];
  return revealSteps(state, categoryId)
    .filter((st) => st.step <= upToStep)
    .map((st) => ({
      categoryId,
      place: st.place,
      dishIds: st.dishIds,
      votes: tallyRows.find((r) => r.dishId === st.dishIds[0]).votes,
    }));
}

function photoUrl(dish) {
  return dish.photoVersion > 0 ? `/contest/photos/${dish.id}.webp?v=${dish.photoVersion}` : null;
}

/** What phones and the TV may see. Vote data appears only for places already revealed. */
export function publicView(state, now) {
  const phase = effectivePhase(state, now);
  const approved = state.dishes.filter((d) => d.status === 'approved');
  const ids = new Set(approved.map((d) => d.id));
  const catIds = new Set(state.categories.map((c) => c.id));
  let voteCount = 0;
  for (const ballot of Object.values(state.ballots)) {
    for (const [categoryId, dishId] of Object.entries(ballot)) {
      if (catIds.has(categoryId) && ids.has(dishId)) voteCount += 1;
    }
  }

  let reveal = null;
  if (phase === 'revealing' || phase === 'done') {
    const idx = state.reveal.categoryIndex;
    const current = state.categories[idx];
    const revealed = [];
    state.categories.forEach((cat, i) => {
      if (phase === 'done' || i < idx) {
        if (phase === 'done') revealed.push(...revealedFor(state, cat.id, 3));
      } else if (i === idx) {
        revealed.push(...revealedFor(state, cat.id, state.reveal.step));
      }
    });
    reveal = { categoryIndex: idx, categoryId: current ? current.id : null, revealed };
  }

  return {
    title: state.title,
    phase,
    deadline: state.deadline,
    serverNow: now.toISOString(),
    submissionsOpen: state.submissionsOpen,
    categories: state.categories.map(({ id, name }) => ({ id, name })),
    dishes: approved.map((d) => ({
      id: d.id,
      categoryId: d.categoryId,
      name: d.name,
      cook: d.cook,
      ingredients: d.ingredients,
      allergens: d.allergens,
      recipe: d.recipe,
      photoUrl: photoUrl(d),
    })),
    voterCount: Object.keys(state.ballots).length,
    voteCount,
    voteEvents: state.voteEvents,
    reveal,
  };
}

/** Everything the admin may see: full state minus token hashes, plus the live tally. */
export function adminView(state, now) {
  const s = clone(state);
  s.dishes = s.dishes.map(({ editTokenHash, ...rest }) => rest);
  return { ...s, effectivePhase: effectivePhase(state, now), serverNow: now.toISOString(), tally: tally(state) };
}

// ---- dishes and competitor submissions ------------------------------------

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

/** Trim and check a dish's fields. Never throws; the error names the offending field. */
export function validateDishFields(input, state) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (value, field, max, required) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v && required) return { error: `${field} is required` };
    if (v.length > max) return { error: `${field} must be ${max} characters or fewer` };
    return { v };
  };
  const checks = [
    ['name', text(src.name, 'name', LIMITS.dishName, true)],
    ['cook', text(src.cook, 'cook', LIMITS.cookName, true)],
    ['ingredients', text(src.ingredients, 'ingredients', LIMITS.ingredients, true)],
    ['recipe', text(src.recipe, 'recipe', LIMITS.recipe, false)],
  ];
  for (const [, r] of checks) if (r.error) return { ok: false, error: r.error };
  const [name, cook, ingredients, recipe] = checks.map(([, r]) => r.v);

  if (!state.categories.some((c) => c.id === src.categoryId)) {
    return { ok: false, error: 'category does not exist' };
  }
  const raw = Array.isArray(src.allergens) ? src.allergens : [];
  const allergens = [...new Set(raw)];
  if (!allergens.length) return { ok: false, error: 'allergens: choose at least one option (or "none")' };
  if (allergens.some((a) => a !== 'none' && !ALLOWED_ALLERGENS.includes(a))) {
    return { ok: false, error: 'allergens contains an unknown option' };
  }
  if (allergens.includes('none') && allergens.length > 1) {
    return { ok: false, error: 'allergens: "none" cannot be combined with other options' };
  }
  return { ok: true, value: { categoryId: src.categoryId, name, cook, ingredients, recipe, allergens } };
}

function validOrThrow(input, state) {
  const r = validateDishFields(input, state);
  if (!r.ok) throw new ContestError(400, r.error);
  return r.value;
}

function newDish(value, status, source, extra = {}) {
  return {
    id: randomUUID(), ...value, status, source, editedSinceApproval: false, photoVersion: 0, ...extra,
  };
}

function guardCapacity(s) {
  if (s.dishes.length >= LIMITS.maxDishes) {
    throw new ContestError(409, `the contest is full (${LIMITS.maxDishes} dishes)`);
  }
}

export function submitDish(state, now, fields) {
  if (!state.submissionsOpen || state.phase !== 'setup') {
    throw new ContestError(409, 'dish entries are closed');
  }
  guardCapacity(state);
  const value = validOrThrow(fields, state);
  const s = clone(state);
  const editToken = randomBytes(32).toString('base64url');
  const dish = newDish(value, 'pending', 'competitor', {
    editTokenHash: sha256(editToken), submittedAt: now.toISOString(),
  });
  s.dishes.push(dish);
  return { state: s, dish, editToken };
}

export function findByToken(state, token) {
  if (typeof token !== 'string' || !token) return null;
  const want = Buffer.from(sha256(token), 'hex');
  let found = null;
  for (const d of state.dishes) {
    if (!d.editTokenHash) continue;
    const have = Buffer.from(d.editTokenHash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) found = d;
  }
  return found;
}

export function updateOwnDish(state, now, token, fields) {
  const owned = findByToken(state, token);
  if (!owned) throw new ContestError(404, 'entry not found');
  if (state.phase !== 'setup') throw new ContestError(409, 'entries can no longer be edited');
  const value = validOrThrow(fields, state);
  const s = clone(state);
  const dish = s.dishes.find((d) => d.id === owned.id);
  Object.assign(dish, value);
  if (dish.status === 'approved') dish.editedSinceApproval = true;
  return { state: s, dish };
}

function guardAdminEdit(state) {
  if (state.phase === 'revealing' || state.phase === 'done') {
    throw new ContestError(409, 'dishes cannot be changed once the reveal has started');
  }
}

function findOrThrow(s, id) {
  const dish = s.dishes.find((d) => d.id === id);
  if (!dish) throw new ContestError(404, 'dish not found');
  return dish;
}

export function adminAddDish(state, fields) {
  guardAdminEdit(state);
  guardCapacity(state);
  const value = validOrThrow(fields, state);
  const s = clone(state);
  const dish = newDish(value, 'approved', 'admin');
  s.dishes.push(dish);
  return { state: s, dish };
}

export function adminUpdateDish(state, id, fields) {
  guardAdminEdit(state);
  const value = validOrThrow(fields, state);
  const s = clone(state);
  const dish = findOrThrow(s, id);
  Object.assign(dish, value);
  dish.editedSinceApproval = false;
  return s;
}

export function approveDish(state, id) {
  const s = clone(state);
  const dish = findOrThrow(s, id);
  dish.status = 'approved';
  dish.editedSinceApproval = false;
  return s;
}

export function unapproveDish(state, id) {
  const s = clone(state);
  findOrThrow(s, id).status = 'pending';
  return s;
}

export function deleteDish(state, id) {
  const s = clone(state);
  findOrThrow(s, id);
  s.dishes = s.dishes.filter((d) => d.id !== id);
  return s;
}

export function setDishPhoto(state, id) {
  const s = clone(state);
  const dish = findOrThrow(s, id);
  dish.photoVersion = (dish.photoVersion || 0) + 1;
  return s;
}

export function setSubmissionsOpen(state, open) {
  const s = clone(state);
  s.submissionsOpen = Boolean(open);
  return s;
}

export function reorderDishes(state, ids) {
  const s = clone(state);
  s.dishes = applyOrder(s.dishes, ids, 'dish');
  return s;
}
