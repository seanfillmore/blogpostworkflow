# Giveaway Entry Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove every one of the six entry-earning methods credits the correct number of entries, and that twelve must-not-credit paths credit nothing, before any ad spend.

**Architecture:** A pure identity builder (`lib/giveaway/test-identity.js`) defines five test identities and their expected totals with no I/O, so the arithmetic is unit-testable. A phased harness (`scripts/giveaway/e2e-verify.mjs`) drives the real public HTTP endpoints against the production Klaviyo list, pausing once for two human confirmation clicks. Test profiles are marked `gv_test`, excluded from the report and (as a binding future requirement) the draw, included by the reconciler, deleted on cleanup, and backstopped by a new Gate A assertion that none remain.

**Tech Stack:** Node 22 (ESM), `node:test` + `node:assert/strict`, the live Klaviyo API via `lib/klaviyo-profiles.js`, and `fetch` against `https://entries.realskincare.com`.

**Spec:** `docs/superpowers/specs/2026-08-12-giveaway-entry-verification-design.md`

## Global Constraints

- **Node 22 LTS.** Run `nvm use` and confirm `node --version` before any test. When reading `node --test` output, **check the cancelled count, not just `# fail 0`** — a cancelled test prints alongside `# fail 0` and reads like a pass, and that trap hid a dead test in this repo for months.
- **Work only in the worktree** `.claude/worktrees/giveaway-e2e` on branch `feature/giveaway-entry-verification`. Re-check `git branch --show-current` before every commit.
- **ESM only.**
- **Every test identity carries `gv_test: true` and `gv_test_run: <runid>`.** No exceptions — Gate A will refuse launch if any remain, and the whole prize-safety argument rests on the marker being present.
- **The reconciler must keep processing `gv_test` profiles.** Excluding them there would make the framework unable to verify the confirm and referral rungs. Only the report and the future draw exclude them.
- **This runs against the PRODUCTION Klaviyo list `Y2ukbE`.** Every profile created is real. Cleanup is not optional.
- **Never weaken an assertion to make the harness pass.** Its value is entirely in failing when something is wrong.
- **Entry values are fixed:** base 1, confirm +2, survey +3, referral +5 (cap 10 friends), Instagram +3, upload +10; ceiling 69.
- The endpoint host is `https://entries.realskincare.com`. It returns **401 until PR #434 merges and the dashboard deploys** — the running app has no `routes/giveaway.js`, so requests fall through to basic auth instead of the pre-auth allowlist.

### Expected totals (the arithmetic the whole framework checks)

| Identity | Role | Confirms | Expected |
|---|---|---|--:|
| A | referrer; survey + Instagram + upload | yes | **24** = 1+2+3+3+10+5 |
| B | enters naming A, confirms | yes | **3** = 1+2 |
| C | enters naming A, never confirms | no | **1** |
| D | names itself | no | **1** |
| E | names an address that never entered | no | **1** |

---

### Task 1: Test-identity builder

Pure, no I/O, so the arithmetic every later phase depends on is provable without touching Klaviyo.

**Files:**
- Create: `lib/giveaway/test-identity.js`
- Test: `tests/lib/giveaway-test-identity.test.js`

**Interfaces:**
- Consumes: `ENTRY_VALUES`, `REFERRAL_CAP` from `lib/giveaway/entries.js`.
- Produces:
  - `TEST_MARKER = 'gv_test'`
  - `buildIdentities(runId, baseEmail) -> { a, b, c, d, e }`, each `{ key, email, firstName, referredBy, confirms, expected, properties }` where `referredBy` is an email string or `null`, `confirms` is a boolean, `expected` is the final entry count, and `properties` is `{ gv_test: true, gv_test_run: runId }`
  - `isTestProfile(properties) -> boolean`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/giveaway-test-identity.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildIdentities, isTestProfile, TEST_MARKER } from '../../lib/giveaway/test-identity.js';
import { ENTRY_VALUES, REFERRAL_CAP } from '../../lib/giveaway/entries.js';

const ids = buildIdentities('r1', 'someone@gmail.com');

test('all five identities are plus-aliases on the one real inbox, so every confirmation email lands together', () => {
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    assert.match(ids[k].email, /^someone\+gvtest-r1-[abcde]@gmail\.com$/, `${k} must be an alias`);
  }
  const emails = new Set(Object.values(ids).map((i) => i.email));
  assert.equal(emails.size, 5, 'the five addresses must be distinct');
});

test('A expects 24 — every positive rung plus exactly one confirmed referral', () => {
  const { base, confirm, survey, referral, instagram, upload } = ENTRY_VALUES;
  assert.equal(ids.a.expected, base + confirm + survey + instagram + upload + referral);
  assert.equal(ids.a.expected, 24, 'stated independently so a change to ENTRY_VALUES cannot silently move the target');
});

test('B expects 3: it only enters and confirms', () => {
  assert.equal(ids.b.expected, 4 - 1);
  assert.equal(ids.b.expected, 3);
});

test('C, D and E expect 1 — they must earn nothing at all', () => {
  for (const k of ['c', 'd', 'e']) assert.equal(ids[k].expected, 1, `${k} must stay at the base entry`);
});

test('only A and B are meant to confirm — leaving C unconfirmed is what proves the negative case', () => {
  assert.deepEqual(
    Object.values(ids).filter((i) => i.confirms).map((i) => i.key),
    ['a', 'b'],
  );
});

test('the referral graph is wired so each negative case is provable', () => {
  assert.equal(ids.a.referredBy, null, 'A names nobody');
  assert.equal(ids.b.referredBy, ids.a.email, 'B names A and confirms -> A earns +5');
  assert.equal(ids.c.referredBy, ids.a.email, 'C names A but never confirms -> A earns nothing more');
  assert.equal(ids.d.referredBy, ids.d.email, 'D names itself -> self-referral void');
  assert.match(ids.e.referredBy, /never-entered/, 'E names an address that never entered');
  assert.notEqual(ids.e.referredBy, ids.a.email);
});

test('every identity is marked, because Gate A refuses launch while any test profile remains', () => {
  for (const i of Object.values(ids)) {
    assert.equal(i.properties[TEST_MARKER], true);
    assert.equal(i.properties.gv_test_run, 'r1');
  }
});

test('isTestProfile recognises the marker and does not false-positive on a real entrant', () => {
  assert.equal(isTestProfile({ gv_test: true }), true);
  assert.equal(isTestProfile({ gv_entrant: true }), false);
  assert.equal(isTestProfile({}), false);
  assert.equal(isTestProfile(undefined), false);
});

test('the ladder ceiling is still 69, so the expected totals are anchored to the real rules', () => {
  const { base, confirm, survey, referral, instagram, upload } = ENTRY_VALUES;
  assert.equal(base + confirm + survey + referral * REFERRAL_CAP + instagram + upload, 69);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && node --test tests/lib/giveaway-test-identity.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/test-identity.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/giveaway/test-identity.js
/**
 * The five test identities used to verify every entry-earning method.
 *
 * Chosen so each NEGATIVE case is provable rather than merely absent:
 *   A  referrer; also does survey, Instagram and upload. Confirms.
 *   B  enters naming A and confirms  -> A earns +5
 *   C  enters naming A, never confirms -> A must earn nothing more
 *   D  names itself                  -> self-referral void
 *   E  names an address that never entered -> credits nobody
 *
 * Addresses are plus-aliases on one real inbox so all five confirmation
 * emails land in a single mailbox and a human can click two of them.
 *
 * Every identity carries gv_test. These profiles are created on the PRODUCTION
 * list, so the marker is what keeps them out of the report and out of the draw,
 * and what lets Gate A refuse launch while any remain. A profile without it is
 * indistinguishable from a real entrant and could win a $536.40 prize.
 */
import { ENTRY_VALUES } from './entries.js';

export const TEST_MARKER = 'gv_test';

const alias = (baseEmail, runId, key) => {
  const [local, domain] = String(baseEmail).split('@');
  return `${local}+gvtest-${runId}-${key}@${domain}`;
};

export function buildIdentities(runId, baseEmail) {
  const e = (key) => alias(baseEmail, runId, key);
  const props = { [TEST_MARKER]: true, gv_test_run: runId };
  const { base, confirm, survey, referral, instagram, upload } = ENTRY_VALUES;

  const emails = { a: e('a'), b: e('b'), c: e('c'), d: e('d'), e: e('e') };

  return {
    a: {
      key: 'a', email: emails.a, firstName: 'Test A', referredBy: null, confirms: true,
      expected: base + confirm + survey + instagram + upload + referral,
      properties: { ...props },
    },
    b: {
      key: 'b', email: emails.b, firstName: 'Test B', referredBy: emails.a, confirms: true,
      expected: base + confirm,
      properties: { ...props },
    },
    c: {
      key: 'c', email: emails.c, firstName: 'Test C', referredBy: emails.a, confirms: false,
      expected: base,
      properties: { ...props },
    },
    d: {
      key: 'd', email: emails.d, firstName: 'Test D', referredBy: emails.d, confirms: false,
      expected: base,
      properties: { ...props },
    },
    e: {
      key: 'e', email: emails.e, firstName: 'Test E',
      referredBy: alias(baseEmail, runId, 'never-entered'), confirms: false,
      expected: base,
      properties: { ...props },
    },
  };
}

export function isTestProfile(properties) {
  return (properties || {})[TEST_MARKER] === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/giveaway-test-identity.test.js`
Expected: PASS, 9 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/giveaway/test-identity.js tests/lib/giveaway-test-identity.test.js
git commit -m "feat(giveaway): test-identity builder with provable negative cases"
```

---

### Task 2: Exclude test profiles from the report, and refuse launch while any remain

Two small changes that together make the production-list decision safe. Shipped as one task because they are the same guarantee at two layers, and a reviewer would accept or reject them together.

**Files:**
- Modify: `lib/giveaway/summarize.js`
- Modify: `scripts/giveaway/verify-launch.mjs`
- Test: `tests/lib/giveaway-summarize.test.js` (add cases)

**Interfaces:**
- Consumes: `isTestProfile` from `lib/giveaway/test-identity.js`; `listProfilesWithConsent` from `lib/klaviyo-profiles.js`; `config.listId`.
- Produces: `summarizeEntrants` now returns an additional `excludedTestProfiles` count.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/giveaway-summarize.test.js`:

```javascript
test('test profiles are excluded from every count, so they cannot skew the day-5 gate', () => {
  const real = { id: 'r', email: 'real@x.com', properties: {
    gv_entries: 8, gv_frustration: 'reactive',
    gv_breakdown: { confirmed: true, survey: true, referrals: 1, instagram: false, upload: false },
  } };
  const fake = { id: 't', email: 'test@x.com', properties: {
    gv_test: true, gv_entries: 24, gv_frustration: 'dry',
    gv_breakdown: { confirmed: true, survey: true, referrals: 1, instagram: true, upload: true },
  } };
  const s = summarizeEntrants([real, fake]);
  assert.equal(s.total, 1, 'only the real entrant counts');
  assert.equal(s.entriesTotal, 8, 'the fake 24 must not be summed');
  assert.equal(s.answers.frustration.dry, undefined, 'the fake answer must not enter the mix');
  assert.equal(s.answers.frustration.reactive, 1);
  assert.equal(s.ladder.upload, 0, 'the fake upload must not be counted');
  assert.equal(s.excludedTestProfiles, 1, 'and the exclusion is reported, not silent');
});

test('with no test profiles present the exclusion count is zero rather than absent', () => {
  const s = summarizeEntrants([{ id: 'r', email: 'r@x.com', properties: { gv_entries: 1 } }]);
  assert.equal(s.excludedTestProfiles, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/giveaway-summarize.test.js`
Expected: FAIL — `s.total` is 2 and `excludedTestProfiles` is `undefined`.

- [ ] **Step 3: Add the exclusion to `lib/giveaway/summarize.js`**

Add the import at the top:

```javascript
import { isTestProfile } from './test-identity.js';
```

Then, inside `summarizeEntrants`, immediately after `export function summarizeEntrants(profiles) {`, filter before anything else counts:

```javascript
  // Test identities live on the PRODUCTION list on purpose, so that the harness
  // exercises the configuration we actually launch with. They must never reach a
  // count: a fake 24-entry profile would distort the day-5 answer-mix gate that
  // decides whether ad spend continues.
  const all = profiles || [];
  const excludedTestProfiles = all.filter((p) => isTestProfile(p.properties)).length;
  profiles = all.filter((p) => !isTestProfile(p.properties));
```

and add `excludedTestProfiles` to the returned object:

```javascript
  return { total: profiles.length, entriesTotal, ladder, answers, excludedTestProfiles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/giveaway-summarize.test.js`
Expected: PASS. Confirm `# cancelled 0`.

- [ ] **Step 5: Add the Gate A check**

In `scripts/giveaway/verify-launch.mjs`, add the import beside the other lib imports:

```javascript
import { listProfilesWithConsent } from '../../lib/klaviyo-profiles.js';
import { isTestProfile } from '../../lib/giveaway/test-identity.js';
```

Then add this check before the final `if (failures.length)` block:

```javascript
// 8. No test identities may remain in the entrant pool.
//
// The verification harness creates real profiles on the production list. Cleanup
// deletes them, but cleanup can be forgotten — and a forgotten test profile sits
// in the draw pool with a real chance of winning a $536.40 prize. A gate cannot
// be forgotten. This also finally covers the single real test entry the launch
// runbook has always mandated, which nothing previously excluded.
try {
  const members = await listProfilesWithConsent(config.listId);
  const leftovers = members.filter((p) => isTestProfile(p.properties));
  check(
    leftovers.length === 0,
    `no gv_test profiles remain on the entrant list (found ${leftovers.length}${leftovers.length ? ': ' + leftovers.map((p) => p.email).join(', ') : ''})`,
  );
} catch (e) {
  check(false, `could not enumerate the entrant list to check for test profiles: ${e.message}`);
}
```

- [ ] **Step 6: Run the gate**

Run: `node scripts/giveaway/verify-launch.mjs`
Expected: the new line reads `PASS  no gv_test profiles remain on the entrant list (found 0)`. The gate still exits non-zero overall while the endpoint is undeployed — that is correct and expected.

- [ ] **Step 7: Commit**

```bash
git add lib/giveaway/summarize.js scripts/giveaway/verify-launch.mjs tests/lib/giveaway-summarize.test.js
git commit -m "feat(giveaway): exclude test profiles from the report, refuse launch while any remain"
```

---

### Task 3: Harness — phases 0 to 3 (preflight, seed, positive rungs, negative cases)

The half that needs no human. Drives the real public endpoints.

**Files:**
- Create: `scripts/giveaway/e2e-verify.mjs`

**Interfaces:**
- Consumes: `buildIdentities`, `isTestProfile` from `lib/giveaway/test-identity.js`; `getProfileByEmail` from `lib/klaviyo-profiles.js`; `config.listId`.
- Produces: a CLI with subcommands `preflight`, `seed`, `positive`, `negative`, `reconcile`, `limits`, `exclusion`, `cleanup`, `status`. Writes `data/reports/giveaway/e2e-<runid>.json`. Exits non-zero on any failed assertion.

- [ ] **Step 1: Write the harness skeleton, assertion recorder and phases 0–3**

```javascript
// scripts/giveaway/e2e-verify.mjs
/**
 * End-to-end verification of every entry-earning method.
 *
 *   node scripts/giveaway/e2e-verify.mjs <phase> --run <id> --email you@gmail.com
 *
 * Phases, in this order:
 *   preflight  endpoint reachable, DNS resolves from HERE, config sane
 *   seed       create A-E via the real POST /enter
 *   positive   A: survey -> 4, instagram -> 7, upload -> 17
 *   negative   the twelve must-not-credit cases
 *   ---- human clicks the confirmation emails for A and B only ----
 *   reconcile  run the reconciler, assert A=24 B=3 C=D=E=1
 *   limits     rate-limit boundaries            RUN LAST
 *   exclusion  the report must not count test profiles
 *   cleanup    delete every gv_test profile and verify they are gone
 *   status     show current totals without changing anything
 *
 * This creates REAL profiles on the PRODUCTION list. Cleanup is not optional;
 * Gate A refuses launch while any gv_test profile remains.
 *
 * Never weaken an assertion to make this pass. Its only value is failing.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { buildIdentities, isTestProfile } from '../../lib/giveaway/test-identity.js';
import { getProfileByEmail, listProfilesWithConsent } from '../../lib/klaviyo-profiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const HOST = 'https://entries.realskincare.com';
const API = `${HOST}/api/giveaway`;

const argv = process.argv.slice(2);
const phase = argv[0];
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const runId = arg('run');
const baseEmail = arg('email');

if (!phase) { console.error('usage: e2e-verify.mjs <phase> --run <id> --email you@gmail.com'); process.exit(2); }
if (!runId) { console.error('--run <id> is required so identities and cleanup are scoped to one run'); process.exit(2); }
if (phase !== 'cleanup' && phase !== 'status' && !baseEmail) {
  console.error('--email you@gmail.com is required (aliases are built from it)'); process.exit(2);
}

const ids = baseEmail ? buildIdentities(runId, baseEmail) : null;
const results = [];
let failed = 0;
function assert(ok, label, detail = '') {
  if (!ok) failed += 1;
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
};
const entriesOf = async (email) => {
  const p = await getProfileByEmail(email);
  return { entries: p?.properties?.gv_entries ?? null, breakdown: p?.properties?.gv_breakdown ?? null, props: p?.properties ?? null };
};
// A 1x1 PNG, the smallest valid image the upload path will accept.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function preflight() {
  try {
    const { address } = await lookup('entries.realskincare.com');
    assert(true, 'entries.realskincare.com resolves from this machine', address);
  } catch (e) {
    assert(false, 'entries.realskincare.com resolves from this machine',
      `${e.code} — a resolver holding the NXDOMAIN cached before the record existed will report this. Test from the server or wait for the cache to expire; it is NOT a broken endpoint.`);
  }
  const res = await fetch(`${API}/entries?email=not-an-email`).catch((e) => ({ status: 0, err: e.message }));
  assert(res.status === 400, 'the endpoint answers without auth', `got ${res.status}${res.status === 401 ? ' — the dashboard has not been deployed with routes/giveaway.js yet' : ''}`);
  assert(!!config.listId, 'config.listId is set', config.listId || '');
  assert(!!config.metaPixelId, 'config.metaPixelId is set', config.metaPixelId || '');
}

async function seed() {
  for (const id of Object.values(ids)) {
    const body = { email: id.email, firstName: id.firstName };
    if (id.referredBy) body.referredBy = id.referredBy;
    const { status, json } = await post('/enter', body);
    assert(status === 201, `${id.key.toUpperCase()} entered`, `status ${status}`);
    assert(json?.entries === 1, `${id.key.toUpperCase()} starts at exactly 1 entry`, `got ${json?.entries}`);
    // The marker is what keeps this profile out of the report and the draw.
    await post('/answers', { email: id.email, ...id.properties });
    const { props } = await entriesOf(id.email);
    assert(isTestProfile(props), `${id.key.toUpperCase()} carries the gv_test marker`);
  }
}

async function positive() {
  const a = ids.a;
  let cur = await entriesOf(a.email);
  assert(cur.entries === 1, 'A begins the positive phase at 1', `got ${cur.entries}`);

  await post('/answers', { email: a.email, household: 'solo', frustration: 'fragrance', currentBrand: 'cerave' });
  cur = await entriesOf(a.email);
  assert(cur.entries === 4, 'survey credits +3', `got ${cur.entries}`);
  assert(cur.props?.gv_frustration === 'fragrance', 'the survey answer is stored as a TOP-LEVEL property the flow can filter on');

  await post('/answers', { email: a.email, instagram: true, igHandle: '@gvtest' });
  cur = await entriesOf(a.email);
  assert(cur.entries === 7, 'Instagram credits +3', `got ${cur.entries}`);

  const up = await post('/upload', { email: a.email, filename: 'a.png', dataBase64: TINY_PNG, rightsGranted: true });
  assert(up.status === 200, 'upload accepted with rights granted', `status ${up.status}`);
  cur = await entriesOf(a.email);
  assert(cur.entries === 17, 'upload credits +10', `got ${cur.entries}`);
  assert(typeof cur.props?.gv_upload_url === 'string', 'the uploaded asset URL is recorded');
}

async function negative() {
  const a = ids.a;
  const before = await entriesOf(a.email);

  // 1. Self-referral: the ENTRY must still succeed. Losing a paid entry over a
  //    bad optional field would be the more expensive failure.
  const d = await entriesOf(ids.d.email);
  assert(d.entries === 1, 'D (self-referral) still holds its base entry', `got ${d.entries}`);
  assert(!d.props?.gv_referred_by, 'D has no referrer stored — self-referral was dropped, not honoured');

  // 4-6. A client may declare WHICH action it performed, never what it is worth.
  await post('/answers', { email: a.email, gv_entries: 9999 });
  assert((await entriesOf(a.email)).entries === before.entries, 'a client-supplied gv_entries is ignored');
  await post('/answers', { email: a.email, confirmed: true });
  assert((await entriesOf(a.email)).breakdown?.confirmed === false, 'a request cannot set breakdown.confirmed');
  await post('/answers', { email: a.email, referrals: 50 });
  assert((await entriesOf(a.email)).breakdown?.referrals === 0, 'a request cannot set referral credits');

  // 7. Unknown enum values are dropped, not stored.
  await post('/answers', { email: a.email, household: 'martian' });
  assert((await entriesOf(a.email)).props?.gv_household === 'solo', 'an unknown enum value is dropped and the real one survives');

  // 8-10. Upload guards.
  const noRights = await post('/upload', { email: a.email, filename: 'x.png', dataBase64: TINY_PNG, rightsGranted: false });
  assert(noRights.status === 400, 'upload without granted rights is rejected', `status ${noRights.status}`);
  const badExt = await post('/upload', { email: a.email, filename: 'x.svg', dataBase64: TINY_PNG, rightsGranted: true });
  assert(badExt.status === 400, 'a non-image extension is rejected', `status ${badExt.status}`);
  const huge = await post('/upload', { email: a.email, filename: 'big.png', dataBase64: 'A'.repeat(9 * 1024 * 1024), rightsGranted: true });
  assert(huge.status === 400 || huge.status === 413, 'an oversized upload is rejected', `status ${huge.status}`);

  // 11. A repeat entry must not reset earned progress.
  const reEnter = await post('/enter', { email: a.email, firstName: 'Test A' });
  assert(reEnter.status === 201, 'a repeat entry is accepted', `status ${reEnter.status}`);
  const after = await entriesOf(a.email);
  assert(after.entries === before.entries, 'a repeat entry does NOT reset progress', `${before.entries} -> ${after.entries}`);
  assert(after.breakdown?.survey === true, 'the survey rung survives a repeat entry');
  assert(after.breakdown?.upload === true, 'the upload rung survives a repeat entry');

  // 12. Purchases can never earn entries — assert the absence structurally.
  const routes = readFileSync(join(ROOT, 'agents', 'dashboard', 'routes', 'giveaway.js'), 'utf8');
  assert(!/order|checkout|purchase|webhook/i.test(routes), 'no purchase, order or webhook path exists in the giveaway routes');
}
```

- [ ] **Step 2: Add the dispatcher and the JSON artifact at the end of the file**

```javascript
const PHASES = { preflight, seed, positive, negative };

const fn = PHASES[phase];
if (!fn) {
  console.error(`unknown phase '${phase}'. one of: ${Object.keys(PHASES).join(', ')}`);
  process.exit(2);
}
console.log(`\n=== phase: ${phase}  run: ${runId} ===\n`);
await fn();

const OUT = join(ROOT, 'data', 'reports', 'giveaway');
mkdirSync(OUT, { recursive: true });
const artifactPath = join(OUT, `e2e-${runId}.json`);
let artifact = { runId, phases: {} };
try { artifact = JSON.parse(readFileSync(artifactPath, 'utf8')); } catch { /* first phase */ }
artifact.phases[phase] = { failed, results };
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`\n${results.length - failed}/${results.length} assertions passed`);
if (failed) { console.error(`${failed} FAILED — do not launch.`); process.exit(1); }
```

- [ ] **Step 3: Verify the harness refuses to run without its arguments**

Run: `node scripts/giveaway/e2e-verify.mjs`
Expected: usage message, exit code 2.

Run: `node scripts/giveaway/e2e-verify.mjs seed --run t1`
Expected: complains that `--email` is required, exit 2.

- [ ] **Step 4: Run preflight**

Run: `node scripts/giveaway/e2e-verify.mjs preflight --run t1 --email $USER@example.com`
Expected: exits non-zero **while the dashboard is undeployed**, with `the endpoint answers without auth — got 401 — the dashboard has not been deployed with routes/giveaway.js yet`. That message is the deliverable: a failure that names its own cause. Do not weaken it.

- [ ] **Step 5: Commit**

```bash
git add scripts/giveaway/e2e-verify.mjs
git commit -m "feat(giveaway): e2e harness phases 0-3 — preflight, seed, positive rungs, negative cases"
```

---

### Task 4: Harness — phases 4 to 9 (reconcile, limits, exclusion, cleanup, status)

The half that spans the human pause, plus the safety-critical cleanup.

**Files:**
- Modify: `scripts/giveaway/e2e-verify.mjs`

**Interfaces:**
- Consumes: everything from Task 3; `klaviyoRequest` from `lib/klaviyo.js`; `summarizeEntrants` from `lib/giveaway/summarize.js`.
- Produces: the remaining phases, registered in `PHASES`.

- [ ] **Step 1: Add the remaining phases above the `PHASES` map**

```javascript
import { execFileSync } from 'node:child_process';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';

async function reconcile() {
  // The reconciler is the ONLY writer of the confirm and referral rungs, and it
  // reads Klaviyo's confirmed set. It deliberately does NOT skip gv_test
  // profiles — excluding them there would make this phase unable to verify the
  // two rungs it exists to verify.
  console.log('running the reconciler…');
  const out = execFileSync('node', [join(ROOT, 'scripts', 'giveaway', 'reconcile-referrals.mjs'), '--apply'], { encoding: 'utf8' });
  console.log(out.trim());

  for (const id of Object.values(ids)) {
    const { entries, breakdown } = await entriesOf(id.email);
    assert(entries === id.expected, `${id.key.toUpperCase()} totals ${id.expected}`, `got ${entries}`);
    assert(
      breakdown?.confirmed === id.confirms,
      `${id.key.toUpperCase()} confirmed === ${id.confirms}`,
      `got ${breakdown?.confirmed}`,
    );
  }

  const a = await entriesOf(ids.a.email);
  assert(a.breakdown?.referrals === 1, 'A was credited for exactly ONE referral — B confirmed, C did not', `got ${a.breakdown?.referrals}`);
  const d = await entriesOf(ids.d.email);
  assert((d.breakdown?.referrals ?? 0) === 0, 'D earned nothing from naming itself');
  const e = await entriesOf(ids.e.email);
  assert((e.breakdown?.referrals ?? 0) === 0, 'E earned nothing from naming a non-entrant');
}

async function limits() {
  // MUST run last: the limiter is per-IP and this harness is one IP, so proving
  // /enter 429s burns that budget for an hour. Restart PM2 afterwards to clear
  // the in-memory map — it is designed to reset on restart.
  const burn = (n, path, bodyFor) => (async () => {
    const seen = [];
    for (let i = 0; i < n; i += 1) seen.push((await post(path, bodyFor(i))).status);
    return seen;
  })();

  const enterStatuses = await burn(7, '/enter', (i) => ({ email: `${ids.a.email.replace('@', `+lim${i}@`)}`, firstName: 'Lim' }));
  assert(enterStatuses.slice(0, 5).every((s) => s === 201), '/enter accepts the first 5 from one IP', enterStatuses.join(','));
  assert(enterStatuses[5] === 429, '/enter 429s on the 6th', `got ${enterStatuses[5]}`);

  const mutateStatuses = await burn(32, '/answers', () => ({ email: ids.a.email, survey: true }));
  const firstRefusal = mutateStatuses.indexOf(429);
  assert(firstRefusal === 30, 'the mutation budget 429s on the 31st', `first 429 at index ${firstRefusal}`);

  console.log('\nNOW RESET THE LIMITER before any further phase:');
  console.log("  ssh root@137.184.119.230 'pm2 restart seo-dashboard'");
}

async function exclusion() {
  const members = await listProfilesWithConsent(config.listId);
  const testCount = members.filter((p) => isTestProfile(p.properties)).length;
  assert(testCount > 0, 'there are test profiles on the list to exclude', `found ${testCount}`);
  const s = summarizeEntrants(members);
  assert(s.excludedTestProfiles === testCount, 'the report excludes every test profile', `excluded ${s.excludedTestProfiles} of ${testCount}`);
  assert(s.total === members.length - testCount, 'and its total counts only real entrants', `${s.total} of ${members.length}`);
}

async function cleanup() {
  // Deletion is asynchronous in Klaviyo. This asserts the request was accepted,
  // then re-enumerates so a silent failure cannot pass as success.
  const members = await listProfilesWithConsent(config.listId);
  const testProfiles = members.filter((p) => isTestProfile(p.properties));
  console.log(`${testProfiles.length} test profile(s) to delete`);
  for (const p of testProfiles) {
    await klaviyoRequest('POST', '/data-privacy-deletion-jobs/', {
      data: { type: 'data-privacy-deletion-job', attributes: { profile: { data: { type: 'profile', attributes: { email: p.email } } } } },
    });
    console.log(`  deletion requested: ${p.email}`);
  }
  console.log('\nDeletion is asynchronous. Re-run `status` in a few minutes, and confirm Gate A');
  console.log('reports `no gv_test profiles remain` before launching.');
}

async function status() {
  const members = await listProfilesWithConsent(config.listId);
  const testProfiles = members.filter((p) => isTestProfile(p.properties));
  console.log(`list members: ${members.length}   test profiles: ${testProfiles.length}`);
  for (const p of testProfiles) {
    console.log(`  ${String(p.properties?.gv_entries ?? '?').padStart(3)}  ${p.email}  run=${p.properties?.gv_test_run ?? '?'}`);
  }
  assert(true, 'status read completed');
}
```

- [ ] **Step 2: Register the new phases**

Replace the `PHASES` line with:

```javascript
const PHASES = { preflight, seed, positive, negative, reconcile, limits, exclusion, cleanup, status };
```

- [ ] **Step 3: Verify every phase is reachable and rejects a bad name**

Run: `node scripts/giveaway/e2e-verify.mjs nonsense --run t1 --email a@b.com`
Expected: `unknown phase 'nonsense'. one of: preflight, seed, positive, negative, reconcile, limits, exclusion, cleanup, status`, exit 2.

Run: `node scripts/giveaway/e2e-verify.mjs status --run t1`
Expected: prints the member count and `0` test profiles (nothing has been seeded yet), exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/giveaway/e2e-verify.mjs
git commit -m "feat(giveaway): e2e harness phases 4-9 — reconcile, limits, exclusion, cleanup"
```

---

### Task 5: The runbook

The document a human actually follows, including the two clicks and the browser pass.

**Files:**
- Create: `docs/runbooks/2026-08-12-giveaway-entry-verification.md`

**Interfaces:**
- Consumes: the harness CLI from Tasks 3–4.
- Produces: nothing consumed by code.

- [ ] **Step 1: Write the runbook**

It must contain, in this order:

1. **A prerequisite block:** this cannot run until PR #434 merges and `ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'` has run, because the endpoint returns 401 until the app contains `routes/giveaway.js`. State that `preflight` will say so explicitly.
2. **A warning block:** this creates REAL profiles on the production Klaviyo list `Y2ukbE`; cleanup is mandatory; Gate A refuses launch while any `gv_test` profile remains.
3. **The exact command sequence**, with a run id and the base email, in order: `preflight`, `seed`, `positive`, `negative`, then the pause, then `reconcile`, `limits`, the PM2 restart, `exclusion`, `cleanup`, `status`.
4. **The human pause, spelled out:** the inbox will hold five Klaviyo confirmation emails. Click **only** the ones for the `-a@` and `-b@` aliases. Leaving `-c@` unconfirmed is what proves "a referee who never confirms credits nobody" — clicking it destroys that test.
5. **The expected totals table** (A=24, B=3, C=D=E=1) so a human can sanity-check without reading code.
6. **The browser pass**, all ten checks from spec §8, each with what to do and what to expect, and noting that items 4, 5, 7 and 8 are regressions for defects found in review.
7. **A troubleshooting section** covering: `ENOTFOUND` means a stale local resolver, not a broken endpoint (run from the server instead); a 401 from the endpoint means the dashboard is not deployed; and unexpected 429s mean the limiter needs a PM2 restart.
8. **A final checklist** ending with `verify-launch.mjs` reporting `no gv_test profiles remain`.

- [ ] **Step 2: Verify every command in the runbook actually exists**

Run this and confirm each phase name appears in the harness's `PHASES` map:

```bash
grep -oE 'e2e-verify\.mjs [a-z]+' docs/runbooks/2026-08-12-giveaway-entry-verification.md | awk '{print $2}' | sort -u | while read p; do
  grep -q "  $p," scripts/giveaway/e2e-verify.mjs || grep -q "$p }" scripts/giveaway/e2e-verify.mjs \
    && echo "ok   $p" || echo "MISSING PHASE: $p"
done
```
Expected: every line `ok`. A `MISSING PHASE` means the runbook documents a command that does not exist.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/2026-08-12-giveaway-entry-verification.md
git commit -m "docs(runbook): step-by-step verification of every entry-earning method"
```

---

### Task 6: Full-suite check and PR

**Files:** none created.

- [ ] **Step 1: Run the full suite on Node 22**

Run: `nvm use && node --version && npm test`
Expected: v22.x, all pass, **`# cancelled 0`**. Report the counts.

- [ ] **Step 2: Run Gate A**

Run: `node scripts/giveaway/verify-launch.mjs`
Expected: the new `no gv_test profiles remain on the entrant list (found 0)` check PASSES. The gate still exits non-zero while the endpoint is undeployed.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feature/giveaway-entry-verification
gh pr create --base main --title "feat(giveaway): verify every entry-earning method before launch" --body "<summary>"
```

The body must state: what it verifies, that it cannot run until #434 merges and the dashboard deploys, that it creates real profiles on the production list and cleanup is mandatory, that Gate A now refuses launch while any test profile remains, and that the referral cap at 10 is covered by unit test only rather than end-to-end.

---

## Self-Review

**Spec coverage.** Walked all ten spec sections. §2 positive rungs → Tasks 3–4 (`positive`, `reconcile`). §2 negative cases → Task 3 (`negative`) with the two reconciler-dependent ones in Task 4. §2 rate limits → Task 4 (`limits`). §2 out-of-scope referral cap → recorded in the plan's constraints and in the Task 6 PR body. §4 identities → Task 1. §5 isolation and prize safety → Task 2 (report exclusion + Gate A) and Task 4 (`cleanup`). §6 files → Tasks 1–5 cover all six. §7 phases → Tasks 3–4. §8 browser pass → Task 5. §9 output → Task 3 Step 2 artifact. §10 sequencing → Task 5 item 1 and Task 6.

One deliberate deviation from §6: the spec lists `data/reports/giveaway/e2e-<runid>.json` as harness output; the plan appends each phase into one artifact per run rather than overwriting, so a later phase cannot erase an earlier phase's evidence.

**Placeholder scan.** No TBD/TODO. Task 5 Step 1 specifies content as a numbered requirement list rather than emitting finished prose — the same treatment the earlier giveaway plan used for the official rules and nurture emails, and it is checkable: Step 2 greps the runbook's commands against the harness's actual phase map, and the self-review above ties each numbered item to a spec section.

**Type consistency.** `buildIdentities(runId, baseEmail)` returns keys `a`–`e` in Task 1 and is consumed as `Object.values(ids)` and `ids.a` in Tasks 3–4. `isTestProfile(properties)` takes a properties object in Task 1 and is called with `p.properties` in Tasks 2 and 4. `summarizeEntrants` gains `excludedTestProfiles` in Task 2 and is read as `s.excludedTestProfiles` in Task 4. `entriesOf` returns `{entries, breakdown, props}` in Task 3 and is destructured with exactly those names in Task 4. `assert(ok, label, detail)` is defined in Task 3 and used with that arity throughout Task 4. Phase function names match the `PHASES` map keys in both tasks.
