// tests/lib/contest.test.js
// Core model, phases and voting. Dishes are built by hand here so these tests
// do not depend on the dish functions (those are covered in contest-dishes).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ContestError, emptyContest, effectivePhase, addCategory, deleteCategory, openVoting,
  extendDeadline, closeVoting, castVote, ballotFor, isUuidV4, setTitle, LIMITS,
} from '../../lib/contest.js';

const T0 = new Date('2026-11-01T12:00:00Z');
const DEADLINE = new Date('2026-11-01T14:00:00Z');

function dish(categoryId, status = 'approved') {
  return {
    id: randomUUID(), categoryId, name: 'Chili', cook: 'Pat', ingredients: 'beans',
    allergens: ['none'], recipe: '', status, source: 'admin', editedSinceApproval: false, photoVersion: 0,
  };
}

function base() {
  let state = emptyContest(T0);
  const a = addCategory(state, 'Mains'); state = a.state;
  const b = addCategory(state, 'Desserts'); state = b.state;
  const dA = dish(a.category.id);
  const dB = dish(b.category.id);
  const dPending = dish(a.category.id, 'pending');
  state.dishes.push(dA, dB, dPending);
  return { state, a: a.category, b: b.category, dA, dB, dPending };
}

const throwsStatus = (fn, status) => assert.throws(fn, (e) => e instanceof ContestError && e.status === status);

test('emptyContest starts in setup with nothing in it', () => {
  const s = emptyContest(T0);
  assert.equal(s.phase, 'setup');
  assert.equal(s.title, 'Dish Contest');
  assert.deepEqual(s.categories, []);
  assert.deepEqual(s.dishes, []);
  assert.deepEqual(s.ballots, {});
  assert.equal(s.voteEvents, 0);
  assert.equal(s.submissionsOpen, false);
  assert.deepEqual(s.reveal, { categoryIndex: 0, step: 0 });
});

test('castVote while in setup is a 409; after openVoting it succeeds and returns the ballot', () => {
  const { state, a, dA } = base();
  const voterId = randomUUID();
  throwsStatus(() => castVote(state, T0, { voterId, categoryId: a.id, dishId: dA.id }), 409);
  const open = openVoting(state, T0, DEADLINE);
  const { ballot } = castVote(open, T0, { voterId, categoryId: a.id, dishId: dA.id });
  assert.deepEqual(ballot, { [a.id]: dA.id });
});

test('changing a pick replaces it and only real changes bump voteEvents', () => {
  const { state, a, dA } = base();
  const dA2 = dish(a.id);
  state.dishes.push(dA2);
  let s = openVoting(state, T0, DEADLINE);
  const voterId = randomUUID();
  s = castVote(s, T0, { voterId, categoryId: a.id, dishId: dA.id }).state;
  assert.equal(s.voteEvents, 1);
  const changed = castVote(s, T0, { voterId, categoryId: a.id, dishId: dA2.id });
  assert.deepEqual(changed.ballot, { [a.id]: dA2.id });
  assert.equal(changed.state.voteEvents, 2);
  const same = castVote(changed.state, T0, { voterId, categoryId: a.id, dishId: dA2.id });
  assert.equal(same.state.voteEvents, 2);
});

test('the deadline is enforced on server time: closed 1ms after, open at the deadline', () => {
  const { state, a, dA } = base();
  const s = openVoting(state, T0, DEADLINE);
  const voterId = randomUUID();
  assert.equal(effectivePhase(s, DEADLINE), 'open');
  const late = new Date(DEADLINE.getTime() + 1);
  assert.equal(effectivePhase(s, late), 'closed');
  throwsStatus(() => castVote(s, late, { voterId, categoryId: a.id, dishId: dA.id }), 409);
});

test('a dish under the wrong category, a pending dish and a bad voter id are rejected', () => {
  const { state, a, b, dA, dPending } = base();
  const s = openVoting(state, T0, DEADLINE);
  const voterId = randomUUID();
  throwsStatus(() => castVote(s, T0, { voterId, categoryId: b.id, dishId: dA.id }), 404);
  throwsStatus(() => castVote(s, T0, { voterId, categoryId: a.id, dishId: dPending.id }), 404);
  throwsStatus(() => castVote(s, T0, { voterId, categoryId: a.id, dishId: randomUUID() }), 404);
  throwsStatus(() => castVote(s, T0, { voterId: 'abc', categoryId: a.id, dishId: dA.id }), 400);
});

test('1,000 voters are accepted, the 1,001st new voter is a 409, existing voters can still change', () => {
  const { state, a, dA } = base();
  const dA2 = dish(a.id);
  state.dishes.push(dA2);
  let s = openVoting(state, T0, DEADLINE);
  const first = randomUUID();
  s = castVote(s, T0, { voterId: first, categoryId: a.id, dishId: dA.id }).state;
  for (let i = 1; i < LIMITS.maxVoters; i += 1) {
    s.ballots[randomUUID()] = { [a.id]: dA.id };
  }
  assert.equal(Object.keys(s.ballots).length, 1000);
  throwsStatus(() => castVote(s, T0, { voterId: randomUUID(), categoryId: a.id, dishId: dA.id }), 409);
  const changed = castVote(s, T0, { voterId: first, categoryId: a.id, dishId: dA2.id });
  assert.deepEqual(changed.ballot, { [a.id]: dA2.id });
});

test('a sixth category is a 400 and a category that still has dishes cannot be deleted (409)', () => {
  let state = emptyContest(T0);
  for (let i = 0; i < 5; i += 1) state = addCategory(state, `Cat ${i}`).state;
  throwsStatus(() => addCategory(state, 'Sixth'), 400);
  const withDish = base();
  throwsStatus(() => deleteCategory(withDish.state, withDish.a.id), 409);
  const emptied = emptyContest(T0);
  const added = addCategory(emptied, 'Soups');
  assert.deepEqual(deleteCategory(added.state, added.category.id).categories, []);
});

test('openVoting needs a future deadline and at least one approved dish', () => {
  const { state } = base();
  throwsStatus(() => openVoting(state, T0, new Date(T0.getTime() - 1000)), 400);
  throwsStatus(() => openVoting(state, T0, T0), 400);
  const onlyPending = emptyContest(T0);
  const c = addCategory(onlyPending, 'Mains');
  c.state.dishes.push(dish(c.category.id, 'pending'));
  throwsStatus(() => openVoting(c.state, T0, DEADLINE), 409);
});

test('extendDeadline works only while effectively open; closeVoting stops voting and pulls the deadline in', () => {
  const { state, a, dA } = base();
  const open = openVoting(state, T0, DEADLINE);
  const later = new Date(DEADLINE.getTime() + 3600_000);
  assert.equal(extendDeadline(open, T0, later).deadline, later.toISOString());
  throwsStatus(() => extendDeadline(open, new Date(DEADLINE.getTime() + 1), later), 409);
  const closed = closeVoting(open, new Date(T0.getTime() + 60_000));
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.deadline, new Date(T0.getTime() + 60_000).toISOString());
  assert.equal(closed.closedAt, new Date(T0.getTime() + 60_000).toISOString());
  throwsStatus(() => castVote(closed, T0, { voterId: randomUUID(), categoryId: a.id, dishId: dA.id }), 409);
});

test('a closed contest with nothing revealed can be reopened', () => {
  const { state } = base();
  const closed = closeVoting(openVoting(state, T0, DEADLINE), T0);
  const reopened = openVoting(closed, T0, DEADLINE);
  assert.equal(reopened.phase, 'open');
  assert.equal(reopened.closedAt, null);
});

test('a contest whose deadline lapsed on its own can be reopened with a new deadline', () => {
  const { state } = base();
  const open = openVoting(state, T0, DEADLINE);
  const later = new Date(DEADLINE.getTime() + 60_000);
  assert.equal(effectivePhase(open, later), 'closed');
  const reopened = openVoting(open, later, new Date(later.getTime() + 5 * 60_000));
  assert.equal(reopened.phase, 'open');
  assert.equal(effectivePhase(reopened, later), 'open');
  // but a contest still running cannot be "reopened"; that is what extend is for
  throwsStatus(() => openVoting(open, T0, DEADLINE), 409);
});

test('functions never mutate the state they are given', () => {
  const { state, a, dA } = base();
  const open = openVoting(state, T0, DEADLINE);
  const frozen = JSON.stringify(open);
  castVote(open, T0, { voterId: randomUUID(), categoryId: a.id, dishId: dA.id });
  setTitle(open, 'Chili Cook-off');
  assert.equal(JSON.stringify(open), frozen);
});

test('ballotFor drops picks whose dish is missing or no longer approved', () => {
  const { state, a, b, dA, dB } = base();
  let s = openVoting(state, T0, DEADLINE);
  const voterId = randomUUID();
  s = castVote(s, T0, { voterId, categoryId: a.id, dishId: dA.id }).state;
  s = castVote(s, T0, { voterId, categoryId: b.id, dishId: dB.id }).state;
  s.dishes = s.dishes.filter((d) => d.id !== dA.id);
  assert.deepEqual(ballotFor(s, voterId), { [b.id]: dB.id });
  s.dishes.find((d) => d.id === dB.id).status = 'pending';
  assert.deepEqual(ballotFor(s, voterId), {});
  assert.deepEqual(ballotFor(s, randomUUID()), {});
});

test('isUuidV4 accepts v4 UUIDs only', () => {
  assert.equal(isUuidV4(randomUUID()), true);
  assert.equal(isUuidV4('abc'), false);
  assert.equal(isUuidV4('00000000-0000-1000-8000-000000000000'), false);
  assert.equal(isUuidV4(null), false);
});
