// lib/contest.js
// Pure rules for the church dish-contest voting app. No I/O: every function
// takes a state object and returns a NEW one (or throws ContestError). Time is
// always passed in as a Date.
import { randomUUID } from 'node:crypto';

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
