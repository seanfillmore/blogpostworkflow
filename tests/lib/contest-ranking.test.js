// tests/lib/contest-ranking.test.js
// Ranking, reveal order and the public projection. The leak tests matter most:
// a phone or the TV must never learn a vote count before that place is revealed.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ContestError, emptyContest, addCategory, deleteCategory, openVoting, closeVoting, castVote, tally, revealSteps,
  startReveal, revealNext, revealBack, publicView, adminView,
} from '../../lib/contest.js';

const T0 = new Date('2026-11-01T12:00:00Z');
const DEADLINE = new Date('2026-11-01T14:00:00Z');
const AFTER = new Date('2026-11-01T14:00:01Z');

function dish(categoryId, name, status = 'approved') {
  return {
    id: randomUUID(), categoryId, name, cook: 'Cook ' + name, ingredients: 'stuff',
    allergens: ['none'], recipe: '', status, source: 'admin', editedSinceApproval: false,
    photoVersion: 0, editTokenHash: 'SECRETHASH',
  };
}

/** Two categories; Mains has A,B,C,D (+ a pending P), Desserts has E only. */
function fixture() {
  let state = emptyContest(T0);
  const mains = addCategory(state, 'Mains'); state = mains.state;
  const desserts = addCategory(state, 'Desserts'); state = desserts.state;
  const [A, B, C, D, E] = ['A', 'B', 'C', 'D'].map((n) => dish(mains.category.id, n))
    .concat([dish(desserts.category.id, 'E')]);
  const P = dish(mains.category.id, 'P', 'pending');
  state.dishes.push(A, B, C, D, P, E);
  return { state, mains: mains.category, desserts: desserts.category, A, B, C, D, E, P };
}

/** Cast `n` fresh voters' votes for a dish. */
function votes(state, dishObj, n) {
  let s = openIfNeeded(state);
  for (let i = 0; i < n; i += 1) {
    s = castVote(s, T0, { voterId: randomUUID(), categoryId: dishObj.categoryId, dishId: dishObj.id }).state;
  }
  return s;
}
function openIfNeeded(state) {
  return state.phase === 'open' ? state : openVoting(state, T0, DEADLINE);
}

function scored() {
  const f = fixture();
  let s = f.state;
  s = votes(s, f.A, 5); s = votes(s, f.B, 5); s = votes(s, f.C, 3); s = votes(s, f.E, 2);
  return { ...f, state: s };
}

test('tally uses competition ranking: ties share a place, zero votes never place', () => {
  const { state, mains, A, B, C, D } = scored();
  const rows = tally(state)[mains.id];
  const place = (d) => rows.find((r) => r.dishId === d.id).place;
  assert.equal(place(A), 1);
  assert.equal(place(B), 1);
  assert.equal(place(C), 3);
  assert.equal(place(D), null);
  assert.equal(rows.length, 4, 'the pending dish is not ranked');
});

test('revealSteps skips places nobody holds', () => {
  const { state, mains, A, B, C } = scored();
  assert.deepEqual(revealSteps(state, mains.id), [
    { step: 1, place: 3, dishIds: [C.id] },
    { step: 3, place: 1, dishIds: [A.id, B.id] },
  ]);
});

test('a category with one voted dish reveals only its first-place step', () => {
  const { state, desserts, E } = scored();
  assert.deepEqual(revealSteps(state, desserts.id), [{ step: 3, place: 1, dishIds: [E.id] }]);
});

test('publicView carries no vote data before reveal, in setup, open and closed', () => {
  const f = fixture();
  const forbidden = ['"votes"', '"tally"', '"place"', '"editTokenHash"', '"ballots"', 'SECRETHASH'];
  const check = (view) => {
    const json = JSON.stringify(view);
    for (const word of forbidden) assert.ok(!json.includes(word), `${word} leaked`);
  };
  check(publicView(f.state, T0));
  const scoredState = scored();
  check(publicView(scoredState.state, T0));
  check(publicView(scoredState.state, AFTER));
  check(publicView(closeVoting(scoredState.state, T0), T0));
});

test('publicView lists only approved dishes, in admin order, even if the last dish leads', () => {
  const { state, A, B, C, D, E, P } = scored();
  const view = publicView(state, T0);
  assert.deepEqual(view.dishes.map((d) => d.id), [A.id, B.id, C.id, D.id, E.id]);
  assert.ok(!JSON.stringify(view).includes(P.id));
  const flipped = votes(state, E, 10); // last dish now leads
  assert.deepEqual(publicView(flipped, T0).dishes.map((d) => d.id), [A.id, B.id, C.id, D.id, E.id]);
});

test('publicView exposes the effective phase, server time, and counts', () => {
  const { state } = scored();
  assert.equal(publicView(state, T0).phase, 'open');
  const view = publicView(state, AFTER);
  assert.equal(view.phase, 'closed');
  assert.equal(view.serverNow, AFTER.toISOString());
  assert.equal(view.voterCount, 15);
  assert.equal(view.voteCount, 15);
  assert.equal(view.voteEvents, 15);
  assert.equal(view.reveal, null);
  assert.deepEqual(Object.keys(view).sort(), [
    'categories', 'deadline', 'dishes', 'phase', 'reveal', 'serverNow', 'submissionsOpen',
    'title', 'voteCount', 'voteEvents', 'voterCount',
  ]);
});

test('photoUrl is versioned, and null until a photo exists', () => {
  const { state, A } = scored();
  state.dishes.find((d) => d.id === A.id).photoVersion = 3;
  const view = publicView(state, T0);
  assert.equal(view.dishes.find((d) => d.id === A.id).photoUrl, `/contest/photos/${A.id}-3.webp`);
  assert.equal(view.dishes.find((d) => d.name === 'B').photoUrl, null);
});

test('startReveal needs a closed contest and persists the close when only the deadline passed', () => {
  const { state } = scored();
  assert.throws(() => startReveal(state, T0), (e) => e instanceof ContestError && e.status === 409);
  const s = startReveal(state, AFTER);
  assert.equal(s.phase, 'revealing');
  assert.deepEqual(s.reveal, { categoryIndex: 0, step: 0 });
});

test('after startReveal and one revealNext only third place is shown, never first-place votes', () => {
  const { state, mains, C } = scored();
  let s = startReveal(closeVoting(state, T0), T0);
  assert.deepEqual(publicView(s, T0).reveal, { categoryIndex: 0, categoryId: mains.id, revealed: [] });
  s = revealNext(s);
  const view = publicView(s, T0);
  assert.deepEqual(view.reveal.revealed, [{ categoryId: mains.id, place: 3, dishIds: [C.id], votes: 3 }]);
  assert.ok(!JSON.stringify(view).includes('"votes":5'), 'first-place votes must stay hidden');
});

test('revealNext walks categories then finishes; revealBack undoes it', () => {
  const { state, mains, desserts, A, B, C, E } = scored();
  let s = startReveal(closeVoting(state, T0), T0);
  s = revealNext(s);                       // mains 3rd
  s = revealNext(s);                       // mains 1st (no 2nd)
  assert.equal(s.reveal.step, 3);
  s = revealNext(s);                       // desserts, nothing shown yet
  assert.deepEqual(s.reveal, { categoryIndex: 1, step: 0 });
  s = revealNext(s);                       // desserts 1st
  assert.equal(s.phase, 'revealing');
  s = revealNext(s);                       // past the end
  assert.equal(s.phase, 'done');

  const done = publicView(s, T0);
  assert.deepEqual(done.reveal.revealed.map((r) => [r.categoryId, r.place]), [
    [mains.id, 3], [mains.id, 1], [desserts.id, 1],
  ]);
  assert.deepEqual(done.reveal.revealed[1].dishIds, [A.id, B.id]);
  assert.deepEqual(done.reveal.revealed[0].dishIds, [C.id]);
  assert.deepEqual(done.reveal.revealed[2].dishIds, [E.id]);

  let back = revealBack(s);
  assert.equal(back.phase, 'revealing');
  assert.deepEqual(back.reveal, { categoryIndex: 1, step: 3 });
  back = revealBack(back);
  assert.deepEqual(back.reveal, { categoryIndex: 1, step: 0 });
  back = revealBack(back);
  assert.deepEqual(back.reveal, { categoryIndex: 0, step: 3 });
  back = revealBack(back);
  assert.deepEqual(back.reveal, { categoryIndex: 0, step: 1 });
  back = revealBack(back);
  assert.deepEqual(back.reveal, { categoryIndex: 0, step: 0 });
  assert.deepEqual(revealBack(back).reveal, { categoryIndex: 0, step: 0 }, 'never below the start');
});

test('revealNext outside the reveal is a 409', () => {
  const { state } = scored();
  assert.throws(() => revealNext(state), (e) => e instanceof ContestError && e.status === 409);
});

test('adminView hides token hashes but includes the tally', () => {
  const { state, mains } = scored();
  const view = adminView(state, T0);
  assert.ok(!JSON.stringify(view).includes('SECRETHASH'));
  assert.ok(Array.isArray(view.tally[mains.id]));
  assert.ok(view.dishes.some((d) => d.status === 'pending'));
});

test('deleting the empty current category mid-reveal is a 409, not a later TypeError', () => {
  const { state, desserts } = scored();
  let s = startReveal(closeVoting(state, T0), T0);
  s = revealNext(s); s = revealNext(s); s = revealNext(s); // now at category 1
  assert.equal(s.reveal.categoryIndex, 1);
  const emptied = { ...s, dishes: s.dishes.filter((d) => d.categoryId !== desserts.id) };
  assert.throws(() => deleteCategory(emptied, desserts.id), (e) => e instanceof ContestError && e.status === 409);
});

test('reveal functions throw ContestError, not TypeError, when the category is missing or absent', () => {
  const none = { ...emptyContest(T0), phase: 'closed' };
  assert.throws(() => startReveal(none, T0), (e) => e instanceof ContestError && e.status === 409);
  const { state } = scored();
  const broken = { ...startReveal(closeVoting(state, T0), T0), categories: [] };
  assert.throws(() => revealNext(broken), (e) => e instanceof ContestError && e.status === 409);
  assert.throws(() => revealBack(broken), (e) => e instanceof ContestError && e.status === 409);
});
