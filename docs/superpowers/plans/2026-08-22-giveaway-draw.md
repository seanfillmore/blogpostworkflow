# Giveaway Drawing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a provable, reproducible winner and referral-prize determination for the September 16, 2026 soap giveaway drawing.

**Architecture:** Three separated phases. A snapshot freezes the entrant pool to a committed JSON file at entry close. A hand-run, seeded draw expands every entry into a ticket, shuffles the tickets with a deterministic PRNG, and takes each address's first appearance to produce the winner and every alternate in one ordering. A notification step drafts the winner email for a human to send. Every failure path refuses rather than guesses.

**Tech Stack:** Node 22 LTS (ESM), `node:test`, `node:crypto` (SHA-256), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-giveaway-draw-design.md`

## Global Constraints

- **Node 22 LTS.** Run `nvm use` before testing. When reading `node --test` output, check the **cancelled** count, not just fail — a cancelled test prints alongside `# fail 0` and reads like a pass.
- **Branch + PR for everything.** Never commit to `main`. Work in a worktree (`scripts/new-worktree.sh`). Re-check `git branch --show-current` before every commit.
- **No new npm dependencies.** The PRNG and hashing are in-repo; `node:crypto` supplies SHA-256.
- **Entry values come from `lib/giveaway/entries.js`.** Never hardcode `1`, `2`, `3`, `5`, `10` — import `ENTRY_VALUES` / `entryTotal`. That file is the single source of truth for what an action is worth.
- **Money and prize wording:** ARV is `$536.40` per winner, `$1,072.80` total. Never restate a prize value from memory; it lives in `data/giveaway/official-rules.html` §7.
- **Dates are Pacific.** `config/giveaway.json` `entryClosesAt` is `2026-09-14T23:59:59-07:00`; `drawAt` is `2026-09-16T12:00:00-07:00`. Sep 14 is a Monday, Sep 15 a Tuesday, Sep 16 a Wednesday. Never assert a weekday without checking it.
- **Nothing in this plan sends email.** Phase 3 writes a draft to disk. Auto-sending a $536.40 prize notification is out of scope and forbidden.
- **`data/giveaway/` is a tracked path.** Files written there are committed, not gitignored.

---

### Task 1: Seeded PRNG

Deterministic randomness is the foundation everything else rests on. `Math.random()` cannot be reproduced, which would defeat the entire published-seed design.

**Files:**
- Create: `lib/giveaway/seeded-random.js`
- Test: `tests/lib/giveaway-seeded-random.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `seedFromString(seed: string) => number` — a 32-bit unsigned integer derived from SHA-256 of the input.
  - `mulberry32(seed: number) => () => number` — returns a generator producing floats in `[0, 1)`.
  - `shuffle(items: Array<T>, rand: () => number) => Array<T>` — Fisher-Yates, returns a NEW array, does not mutate input.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib/giveaway-seeded-random.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { seedFromString, mulberry32, shuffle } from '../../lib/giveaway/seeded-random.js';

test('the same seed string always produces the same numeric seed', () => {
  assert.equal(seedFromString('43214.87'), seedFromString('43214.87'));
  assert.notEqual(seedFromString('43214.87'), seedFromString('43214.88'));
});

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const first = Array.from({ length: 20 }, () => a());
  const second = Array.from({ length: 20 }, () => b());
  assert.deepEqual(first, second, 'same seed must replay exactly');
  for (const n of first) {
    assert.ok(n >= 0 && n < 1, `${n} out of range`);
  }
});

test('two different seeds diverge', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test('shuffle is deterministic for a given generator and does not mutate input', () => {
  const input = ['a', 'b', 'c', 'd', 'e', 'f'];
  const frozen = [...input];
  const one = shuffle(input, mulberry32(99));
  const two = shuffle(input, mulberry32(99));
  assert.deepEqual(one, two, 'same seed must produce the same order');
  assert.deepEqual(input, frozen, 'the input array must not be mutated');
  assert.equal(one.length, input.length);
  assert.deepEqual([...one].sort(), [...frozen].sort(), 'shuffle must be a permutation');
});

test('shuffle actually moves things', () => {
  // A "shuffle" that returned its input unchanged would pass every test above.
  const input = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffle(input, mulberry32(7));
  assert.notDeepEqual(out, input, 'a 50-element shuffle returning identity is a bug, not luck');
});

test('shuffle is unbiased enough that every position is reachable', () => {
  // Fisher-Yates implemented with the wrong loop bound leaves element 0 fixed.
  const seen = new Set();
  for (let s = 0; s < 200; s += 1) {
    seen.add(shuffle(['a', 'b', 'c'], mulberry32(s))[0]);
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c'], 'every element must be able to land first');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/lib/giveaway-seeded-random.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/seeded-random.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/giveaway/seeded-random.js
/**
 * Deterministic randomness for the drawing.
 *
 * Math.random() cannot be reproduced, which would defeat the whole
 * published-seed design: the point is that anyone can re-run the draw against
 * the committed snapshot and get the same winner. Node ships no seeded RNG, so
 * this is a small, well-known one implemented in-repo.
 *
 * mulberry32 is chosen for being short enough to audit by eye. It is not
 * cryptographically secure and does not need to be — the seed is public by
 * design, and the property that matters is reproducibility, not unpredictability
 * after the fact.
 */
import { createHash } from 'node:crypto';

/** A 32-bit unsigned seed derived from an arbitrary seed string (e.g. "43214.87"). */
export function seedFromString(seed) {
  const digest = createHash('sha256').update(String(seed), 'utf8').digest();
  return digest.readUInt32BE(0);
}

/** mulberry32: returns a generator of floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates, on a COPY.
 *
 * Descending loop with `j = floor(rand() * (i + 1))` — the ascending variant
 * with the wrong bound leaves element 0 fixed, which is a bias no casual test
 * catches and which would be indefensible in a prize draw.
 */
export function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/lib/giveaway-seeded-random.test.js`
Expected: PASS, `# fail 0`, `# cancelled 0`

- [ ] **Step 5: Commit**

```bash
git add lib/giveaway/seeded-random.js tests/lib/giveaway-seeded-random.test.js
git commit -m "feat(giveaway): seeded PRNG so the drawing is reproducible"
```

---

### Task 2: Snapshot builder (pure)

The pool-freezing logic, with no Klaviyo and no filesystem, so the Entry-Period gate is provable.

**Files:**
- Create: `lib/giveaway/draw-snapshot.js`
- Test: `tests/lib/giveaway-draw-snapshot.test.js`

**Interfaces:**
- Consumes: `mergeEntrantProfiles` from `lib/giveaway/referral-audit.js`; `entryTotal` from `lib/giveaway/entries.js`; `looksSamePerson` from `lib/giveaway/email-similarity.js`; `isTestProfile` from `lib/giveaway/test-identity.js`.
- Produces: `buildSnapshot(profiles, { entryClosesAt, includeUnconfirmed, takenAt }) => { takenAt, entryClosesAt, determinations, totals, entrants, excluded }` where each entrant is `{ email, entries, confirmed, referredBy, samePersonSuspected }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib/giveaway-draw-snapshot.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSnapshot } from '../../lib/giveaway/draw-snapshot.js';

const CLOSES = '2026-09-14T23:59:59-07:00';
const TAKEN = '2026-09-15T12:05:00.000Z';
const opts = { entryClosesAt: CLOSES, includeUnconfirmed: true, takenAt: TAKEN };

const profile = (email, props = {}, { subscribed = true } = {}) => ({
  id: `id-${email}`,
  email,
  subscribed,
  properties: {
    gv_entrant: true,
    gv_entered_at: '2026-08-20T12:00:00.000Z',
    gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    ...props,
  },
});
const confirmedAt = (iso) => ({ gv_confirmed_at: iso });
const row = (snap, email) => snap.entrants.find((e) => e.email === email);

test('a confirmed entrant carries their full entry count', () => {
  const snap = buildSnapshot([
    profile('a@x.com', {
      ...confirmedAt('2026-09-01T10:00:00.000Z'),
      gv_breakdown: { confirmed: true, survey: true, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  assert.equal(row(snap, 'a@x.com').entries, 1 + 2 + 3, 'base + confirm + survey');
  assert.equal(row(snap, 'a@x.com').confirmed, true);
});

test('REGRESSION: a confirmation made AFTER entries closed does not count', () => {
  // reconcile.js has no concept of the Entry Period and would credit this. §5
  // requires every entry action to be completed "during the Entry Period".
  const snap = buildSnapshot([
    profile('late@x.com', {
      ...confirmedAt('2026-09-15T08:00:00.000Z'), // after the close
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  const r = row(snap, 'late@x.com');
  assert.equal(r.confirmed, false, 'confirmed after the close is not confirmed for the draw');
  assert.equal(r.entries, 1, 'they keep their base entry and nothing more');
});

test('a confirmation exactly AT the closing instant counts', () => {
  const snap = buildSnapshot([
    profile('edge@x.com', {
      ...confirmedAt('2026-09-14T23:59:59-07:00'),
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  assert.equal(row(snap, 'edge@x.com').confirmed, true, 'the boundary is inclusive');
});

test('unconfirmed entrants are included at their base entry when the determination says so', () => {
  const snap = buildSnapshot([
    profile('pending@x.com', {}, { subscribed: false }),
  ], opts);
  assert.equal(row(snap, 'pending@x.com').entries, 1);
  assert.equal(row(snap, 'pending@x.com').confirmed, false);
});

test('unconfirmed entrants are excluded when the determination is flipped', () => {
  const snap = buildSnapshot(
    [profile('pending@x.com', {}, { subscribed: false })],
    { ...opts, includeUnconfirmed: false },
  );
  assert.equal(row(snap, 'pending@x.com'), undefined);
});

test('a referral is carried through with its same-person flag', () => {
  const snap = buildSnapshot([
    profile('lisamarob@gmail.com', {
      ...confirmedAt('2026-09-01T10:00:00.000Z'),
      gv_referred_by: 'lisamarobin@outlook.com',
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  const r = row(snap, 'lisamarob@gmail.com');
  assert.equal(r.referredBy, 'lisamarobin@outlook.com');
  assert.equal(r.samePersonSuspected, true);
});

test('test identities are excluded and counted', () => {
  const snap = buildSnapshot([
    profile('real@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
    profile('tester@x.com', { gv_test: true }),
  ], opts);
  assert.equal(row(snap, 'tester@x.com'), undefined);
  assert.equal(snap.excluded.testProfiles, 1);
});

test('totals agree with the rows, and entrants are sorted by email', () => {
  const snap = buildSnapshot([
    profile('c@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
    profile('a@x.com', {}, { subscribed: false }),
    profile('b@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
  ], opts);
  assert.deepEqual(snap.entrants.map((e) => e.email), ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.equal(snap.totals.entrants, 3);
  assert.equal(snap.totals.entries, snap.entrants.reduce((n, e) => n + e.entries, 0));
  assert.equal(snap.totals.confirmed, 2);
  assert.equal(snap.totals.unconfirmed, 1);
});

test('the snapshot records the determination it was built under', () => {
  const snap = buildSnapshot([profile('a@x.com')], opts);
  assert.equal(snap.determinations.drawIncludesUnconfirmedEntrants, true);
  assert.equal(snap.entryClosesAt, CLOSES);
  assert.equal(snap.takenAt, TAKEN);
});

test('two builds of the same input are byte-identical', () => {
  const input = [
    profile('b@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
    profile('a@x.com', {}, { subscribed: false }),
  ];
  assert.equal(
    JSON.stringify(buildSnapshot(input, opts)),
    JSON.stringify(buildSnapshot(input, opts)),
    'the snapshot is the evidence record; it must not vary run to run',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/lib/giveaway-draw-snapshot.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/draw-snapshot.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/giveaway/draw-snapshot.js
/**
 * Freeze the entrant pool for the drawing.
 *
 * Pure: no Klaviyo, no clock, no filesystem. This function decides who is in the
 * draw and with how many entries, for a promotion with $1,072.80 of prizes and
 * entrants who can complain, so every rule in it is provable in tests.
 *
 * THE ENTRY-PERIOD GATE. reconcile.js credits a confirmation whenever it
 * happens; it has no concept of the Entry Period, and it runs at 01:30 PT on
 * Sep 15 — AFTER entries close at 23:59:59 PT on Sep 14. Left alone it would
 * credit post-close confirmations. §5 requires every entry action to be
 * completed "during the Entry Period", so entries are RECOMPUTED here from a
 * time-filtered breakdown rather than read from the stored gv_entries.
 *
 * Only the confirmation rung carries a timestamp we can check. Survey,
 * Instagram and upload have no per-rung stamp, so they are taken as stored —
 * documented rather than silently assumed, and noted in the lessons doc as
 * something the next promotion should stamp.
 */
import { entryTotal } from './entries.js';
import { looksSamePerson } from './email-similarity.js';
import { isTestProfile } from './test-identity.js';

const norm = (e) => String(e ?? '').trim().toLowerCase();

export function buildSnapshot(profiles = [], { entryClosesAt, includeUnconfirmed, takenAt }) {
  if (!entryClosesAt) throw new Error('buildSnapshot: entryClosesAt is required');
  if (!takenAt) throw new Error('buildSnapshot: takenAt is required');
  const closesMs = Date.parse(entryClosesAt);
  if (!Number.isFinite(closesMs)) throw new Error(`buildSnapshot: unparseable entryClosesAt: ${entryClosesAt}`);

  const excluded = { testProfiles: 0, unconfirmed: 0, unusable: 0 };
  const entrants = [];

  for (const p of profiles) {
    const email = norm(p.email);
    if (!email) { excluded.unusable += 1; continue; }
    if (isTestProfile(p.properties || {})) { excluded.testProfiles += 1; continue; }

    const props = p.properties || {};
    const stored = props.gv_breakdown || {};

    // Inclusive boundary: a click at the closing instant is inside the period.
    const stamp = Date.parse(props.gv_confirmed_at ?? '');
    const confirmed = Number.isFinite(stamp) && stamp <= closesMs;

    if (!confirmed && !includeUnconfirmed) { excluded.unconfirmed += 1; continue; }

    const breakdown = {
      confirmed,
      survey: stored.survey === true,
      instagram: stored.instagram === true,
      upload: stored.upload === true,
      referrals: confirmed ? Number(stored.referrals ?? 0) : 0,
    };

    entrants.push({
      email,
      entries: entryTotal(breakdown),
      confirmed,
      referredBy: props.gv_referred_by ? norm(props.gv_referred_by) : null,
      samePersonSuspected: props.gv_referred_by
        ? looksSamePerson(norm(props.gv_referred_by), email)
        : false,
    });
  }

  entrants.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));

  return {
    takenAt,
    entryClosesAt,
    determinations: { drawIncludesUnconfirmedEntrants: Boolean(includeUnconfirmed) },
    totals: {
      entrants: entrants.length,
      entries: entrants.reduce((n, e) => n + e.entries, 0),
      confirmed: entrants.filter((e) => e.confirmed).length,
      unconfirmed: entrants.filter((e) => !e.confirmed).length,
    },
    entrants,
    excluded,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/lib/giveaway-draw-snapshot.test.js`
Expected: PASS, `# fail 0`, `# cancelled 0`

- [ ] **Step 5: Commit**

```bash
git add lib/giveaway/draw-snapshot.js tests/lib/giveaway-draw-snapshot.test.js
git commit -m "feat(giveaway): snapshot builder with the Entry-Period gate"
```

---

### Task 3: Draw ordering and §6 prize determination (pure)

**Files:**
- Create: `lib/giveaway/draw.js`
- Test: `tests/lib/giveaway-draw.test.js`

**Interfaces:**
- Consumes: `seedFromString`, `mulberry32`, `shuffle` from `lib/giveaway/seeded-random.js`.
- Produces:
  - `drawOrdering(snapshot, seed: string) => Array<string>` — every entrant email, most-favoured first, no duplicates.
  - `determineReferralPrize(snapshot, winnerEmail) => { awarded: boolean, email: string|null, reason: string }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib/giveaway-draw.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { drawOrdering, determineReferralPrize } from '../../lib/giveaway/draw.js';

const snap = (entrants) => ({
  takenAt: '2026-09-15T12:05:00.000Z',
  entryClosesAt: '2026-09-14T23:59:59-07:00',
  determinations: { drawIncludesUnconfirmedEntrants: true },
  totals: {
    entrants: entrants.length,
    entries: entrants.reduce((n, e) => n + e.entries, 0),
    confirmed: entrants.filter((e) => e.confirmed).length,
    unconfirmed: entrants.filter((e) => !e.confirmed).length,
  },
  entrants,
  excluded: { testProfiles: 0, unconfirmed: 0, unusable: 0 },
});
const e = (email, entries, extra = {}) => ({
  email, entries, confirmed: true, referredBy: null, samePersonSuspected: false, ...extra,
});

test('the same seed reproduces the same ordering exactly', () => {
  const s = snap([e('a@x.com', 3), e('b@x.com', 1), e('c@x.com', 8)]);
  assert.deepEqual(drawOrdering(s, '43214.87'), drawOrdering(s, '43214.87'));
});

test('a different seed generally produces a different winner', () => {
  // Guards a seed that is accepted and silently ignored — the failure mode that
  // looks exactly like success.
  const s = snap(Array.from({ length: 40 }, (_, i) => e(`p${i}@x.com`, 1 + (i % 5))));
  const winners = new Set(
    ['1', '2', '3', '4', '5', '6', '7', '8'].map((seed) => drawOrdering(s, seed)[0]),
  );
  assert.ok(winners.size > 1, 'eight seeds producing one winner means the seed is not being used');
});

test('the ordering contains every entrant exactly once', () => {
  const s = snap([e('a@x.com', 5), e('b@x.com', 1), e('c@x.com', 2)]);
  const order = drawOrdering(s, 'seed');
  assert.equal(order.length, 3);
  assert.deepEqual([...order].sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('more entries wins proportionally more often', () => {
  // The whole point of a weighted draw. 10:1 should land near 10x across many
  // seeds; the bound is loose because this is a sample, not a proof.
  const s = snap([e('big@x.com', 10), e('small@x.com', 1)]);
  let big = 0;
  const runs = 600;
  for (let i = 0; i < runs; i += 1) if (drawOrdering(s, `seed-${i}`)[0] === 'big@x.com') big += 1;
  const share = big / runs;
  assert.ok(share > 0.8 && share < 0.97, `10:1 weighting should win ~91% of the time, got ${(share * 100).toFixed(1)}%`);
});

test('an entrant with more entries is never dropped from the ordering', () => {
  const s = snap([e('a@x.com', 100), e('b@x.com', 1)]);
  assert.equal(drawOrdering(s, 'x').length, 2, 'the low-weight entrant is still an alternate');
});

test('the referral prize is awarded when every §6 condition holds', () => {
  const s = snap([
    e('winner@x.com', 3, { referredBy: 'friend@x.com' }),
    e('friend@x.com', 3),
  ]);
  const r = determineReferralPrize(s, 'winner@x.com');
  assert.equal(r.awarded, true);
  assert.equal(r.email, 'friend@x.com');
});

test('§6: no referrer named means no second prize', () => {
  const r = determineReferralPrize(snap([e('winner@x.com', 3)]), 'winner@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /named no referrer/i);
});

test('§6: a referrer who never entered wins nothing', () => {
  const s = snap([e('winner@x.com', 3, { referredBy: 'ghost@x.com' })]);
  const r = determineReferralPrize(s, 'winner@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /not in the snapshot/i);
});

test('§6(a): an UNCONFIRMED referrer wins nothing', () => {
  // "but only if the named referrer is (a) themselves a confirmed entrant".
  // Note this is the one place confirmation still gates a referral outcome —
  // the +5 ENTRY credit deliberately does not require it (§5).
  const s = snap([
    e('winner@x.com', 3, { referredBy: 'pending@x.com' }),
    e('pending@x.com', 1, { confirmed: false }),
  ]);
  const r = determineReferralPrize(s, 'winner@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /not a confirmed entrant/i);
});

test('§6(b): a same-person referrer wins nothing, and no substitute is named', () => {
  const s = snap([
    e('lisamarob@gmail.com', 3, { referredBy: 'lisamarobin@outlook.com', samePersonSuspected: true }),
    e('lisamarobin@outlook.com', 3),
  ]);
  const r = determineReferralPrize(s, 'lisamarob@gmail.com');
  assert.equal(r.awarded, false);
  assert.equal(r.email, null, '§6 gives Sponsor no obligation to substitute');
  assert.match(r.reason, /same person/i);
});

test('§6: naming your own address wins nothing', () => {
  const s = snap([e('solo@x.com', 3, { referredBy: 'solo@x.com' })]);
  const r = determineReferralPrize(s, 'solo@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /own address/i);
});

test('an unknown winner email is refused rather than silently unawarded', () => {
  assert.throws(
    () => determineReferralPrize(snap([e('a@x.com', 1)]), 'nobody@x.com'),
    /not in the snapshot/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/lib/giveaway-draw.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/draw.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/giveaway/draw.js
/**
 * The drawing itself: a weighted ordering, and the §6 second-prize test.
 *
 * WHY TICKETS AND NOT A WEIGHTED-KEY ALGORITHM. Efraimidis-Spirakis would be
 * fewer lines and is equally correct, but nobody outside this repo could check
 * it by hand — and being checkable by hand is the entire point of publishing a
 * seed. Expanding each entry into its own ticket and shuffling is exactly the
 * mental model an entrant already has: every ticket goes in a drum and they come
 * out one at a time.
 *
 * ONE PASS GIVES THE WINNER AND EVERY ALTERNATE. §8 gives a winner 7 days to
 * respond before Sponsor "may select an alternate winner from the remaining
 * eligible entries". Taking first-appearance order over the shuffled tickets
 * yields that whole list at once, so the alternate is as provable as the winner
 * and needs no second draw.
 */
import { seedFromString, mulberry32, shuffle } from './seeded-random.js';

/**
 * Every entrant, most-favoured first.
 * @returns {Array<string>} emails, no duplicates, length === snapshot.entrants.length
 */
export function drawOrdering(snapshot, seed) {
  if (!seed) throw new Error('drawOrdering: a seed is required');
  const tickets = [];
  for (const entrant of snapshot.entrants) {
    for (let i = 0; i < entrant.entries; i += 1) tickets.push(entrant.email);
  }
  if (!tickets.length) throw new Error('drawOrdering: the snapshot holds no entries');

  const shuffled = shuffle(tickets, mulberry32(seedFromString(seed)));

  const seen = new Set();
  const ordering = [];
  for (const email of shuffled) {
    if (seen.has(email)) continue;
    seen.add(email);
    ordering.push(email);
  }
  return ordering;
}

/**
 * §6, four conditions. Any failure means no prize AND no substitute — §6 states
 * outright that Sponsor "has no obligation to substitute a referral prize
 * winner", so `email` is null on every rejection.
 */
export function determineReferralPrize(snapshot, winnerEmail) {
  const byEmail = new Map(snapshot.entrants.map((e) => [e.email, e]));
  const winner = byEmail.get(winnerEmail);
  if (!winner) throw new Error(`determineReferralPrize: ${winnerEmail} is not in the snapshot`);

  const no = (reason) => ({ awarded: false, email: null, reason });

  if (!winner.referredBy) return no('the winner named no referrer at the time of entry');
  if (winner.referredBy === winner.email) return no('the winner named their own address — void under §6');
  if (winner.samePersonSuspected) {
    return no('the named referrer resolves to the same person as the winner — void under §6, no substitute');
  }
  const referrer = byEmail.get(winner.referredBy);
  if (!referrer) return no(`the named referrer ${winner.referredBy} is not in the snapshot — they never entered`);
  if (!referrer.confirmed) {
    return no(`the named referrer ${winner.referredBy} is not a confirmed entrant — §6(a)`);
  }
  return { awarded: true, email: referrer.email, reason: 'all §6 conditions met' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/lib/giveaway-draw.test.js`
Expected: PASS, `# fail 0`, `# cancelled 0`

- [ ] **Step 5: Commit**

```bash
git add lib/giveaway/draw.js tests/lib/giveaway-draw.test.js
git commit -m "feat(giveaway): weighted draw ordering and the §6 prize test"
```

---

### Task 4: Snapshot script, wired into close-entry-period

**Files:**
- Create: `scripts/giveaway/take-draw-snapshot.mjs`
- Modify: `scripts/giveaway/close-entry-period.mjs` (append an invocation after the flow is drafted)
- Test: manual, against live data — this task has no pure logic of its own; Task 2 owns the rules.

**Interfaces:**
- Consumes: `buildSnapshot` (Task 2); `mergeEntrantProfiles` from `lib/giveaway/referral-audit.js`; `listProfilesWithConsent`, `listEntrantProfiles` from `lib/klaviyo-profiles.js`; `notify` from `lib/notify.js`.
- Produces: `data/giveaway/draw-snapshot.json`.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * Freeze the entrant pool for the drawing.
 *
 *   node scripts/giveaway/take-draw-snapshot.mjs            # dry — prints totals
 *   node scripts/giveaway/take-draw-snapshot.mjs --apply    # writes the file
 *
 * Runs on the SERVER from close-entry-period.mjs on Sep 15. It does NOT commit:
 * this repo has no server-side push credentials and adding them for one annual
 * job would be a standing risk for a one-day benefit. The operator commits the
 * file, and draw.mjs refuses to run against an uncommitted or modified snapshot
 * — so forgetting that step produces a refusal, not a quietly unprovable draw.
 *
 * The notify is immediate: the 5 AM digest is the wrong latency for the one
 * artefact the drawing depends on.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* no .env is a valid state */ }

const { listProfilesWithConsent, listEntrantProfiles } = await import('../../lib/klaviyo-profiles.js');
const { mergeEntrantProfiles } = await import('../../lib/giveaway/referral-audit.js');
const { buildSnapshot } = await import('../../lib/giveaway/draw-snapshot.js');
const { notify } = await import('../../lib/notify.js');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');
const OUT = join(ROOT, 'data', 'giveaway', 'draw-snapshot.json');

const [listed, submitted] = await Promise.all([
  listProfilesWithConsent(config.listId),
  listEntrantProfiles(config.entryOpensAt),
]);
const snapshot = buildSnapshot(mergeEntrantProfiles(listed, submitted), {
  entryClosesAt: config.entryClosesAt,
  includeUnconfirmed: config.drawIncludesUnconfirmedEntrants === true,
  takenAt: new Date().toISOString(),
});

console.log(`${snapshot.totals.entrants} entrants | ${snapshot.totals.entries} entries`);
console.log(`  confirmed: ${snapshot.totals.confirmed} | unconfirmed: ${snapshot.totals.unconfirmed}`);
console.log(`  excluded: ${JSON.stringify(snapshot.excluded)}`);

if (!apply) { console.log('\nDry run — pass --apply to write.'); process.exit(0); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`\nWrote ${OUT}`);

await notify({
  subject: `Giveaway draw snapshot taken: ${snapshot.totals.entrants} entrants, ${snapshot.totals.entries} entries`,
  body: [
    `Snapshot written to data/giveaway/draw-snapshot.json at ${snapshot.takenAt}.`,
    `Confirmed ${snapshot.totals.confirmed}, unconfirmed ${snapshot.totals.unconfirmed}.`,
    `Excluded: ${JSON.stringify(snapshot.excluded)}.`,
    '',
    'ACTION REQUIRED before the drawing: pull this file down and COMMIT it.',
    'draw.mjs refuses to run against an uncommitted snapshot.',
    '',
    '  scp root@137.184.119.230:~/seo-claude/data/giveaway/draw-snapshot.json data/giveaway/',
  ].join('\n'),
  status: 'success',
  category: 'giveaway',
  immediate: true,
});
```

- [ ] **Step 2: Dry-run against live data**

Run: `source ~/.nvm/nvm.sh && nvm use && node scripts/giveaway/take-draw-snapshot.mjs`
Expected: prints entrant and entry totals with no file written. Confirm `totals.entries` equals the sum you get from `node scripts/giveaway/report.mjs` for confirmed entrants plus one per unconfirmed entrant.

- [ ] **Step 3: Wire it into close-entry-period.mjs**

Append at the end of `scripts/giveaway/close-entry-period.mjs`:

```js
// The pool must be frozen at the close of the Entry Period (§12), and this job
// is the only thing that runs at that moment. Spawned rather than imported
// because importing an agent/script module RUNS it — see
// ~/.claude/.../reference_agents_run_on_import.md.
if (apply) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'giveaway', 'take-draw-snapshot.mjs'), '--apply'], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('SNAPSHOT FAILED — the drawing has no frozen pool. Run take-draw-snapshot.mjs by hand.');
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Verify the wiring without sending anything**

Run: `source ~/.nvm/nvm.sh && nvm use && node scripts/giveaway/close-entry-period.mjs` (no `--apply`)
Expected: the close job reports what it would do and does NOT invoke the snapshot.

- [ ] **Step 5: Commit**

```bash
git add scripts/giveaway/take-draw-snapshot.mjs scripts/giveaway/close-entry-period.mjs
git commit -m "feat(giveaway): take and notify the draw snapshot at entry close"
```

---

### Task 5: The draw script, with every refusal path

**Files:**
- Create: `scripts/giveaway/draw.mjs`
- Test: `tests/scripts/giveaway-draw-guards.test.js`

**Interfaces:**
- Consumes: `drawOrdering`, `determineReferralPrize` (Task 3).
- Produces: `data/giveaway/draw-result.json`; exports `assertSnapshotCommitted(root, relPath)` for testing.

- [ ] **Step 1: Write the failing test for the guard**

```js
// tests/scripts/giveaway-draw-guards.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSnapshotCommitted } from '../../scripts/giveaway/draw.mjs';

function repoWith(contents, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  mkdirSync(join(dir, 'data', 'giveaway'), { recursive: true });
  writeFileSync(join(dir, 'data', 'giveaway', 'draw-snapshot.json'), contents);
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'snapshot'], { cwd: dir });
  }
  return dir;
}

const REL = 'data/giveaway/draw-snapshot.json';

test('a committed, unmodified snapshot passes the guard', () => {
  const dir = repoWith('{"ok":true}\n');
  assert.doesNotThrow(() => assertSnapshotCommitted(dir, REL));
});

test('an UNCOMMITTED snapshot is refused', () => {
  const dir = repoWith('{"ok":true}\n', { commit: false });
  assert.throws(() => assertSnapshotCommitted(dir, REL), /not committed/i);
});

test('a snapshot MODIFIED after commit is refused', () => {
  const dir = repoWith('{"ok":true}\n');
  writeFileSync(join(dir, REL), '{"ok":false}\n');
  assert.throws(() => assertSnapshotCommitted(dir, REL), /differs from the committed/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/scripts/giveaway-draw-guards.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script**

```js
#!/usr/bin/env node
/**
 * Conduct the drawing.
 *
 *   node scripts/giveaway/draw.mjs --seed 43214.87            # dry run
 *   node scripts/giveaway/draw.mjs --seed 43214.87 --apply    # writes the result
 *
 * Reads ONLY the committed snapshot. It never queries Klaviyo: the pool was
 * frozen at entry close and re-reading live data would silently draw from a
 * different set than the one that was published.
 *
 * Every failure path refuses. This runs once, disposes of $1,072.80 of prizes,
 * and cannot be undone — a wrong result that completes is far worse than a run
 * that stops.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { drawOrdering, determineReferralPrize } from '../../lib/giveaway/draw.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT_REL = 'data/giveaway/draw-snapshot.json';
const RESULT_REL = 'data/giveaway/draw-result.json';

/**
 * The snapshot must be committed AND unmodified.
 *
 * This is what makes the manual commit step safe: an operator who forgets it
 * gets a refusal here rather than an unprovable draw nobody notices.
 */
export function assertSnapshotCommitted(root, relPath) {
  const full = join(root, relPath);
  if (!existsSync(full)) throw new Error(`snapshot missing: ${relPath}`);
  let committed;
  try {
    committed = execFileSync('git', ['rev-parse', `HEAD:${relPath}`], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`${relPath} is not committed — commit the snapshot before drawing`);
  }
  const actual = execFileSync('git', ['hash-object', full], { cwd: root, encoding: 'utf8' }).trim();
  if (actual !== committed) {
    throw new Error(`${relPath} differs from the committed copy — the frozen pool has been edited`);
  }
  return committed;
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const seed = arg('--seed');
const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

if (!seed) {
  console.error('Refusing: --seed is required. Use the published seed value.');
  process.exit(1);
}
if (existsSync(join(ROOT, RESULT_REL)) && !force) {
  console.error(`Refusing: ${RESULT_REL} already exists. A second draw must be deliberate (--force).`);
  process.exit(1);
}

const blob = assertSnapshotCommitted(ROOT, SNAPSHOT_REL);
const snapshot = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_REL), 'utf8'));

const summed = snapshot.entrants.reduce((n, e) => n + e.entries, 0);
if (summed !== snapshot.totals.entries) {
  console.error(`Refusing: snapshot totals disagree with its rows (${snapshot.totals.entries} vs ${summed}).`);
  process.exit(1);
}
if (!snapshot.entrants.length) {
  console.error('Refusing: the snapshot holds no entrants.');
  process.exit(1);
}

const ordering = drawOrdering(snapshot, seed);
const winner = ordering[0];
const prize = determineReferralPrize(snapshot, winner);

console.log(`Snapshot ${blob.slice(0, 12)} — ${snapshot.totals.entrants} entrants, ${snapshot.totals.entries} entries`);
console.log(`Seed: ${seed}\n`);
console.log(`WINNER: ${winner}`);
console.log(`Referral prize: ${prize.awarded ? prize.email : 'NOT AWARDED'} — ${prize.reason}`);
console.log(`\nAlternates, in order: ${ordering.slice(1, 6).join(', ')}`);

if (!apply) { console.log('\nDry run — pass --apply to write the result.'); process.exit(0); }

const result = {
  drawnAt: new Date().toISOString(),
  seed,
  seedSha256: createHash('sha256').update(String(seed), 'utf8').digest('hex'),
  snapshotBlob: blob,
  snapshotTakenAt: snapshot.takenAt,
  totals: snapshot.totals,
  winner,
  referralPrize: prize,
  ordering,
};
writeFileSync(join(ROOT, RESULT_REL), `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nWrote ${RESULT_REL}. Commit it.`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/scripts/giveaway-draw-guards.test.js`
Expected: PASS, `# fail 0`, `# cancelled 0`

- [ ] **Step 5: Verify the refusal paths by hand**

```bash
node scripts/giveaway/draw.mjs                     # refuses: no seed
node scripts/giveaway/draw.mjs --seed 1            # refuses: snapshot missing
```
Expected: both exit non-zero with the stated message.

- [ ] **Step 6: Commit**

```bash
git add scripts/giveaway/draw.mjs tests/scripts/giveaway-draw-guards.test.js
git commit -m "feat(giveaway): the draw script, refusing on every unsafe path"
```

---

### Task 6: End-to-end rehearsal against a synthetic snapshot

The drawing runs once. It must be rehearsed on realistic data before the day.

**Files:**
- Create: `tests/scripts/giveaway-draw-e2e.test.js`

**Interfaces:**
- Consumes: `buildSnapshot` (Task 2), `drawOrdering` + `determineReferralPrize` (Task 3).

- [ ] **Step 1: Write the test**

```js
// tests/scripts/giveaway-draw-e2e.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSnapshot } from '../../lib/giveaway/draw-snapshot.js';
import { drawOrdering, determineReferralPrize } from '../../lib/giveaway/draw.js';

// Shaped like the real 2026-08-22 population: ~28% confirmed, a handful of
// referrals, one same-person pair.
function population() {
  const out = [];
  for (let i = 0; i < 80; i += 1) {
    out.push({
      email: `conf${i}@x.com`,
      subscribed: true,
      properties: {
        gv_entered_at: '2026-08-25T12:00:00.000Z',
        gv_confirmed_at: '2026-08-26T12:00:00.000Z',
        gv_breakdown: { confirmed: true, survey: i % 2 === 0, referrals: 0, instagram: false, upload: false },
      },
    });
  }
  for (let i = 0; i < 200; i += 1) {
    out.push({
      email: `pend${i}@x.com`,
      subscribed: false,
      properties: {
        gv_entered_at: '2026-09-01T12:00:00.000Z',
        gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
      },
    });
  }
  out.push({
    email: 'lisamarob@gmail.com',
    subscribed: true,
    properties: {
      gv_entered_at: '2026-08-21T12:00:00.000Z',
      gv_confirmed_at: '2026-08-21T13:00:00.000Z',
      gv_referred_by: 'lisamarobin@outlook.com',
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    },
  });
  out.push({
    email: 'lisamarobin@outlook.com',
    subscribed: true,
    properties: {
      gv_entered_at: '2026-08-21T12:00:00.000Z',
      gv_confirmed_at: '2026-08-21T13:00:00.000Z',
      gv_breakdown: { confirmed: true, survey: false, referrals: 1, instagram: false, upload: false },
    },
  });
  return out;
}

const snap = buildSnapshot(population(), {
  entryClosesAt: '2026-09-14T23:59:59-07:00',
  includeUnconfirmed: true,
  takenAt: '2026-09-15T12:05:00.000Z',
});

test('the rehearsal snapshot is internally consistent', () => {
  assert.equal(snap.totals.entrants, 282);
  assert.equal(snap.totals.entries, snap.entrants.reduce((n, e) => n + e.entries, 0));
  assert.equal(snap.totals.confirmed + snap.totals.unconfirmed, snap.totals.entrants);
});

test('a full draw completes and is reproducible', () => {
  const a = drawOrdering(snap, '43214.87');
  const b = drawOrdering(snap, '43214.87');
  assert.deepEqual(a, b);
  assert.equal(a.length, snap.totals.entrants, 'everyone is somewhere in the ordering');
  assert.equal(new Set(a).size, a.length, 'no duplicates');
});

test('REGRESSION: the same-person pair never wins the second prize', () => {
  const r = determineReferralPrize(snap, 'lisamarob@gmail.com');
  assert.equal(r.awarded, false);
  assert.equal(r.email, null);
});

test('an unconfirmed winner is possible and awards no referral prize', () => {
  const r = determineReferralPrize(snap, 'pend7@x.com');
  assert.equal(r.awarded, false, 'they named nobody');
});
```

- [ ] **Step 2: Run it**

Run: `source ~/.nvm/nvm.sh && nvm use && node --test tests/scripts/giveaway-draw-e2e.test.js`
Expected: PASS. If `totals.entrants` differs from 282, fix the expectation to match the fixture rather than the code.

- [ ] **Step 3: Run the FULL suite**

Run: `source ~/.nvm/nvm.sh && nvm use && npm test 2>&1 | tail -8`
Expected: `# fail 0` **and** `# cancelled 0`.

- [ ] **Step 4: Commit**

```bash
git add tests/scripts/giveaway-draw-e2e.test.js
git commit -m "test(giveaway): end-to-end draw rehearsal on a realistic population"
```

---

### Task 7: Winner notification draft

**Files:**
- Create: `scripts/giveaway/draft-winner-email.mjs`

**Interfaces:**
- Consumes: `data/giveaway/draw-result.json` (Task 5).
- Produces: `data/giveaway/winner-email-draft.md`.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * Draft the winner notification. DOES NOT SEND.
 *
 * §8 requires notification within 48 hours of the drawing and gives the winner 7
 * days to respond. Nothing auto-sends a $536.40 prize notification: a human
 * reads this and sends it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = JSON.parse(readFileSync(join(ROOT, 'data', 'giveaway', 'draw-result.json'), 'utf8'));
const OUT = join(ROOT, 'data', 'giveaway', 'winner-email-draft.md');

const deadline = new Date(Date.parse(result.drawnAt) + 7 * 864e5).toISOString().slice(0, 10);

const draft = `# Winner notification — DRAFT, NOT SENT

Drawn: ${result.drawnAt}
Seed: ${result.seed}
Snapshot: ${result.snapshotBlob}
Winner: **${result.winner}**
Referral prize: ${result.referralPrize.awarded ? `**${result.referralPrize.email}**` : 'NOT AWARDED'} — ${result.referralPrize.reason}

Respond-by (§8, 7 days): **${deadline}**
If no response by then, the next name in the committed ordering is the alternate:
${result.ordering.slice(1, 4).map((e, i) => `  ${i + 1}. ${e}`).join('\n')}

---

## To: ${result.winner}
## Subject: You won the Real Skin Care soap giveaway

Hi,

You've been drawn as the winner of our Pure Unscented soap giveaway.

Your prize is 36 bars of Pure Unscented Moisturizing Coconut Soap, shipped over
three years in three shipments a year of four bars each, plus three Sensitive
Skin Moisturizing Sets, one a year alongside that year's first soap shipment.

To claim it, just reply to this email by **${deadline}**. If we don't hear from
you by then we'll need to draw an alternate, which we'd rather not do.

The drawing was conducted from a frozen list of all entries, shuffled using the
Dow Jones closing value on September 15, 2026 as published on the giveaway page
beforehand.

Congratulations,
Real Skin Care
`;

writeFileSync(OUT, draft);
console.log(`Wrote ${OUT}`);
console.log('READ IT, then send by hand. Nothing here sends email.');
```

- [ ] **Step 2: Verify it refuses cleanly with no result file**

Run: `source ~/.nvm/nvm.sh && nvm use && node scripts/giveaway/draft-winner-email.mjs`
Expected: throws `ENOENT` on `draw-result.json` — acceptable, since it can only run after a draw.

- [ ] **Step 3: Commit**

```bash
git add scripts/giveaway/draft-winner-email.mjs
git commit -m "feat(giveaway): draft the winner notification for a human to send"
```

---

### Task 8: Documentation and the runbook

**Files:**
- Modify: `docs/giveaway-referral-lessons.md` (add the un-stamped-rungs note)
- Create: `docs/giveaway-draw-runbook.md`

- [ ] **Step 1: Add the lesson uncovered in Task 2**

Append to `docs/giveaway-referral-lessons.md` under "For the next promotion":

```markdown
9. **Stamp every entry rung, not just confirmation.** Only `gv_confirmed_at`
   carries a timestamp, so the snapshot can prove a *confirmation* happened
   inside the Entry Period but has to take survey, Instagram and upload rungs as
   stored. Nothing currently records when those were earned, so a rung credited
   after entries closed cannot be detected. Stamp each rung at the moment it is
   credited and the Entry-Period gate becomes total instead of partial.
```

- [ ] **Step 2: Write the runbook**

```markdown
# Drawing runbook — September 15-16, 2026

Order matters. Every step is refusable; nothing here is a formality.

## Before September 14 (HARD DEADLINE)
- [ ] Seed commitment copy live on the giveaway page. Text: appendix of
      `docs/superpowers/specs/2026-08-22-giveaway-draw-design.md`.
      Announcing the method after entries close defeats it.

## September 15 (snapshot)
- [ ] `close-entry-period.mjs` runs 05:05 PT and takes the snapshot. Confirm the
      immediate email arrived.
- [ ] Pull it down and COMMIT it:
      `scp root@137.184.119.230:~/seo-claude/data/giveaway/draw-snapshot.json data/giveaway/`
- [ ] Branch, PR, merge. `draw.mjs` refuses on an uncommitted snapshot.
- [ ] Sanity-check totals against the last `report.mjs` before the close.

## September 15, after markets close
- [ ] Record the DJIA closing value. This is the seed. Write it down.

## September 16 (the drawing)
- [ ] Dry run: `node scripts/giveaway/draw.mjs --seed <value>`
- [ ] Read the winner and the §6 determination. If the referral prize is refused,
      confirm the stated reason matches the rules.
- [ ] `node scripts/giveaway/draw.mjs --seed <value> --apply`
- [ ] Commit `data/giveaway/draw-result.json`.
- [ ] `node scripts/giveaway/draft-winner-email.mjs`, read the draft, send by hand.

## If the winner does not respond by the §8 deadline
- [ ] The alternate is already in `draw-result.json` → `ordering[1]`. No new draw.
```

- [ ] **Step 3: Commit**

```bash
git add docs/giveaway-referral-lessons.md docs/giveaway-draw-runbook.md
git commit -m "docs(giveaway): drawing runbook and the un-stamped-rungs lesson"
```

---

## Self-Review

**Spec coverage.** Snapshot phase → Tasks 2, 4. Post-close gate → Task 2 (test + implementation). Committed-snapshot guard → Task 5. Seeded ordering with alternates → Tasks 1, 3. §6 four conditions → Task 3. Notification draft → Task 7. Error/refusal table → Task 5 (guard test) plus Task 5 Step 5. Test list → Tasks 1, 2, 3, 5, 6. Seed-commitment copy → Task 8 runbook (the copy itself lives in the spec appendix and ships separately as a page edit). No spec section is unimplemented.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. No "similar to Task N".

**Type consistency.** `buildSnapshot` returns `{ takenAt, entryClosesAt, determinations, totals, entrants, excluded }` in Task 2 and is consumed with those exact keys in Tasks 4, 5, 6. `drawOrdering(snapshot, seed)` and `determineReferralPrize(snapshot, winnerEmail)` are defined in Task 3 and called with the same signatures in Tasks 5 and 6. `assertSnapshotCommitted(root, relPath)` is defined and tested in Task 5. `entrants[]` rows carry `email, entries, confirmed, referredBy, samePersonSuspected` consistently across Tasks 2, 3, 5, 6.

**One deliberate omission.** Task 4 has no unit test of its own — its logic is Task 2's, and what remains is Klaviyo I/O plus file writing, verified by the dry run in Step 2. Adding a mocked-Klaviyo test there would assert that the mock was called, not that the snapshot is right.
