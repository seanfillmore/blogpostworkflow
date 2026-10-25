// tests/lib/contest-dishes.test.js
// Dish validation, competitor submissions and admin dish management.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ContestError, emptyContest, addCategory, openVoting, castVote, ballotFor, tally, publicView, adminView,
  validateDishFields, submitDish, findByToken, updateOwnDish, adminAddDish, adminUpdateDish,
  approveDish, unapproveDish, deleteDish, reorderCategories, deleteCategory, setDishPhoto, setSubmissionsOpen, reorderDishes, LIMITS,
} from '../../lib/contest.js';

const T0 = new Date('2026-11-01T12:00:00Z');
const DEADLINE = new Date('2026-11-01T14:00:00Z');
const throwsStatus = (fn, status) => assert.throws(fn, (e) => e instanceof ContestError && e.status === status);

function setup() {
  let state = emptyContest(T0);
  const c = addCategory(state, 'Mains');
  return { state: setSubmissionsOpen(c.state, true), cat: c.category };
}
const fields = (cat, over = {}) => ({
  categoryId: cat.id, name: 'Chili', cook: 'Pat', ingredients: 'beans, beef', allergens: ['none'], recipe: '', ...over,
});

test('validateDishFields trims and returns a clean value', () => {
  const { state, cat } = setup();
  const r = validateDishFields(fields(cat, { name: '  Chili  ', allergens: ['milk', 'milk', 'citrus'] }), state);
  assert.equal(r.ok, true);
  assert.equal(r.value.name, 'Chili');
  assert.deepEqual(r.value.allergens, ['milk', 'citrus']);
});

test('validateDishFields names the field that is wrong', () => {
  const { state, cat } = setup();
  const long = validateDishFields(fields(cat, { ingredients: 'x'.repeat(LIMITS.ingredients + 1) }), state);
  assert.equal(long.ok, false);
  assert.match(long.error, /ingredients/);
  assert.match(validateDishFields(fields(cat, { ingredients: '   ' }), state).error, /ingredients/);
  assert.match(validateDishFields(fields(cat, { cook: 'x'.repeat(81) }), state).error, /cook/);
  assert.match(validateDishFields(fields(cat, { recipe: 'x'.repeat(8001) }), state).error, /recipe/);
  assert.match(validateDishFields(fields(cat, { categoryId: randomUUID() }), state).error, /category/);
});

test('allergen rules: none must stand alone, unknowns and empty are rejected, citrus is fine', () => {
  const { state, cat } = setup();
  assert.equal(validateDishFields(fields(cat, { allergens: ['none', 'milk'] }), state).ok, false);
  assert.equal(validateDishFields(fields(cat, { allergens: ['gluten'] }), state).ok, false);
  assert.equal(validateDishFields(fields(cat, { allergens: [] }), state).ok, false);
  assert.equal(validateDishFields(fields(cat, { allergens: 'milk' }), state).ok, false);
  assert.equal(validateDishFields(fields(cat, { allergens: ['citrus'] }), state).ok, true);
  assert.equal(validateDishFields(null, state).ok, false);
});

test('submitDish is a 409 unless submissions are open and the contest is in setup', () => {
  const { state, cat } = setup();
  throwsStatus(() => submitDish(setSubmissionsOpen(state, false), T0, fields(cat)), 409);
  const withDish = adminAddDish(state, fields(cat));
  const open = openVoting(withDish.state, T0, DEADLINE);
  throwsStatus(() => submitDish(setSubmissionsOpen(open, true), T0, fields(cat)), 409);
  throwsStatus(() => submitDish(state, T0, fields(cat, { name: '' })), 400);
});

test('a submission is pending, hashed, hidden from the public view until approved', () => {
  const { state, cat } = setup();
  const { state: s, dish, editToken } = submitDish(state, T0, fields(cat));
  assert.equal(dish.status, 'pending');
  assert.equal(dish.source, 'competitor');
  assert.ok(editToken.length >= 43, '32 random bytes in base64url');
  assert.notEqual(dish.editTokenHash, editToken);
  assert.ok(!JSON.stringify(s).includes(editToken), 'the raw token is never stored');
  assert.deepEqual(publicView(s, T0).dishes, []);
  assert.ok(!JSON.stringify(adminView(s, T0)).includes(dish.editTokenHash));
  const approved = approveDish(s, dish.id);
  assert.deepEqual(publicView(approved, T0).dishes.map((d) => d.id), [dish.id]);
  assert.ok(!JSON.stringify(publicView(approved, T0)).includes(dish.editTokenHash));
  assert.equal(publicView(unapproveDish(approved, dish.id), T0).dishes.length, 0);
});

test('findByToken finds the dish by its token and nothing else', () => {
  const { state, cat } = setup();
  const { state: s, dish, editToken } = submitDish(state, T0, fields(cat));
  assert.equal(findByToken(s, editToken).id, dish.id);
  assert.equal(findByToken(s, editToken + 'x'), null);
  assert.equal(findByToken(s, 'nope'), null);
  assert.equal(findByToken(s, ''), null);
  assert.equal(findByToken(s, undefined), null);
});

test('an owner edit of an approved dish flags it for re-review; the admin edit clears the flag', () => {
  const { state, cat } = setup();
  const sub = submitDish(state, T0, fields(cat));
  const approved = approveDish(sub.state, sub.dish.id);
  const edited = updateOwnDish(approved, T0, sub.editToken, fields(cat, { name: 'Better chili' }));
  assert.equal(edited.dish.name, 'Better chili');
  assert.equal(edited.dish.editedSinceApproval, true);
  assert.equal(edited.dish.status, 'approved');
  const cleared = adminUpdateDish(edited.state, sub.dish.id, fields(cat, { name: 'Better chili' }));
  assert.equal(cleared.dishes[0].editedSinceApproval, false);
  throwsStatus(() => updateOwnDish(approved, T0, 'wrong', fields(cat)), 404);
});

test('an owner edit of a pending dish does not set the flag', () => {
  const { state, cat } = setup();
  const sub = submitDish(state, T0, fields(cat));
  const edited = updateOwnDish(sub.state, T0, sub.editToken, fields(cat, { name: 'Soup' }));
  assert.equal(edited.dish.editedSinceApproval, false);
});

test('an owner edit after voting opens is a 409', () => {
  const { state, cat } = setup();
  const sub = submitDish(state, T0, fields(cat));
  const approved = approveDish(sub.state, sub.dish.id);
  const open = openVoting(approved, T0, DEADLINE);
  throwsStatus(() => updateOwnDish(open, T0, sub.editToken, fields(cat)), 409);
});

test('the 81st dish is refused', () => {
  const { state, cat } = setup();
  let s = state;
  for (let i = 0; i < LIMITS.maxDishes; i += 1) s = adminAddDish(s, fields(cat, { name: `Dish ${i}` })).state;
  throwsStatus(() => submitDish(s, T0, fields(cat)), 409);
  throwsStatus(() => adminAddDish(s, fields(cat)), 409);
});

test('adminAddDish creates an approved admin dish and works while voting is open', () => {
  const { state, cat } = setup();
  const first = adminAddDish(state, fields(cat));
  assert.equal(first.dish.status, 'approved');
  assert.equal(first.dish.source, 'admin');
  const open = openVoting(first.state, T0, DEADLINE);
  assert.equal(adminAddDish(open, fields(cat, { name: 'Late' })).state.dishes.length, 2);
});

test('deleting a voted dish drops it from ballotFor and from the tally', () => {
  const { state, cat } = setup();
  const a = adminAddDish(state, fields(cat, { name: 'A' }));
  const b = adminAddDish(a.state, fields(cat, { name: 'B' }));
  let s = openVoting(b.state, T0, DEADLINE);
  const voterId = randomUUID();
  s = castVote(s, T0, { voterId, categoryId: cat.id, dishId: a.dish.id }).state;
  assert.deepEqual(ballotFor(s, voterId), { [cat.id]: a.dish.id });
  s = deleteDish(s, a.dish.id);
  assert.deepEqual(ballotFor(s, voterId), {});
  const rows = tally(s)[cat.id];
  assert.deepEqual(rows.map((r) => r.dishId), [b.dish.id]);
  assert.equal(rows[0].votes, 0);
  assert.equal(publicView(s, T0).voteCount, 0);
  throwsStatus(() => deleteDish(s, a.dish.id), 404);
});

test('setDishPhoto bumps the version that feeds photoUrl', () => {
  const { state, cat } = setup();
  const a = adminAddDish(state, fields(cat));
  const once = setDishPhoto(a.state, a.dish.id);
  const twice = setDishPhoto(once, a.dish.id);
  assert.equal(publicView(once, T0).dishes[0].photoUrl, `/contest/photos/${a.dish.id}.webp?v=1`);
  assert.equal(twice.dishes[0].photoVersion, 2);
});

test('reorderDishes sets the order every view uses and rejects partial lists', () => {
  const { state, cat } = setup();
  const a = adminAddDish(state, fields(cat, { name: 'A' }));
  const b = adminAddDish(a.state, fields(cat, { name: 'B' }));
  const s = reorderDishes(b.state, [b.dish.id, a.dish.id]);
  assert.deepEqual(publicView(s, T0).dishes.map((d) => d.name), ['B', 'A']);
  throwsStatus(() => reorderDishes(b.state, [a.dish.id]), 400);
  throwsStatus(() => reorderDishes(b.state, [a.dish.id, a.dish.id]), 400);
});

test('dish changes are refused once the reveal has started', () => {
  const { state, cat } = setup();
  const a = adminAddDish(state, fields(cat));
  const revealing = { ...a.state, phase: 'revealing' };
  throwsStatus(() => adminAddDish(revealing, fields(cat)), 409);
  throwsStatus(() => adminUpdateDish(revealing, a.dish.id, fields(cat)), 409);
});

test('category and dish edits are refused once the reveal has started (409)', () => {
  const { state, cat } = setup();
  const a = adminAddDish(state, fields(cat));
  for (const phase of ['revealing', 'done']) {
    const s = { ...a.state, phase };
    throwsStatus(() => deleteDish(s, a.dish.id), 409);
    throwsStatus(() => approveDish(s, a.dish.id), 409);
    throwsStatus(() => unapproveDish(s, a.dish.id), 409);
    throwsStatus(() => reorderDishes(s, [a.dish.id]), 409);
    throwsStatus(() => addCategory(s, 'New'), 409);
    throwsStatus(() => deleteCategory(s, cat.id), 409);
    throwsStatus(() => reorderCategories(s, [cat.id]), 409);
  }
});
