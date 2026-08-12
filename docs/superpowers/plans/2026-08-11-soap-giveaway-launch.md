# Soap Giveaway — Phase 1 (Launch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything required to turn Meta ads on for a 30-day fragrance-free soap giveaway that captures segmented, double-opted-in email entries with a weighted bonus-entry ladder.

**Architecture:** Pure logic lives in `lib/giveaway/*.js` (no I/O, fully unit-tested). Klaviyo list/profile access is a new `lib/klaviyo-profiles.js` that reuses the rate-limited `klaviyoRequest` from `lib/klaviyo.js`. The storefront has no server, so entry capture is a **public, unauthenticated route on the existing dashboard app**, modelled line-for-line on the RUM collector precedent (`agents/dashboard/routes/rum.js`) — including its body caps and disk discipline. Two Shopify pages are pushed as JSON templates plus Liquid sections to the live theme.

**Tech Stack:** Node 22 (ESM), `node:test` + `node:assert/strict`, Shopify Admin REST + GraphQL via `lib/shopify.js`, Klaviyo API revision `2025-07-15`, plain Liquid + vanilla JS on the storefront (no framework).

**Spec:** `docs/superpowers/specs/2026-08-11-soap-giveaway-meta-campaign-design.md`

**Out of scope — Phase 2 (`day 34+`):** the offer page, BXGY discount codes, the weighted draw, the draw-result campaign, and the day-90 sunset script. Those depend on the entrant count and bars available, neither known at launch. A separate plan covers them.

## Global Constraints

- **Node 22 LTS.** Run `nvm use` before any test. When reading `node --test` output, **check the cancelled count, not just `# fail 0`** — a cancelled test prints alongside `# fail 0` and reads like a pass.
- **Never work in the main checkout.** All work happens in the worktree `.claude/worktrees/soap-giveaway` on branch `feature/soap-giveaway-meta-campaign`. Re-check `git branch --show-current` before every commit.
- **Product is Pure Unscented only.** Variant ID **`45828179951786`**, hard-coded, never read from `defaultVariantId`. (The live product was reordered on 2026-08-11 so Unscented is position 1, but the hard-coded ID plus its assertion stay.)
- **Every duration claim routes through `assertDurationClaim()`** from `lib/supply-duration.js`. Bar soap is **25 days/unit** (range 20–30). "6 months free" is valid only at ≥9 free bars.
- **Entry counts are incremented server-side only.** Never trust a client-supplied entry total.
- **`breakdown.confirmed` is owned solely by the nightly reconciler** (Task 5), which reads the `SUBSCRIBED` set — the only authority on who actually clicked the double-opt-in link. No request handler may set it.
- **Idempotency by state comparison, not counters.** The reconciler compares stored state to desired state. Do not add a second field tracking the same fact.
- **Purchases never earn entries.** No code path may increment `gv_entries` from an order.
- **No scarcity copy.** A second production run is planned, so no "only N left" line ships anywhere.
- **Meta ad copy must never assert the viewer's health condition.** "Most 'unscented' soap isn't" is fine; "Does unscented soap make you itch?" is a policy rejection.
- **The entry endpoint must be a first-party same-site subdomain.** An ad-blocker-filtered host silently drops paid entries — the reason `rum.realskincare.com` exists.
- **All Klaviyo profile properties are prefixed `gv_`.**

### Data model — Klaviyo profile properties

| Property | Type | Values |
|---|---|---|
| `gv_entrant` | boolean | `true` |
| `gv_entries` | integer | server-computed total |
| `gv_breakdown` | object | `{confirmed, survey, referrals, instagram, upload}` |
| `gv_referred_by` | string | normalised email of the referrer |
| `gv_household` | string | `solo` \| `couple` \| `family` \| `gift` |
| `gv_frustration` | string | `dry` \| `reactive` \| `fragrance` \| `ingredients` |
| `gv_current_brand` | string | `cerave` \| `cetaphil` \| `dove` \| `natural_competitor` \| `natural_brand` \| `whatever` |
| `gv_switch_blocker` | string | `price` \| `didnt_work` \| `confused` \| `ingredients` \| `first_time` |
| `gv_also_buys` | array | `deodorant` \| `toothpaste` \| `lotion` \| `lipbalm` \| `hair` |
| `gv_unscented_reaction` | string | `multiple` \| `once` \| `no` \| `unsure` |
| `gv_ig_handle` | string | as supplied |
| `gv_upload_url` | string | Shopify CDN URL |

---

### Task 1: Entry-ladder core logic

Pure functions, no I/O. Every entry rule lives here so the endpoint, the reconciler, the report, and Phase 2's draw all agree.

**Files:**
- Create: `lib/giveaway/entries.js`
- Test: `tests/lib/giveaway-entries.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ENTRY_VALUES = { base: 1, confirm: 2, survey: 3, referral: 5, instagram: 3, upload: 10 }`
  - `REFERRAL_CAP = 10`
  - `normalizeEmail(raw) -> string` (lowercased, trimmed; throws `Error` on anything without a single `@` and a dot in the domain)
  - `entryTotal(breakdown) -> number` where `breakdown = { confirmed: boolean, survey: boolean, referrals: number, instagram: boolean, upload: boolean }`
  - `validateReferral({ referrerEmail, entrantEmail, referrerIsConfirmedEntrant, referrerReferralCredits }) -> { ok: boolean, reason: string | null }`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/giveaway-entries.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ENTRY_VALUES, REFERRAL_CAP, normalizeEmail, entryTotal, validateReferral,
} from '../../lib/giveaway/entries.js';

test('a bare entry is worth exactly one', () => {
  assert.equal(entryTotal({ confirmed: false, survey: false, referrals: 0, instagram: false, upload: false }), 1);
});

test('the maximum ladder is 69 entries', () => {
  const max = entryTotal({ confirmed: true, survey: true, referrals: REFERRAL_CAP, instagram: true, upload: true });
  assert.equal(max, 1 + 2 + 3 + 50 + 3 + 10);
  assert.equal(max, 69);
});

test('referrals are capped, so an 11th referral pays nothing', () => {
  const at = entryTotal({ confirmed: true, survey: true, referrals: 10, instagram: false, upload: false });
  const over = entryTotal({ confirmed: true, survey: true, referrals: 25, instagram: false, upload: false });
  assert.equal(at, over, 'past the cap the total must not move');
});

test('emails are normalised so referral matching cannot miss on case or whitespace', () => {
  assert.equal(normalizeEmail('  Sean@Example.COM '), 'sean@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), /invalid email/i);
  assert.throws(() => normalizeEmail('a@b'), /invalid email/i);
});

test('self-referral is rejected regardless of case', () => {
  const r = validateReferral({
    referrerEmail: 'Sean@Example.com',
    entrantEmail: 'sean@example.com',
    referrerIsConfirmedEntrant: true,
    referrerReferralCredits: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /self-referral/i);
});

test('an unconfirmed referrer earns nothing — a prize cannot go to someone who never accepted the rules', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsConfirmedEntrant: false,
    referrerReferralCredits: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a confirmed entrant/i);
});

test('a referrer already at the cap earns nothing more', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsConfirmedEntrant: true,
    referrerReferralCredits: REFERRAL_CAP,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cap/i);
});

test('a valid referral is accepted', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsConfirmedEntrant: true,
    referrerReferralCredits: 3,
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

test('a purchase cannot appear in the ladder — there is no purchase key', () => {
  assert.equal(Object.keys(ENTRY_VALUES).includes('purchase'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && node --test tests/lib/giveaway-entries.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/entries.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/giveaway/entries.js
/**
 * Entry-ladder rules for the 2026-09 soap giveaway.
 *
 * Single source of truth for what an action is worth. The public endpoint, the
 * nightly referral reconciler, the daily report and Phase 2's weighted draw all
 * read from here so they cannot disagree about a total.
 *
 * NOTE: there is deliberately no `purchase` rung. Awarding entries for buying
 * would make the promotion a lottery rather than a sweepstakes in most states,
 * which matters because a $99 offer follows the draw.
 */

export const ENTRY_VALUES = {
  base: 1,
  confirm: 2,
  survey: 3,
  referral: 5,
  instagram: 3,
  upload: 10,
};

export const REFERRAL_CAP = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`invalid email: ${JSON.stringify(raw)}`);
  return email;
}

export function entryTotal(breakdown = {}) {
  const {
    confirmed = false, survey = false, referrals = 0,
    instagram = false, upload = false,
  } = breakdown;
  const credited = Math.min(Math.max(0, Math.floor(referrals)), REFERRAL_CAP);
  return ENTRY_VALUES.base
    + (confirmed ? ENTRY_VALUES.confirm : 0)
    + (survey ? ENTRY_VALUES.survey : 0)
    + credited * ENTRY_VALUES.referral
    + (instagram ? ENTRY_VALUES.instagram : 0)
    + (upload ? ENTRY_VALUES.upload : 0);
}

export function validateReferral({
  referrerEmail, entrantEmail, referrerIsConfirmedEntrant, referrerReferralCredits = 0,
}) {
  let referrer;
  let entrant;
  try {
    referrer = normalizeEmail(referrerEmail);
    entrant = normalizeEmail(entrantEmail);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (referrer === entrant) return { ok: false, reason: 'self-referral is not eligible' };
  if (!referrerIsConfirmedEntrant) {
    return { ok: false, reason: 'referrer is not a confirmed entrant' };
  }
  if (referrerReferralCredits >= REFERRAL_CAP) {
    return { ok: false, reason: `referrer is at the ${REFERRAL_CAP}-referral cap` };
  }
  return { ok: true, reason: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/giveaway-entries.test.js`
Expected: PASS, 9 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/giveaway/entries.js tests/lib/giveaway-entries.test.js
git commit -m "feat(giveaway): entry-ladder rules with referral validation"
```

---

### Task 2: Duration-guarded offer copy

The offer's duration claim is the thing this project has already got wrong twice. This task makes an overstated claim a thrown error rather than a copy review.

**Files:**
- Create: `lib/giveaway/copy.js`
- Test: `tests/lib/giveaway-copy.test.js`

**Interfaces:**
- Consumes: `assertDurationClaim` from `lib/supply-duration.js`.
- Produces:
  - `TIERS = { floor: { key:'floor', price:66, paidBars:6, freeBars:6, claimDays:120 }, hero: { key:'hero', price:99, paidBars:9, freeBars:9, claimDays:180 } }`
  - `SOAP_VARIANT_ID = '45828179951786'`
  - `offerCopy(tierKey, household) -> { price, barsTotal, barsFree, valueUsd, durationClaim, headline, cartPermalink }`
    `durationClaim` is `null` for `household === 'family'`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/giveaway-copy.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TIERS, SOAP_VARIANT_ID, offerCopy } from '../../lib/giveaway/copy.js';

test('the hero tier may claim six months free, because nine bars supports it', () => {
  const c = offerCopy('hero', 'solo');
  assert.equal(c.price, 99);
  assert.equal(c.barsTotal, 18);
  assert.equal(c.barsFree, 9);
  assert.match(c.durationClaim, /6 months/);
});

test('the floor tier claims four months, not six', () => {
  const c = offerCopy('floor', 'solo');
  assert.equal(c.barsTotal, 12);
  assert.match(c.durationClaim, /4 months/);
  assert.doesNotMatch(c.durationClaim, /6 months/);
});

test('a family household gets NO duration claim, because a shared bar does not last 25 days', () => {
  const c = offerCopy('hero', 'family');
  assert.equal(c.durationClaim, null);
  assert.match(c.headline, /every shower/i);
});

test('REGRESSION: six free bars can never claim six months', () => {
  // This is the exact framing proposed on 2026-08-11 and rejected: 6 free bars
  // is 120-150 days, not 180. If someone widens the floor tier's claim to match
  // the hero's, the guardrail must stop it before it reaches a page.
  assert.throws(
    () => offerCopy('floor', 'solo', { claimDaysOverride: 180 }),
    /claims 180 days/,
  );
});

test('the cart permalink is Pure Unscented and carries the full bar count', () => {
  // BXGY discounts do not ADD free items -- all 18 bars must be in the cart for
  // the discount to zero 9 of them. And the default variant is Calming
  // Lavender, so a permalink built from the default ships the wrong soap.
  const c = offerCopy('hero', 'solo');
  assert.equal(SOAP_VARIANT_ID, '45828179951786');
  assert.equal(c.cartPermalink, '/cart/45828179951786:18?discount=SOAP6MO');
});

test('an unknown tier is a programming error, not a silent default', () => {
  assert.throws(() => offerCopy('mega', 'solo'), /unknown tier/i);
});

test('both tiers price the free half at the bar count they actually give away', () => {
  assert.equal(TIERS.floor.freeBars, TIERS.floor.paidBars);
  assert.equal(TIERS.hero.freeBars, TIERS.hero.paidBars);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/giveaway-copy.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/copy.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/giveaway/copy.js
/**
 * Offer copy for the consolation BOGO, with every duration claim asserted
 * against measured consumption before it can be rendered.
 *
 * Bar soap is 25 days/unit (config/consumption-rates.json, merchant estimate,
 * range 20-30). So 9 free bars supports a 6-month claim and 6 free bars does
 * not. "Buy 6 get 6 = 6 months free" was proposed and rejected on 2026-08-11;
 * the regression test for it lives in tests/lib/giveaway-copy.test.js.
 *
 * A shared bar does not last 25 days, so households of 3+ get a quantity frame
 * with no duration claim at all rather than a claim we cannot support.
 */
import { assertDurationClaim } from '../supply-duration.js';

export const SOAP_VARIANT_ID = '45828179951786'; // Pure Unscented. NOT defaultVariantId.
export const SOAP_HANDLE = 'coconut-soap';
export const UNIT_PRICE = 11;

export const TIERS = {
  floor: { key: 'floor', price: 66, paidBars: 6, freeBars: 6, claimDays: 120, code: 'SOAP4MO' },
  hero: { key: 'hero', price: 99, paidBars: 9, freeBars: 9, claimDays: 180, code: 'SOAP6MO' },
};

const MONTHS = (days) => Math.round(days / 30);

export function offerCopy(tierKey, household, { claimDaysOverride = null } = {}) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`unknown tier: ${tierKey}`);

  const barsTotal = tier.paidBars + tier.freeBars;
  const claimDays = claimDaysOverride ?? tier.claimDays;
  const noClaim = household === 'family';

  let durationClaim = null;
  if (!noClaim) {
    // Throws if the free half cannot actually cover the claim.
    assertDurationClaim(
      claimDays,
      [{ product: SOAP_HANDLE, qty: tier.freeBars }],
      `${tier.freeBars} free bars`,
    );
    durationClaim = `${MONTHS(claimDays)} months free`;
  }

  const headline = noClaim
    ? `${barsTotal} bars — a bar in every shower, restocked`
    : `${barsTotal} bars — ${durationClaim}`;

  return {
    price: tier.price,
    barsTotal,
    barsFree: tier.freeBars,
    valueUsd: barsTotal * UNIT_PRICE,
    durationClaim,
    headline,
    cartPermalink: `/cart/${SOAP_VARIANT_ID}:${barsTotal}?discount=${tier.code}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/giveaway-copy.test.js`
Expected: PASS, 7 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/giveaway/copy.js tests/lib/giveaway-copy.test.js
git commit -m "feat(giveaway): duration-guarded offer copy, rejecting 6-months-on-6-bars"
```

---

### Task 3: Klaviyo list and profile access

`lib/klaviyo.js` covers templates and flows only. Lists and profiles are a different concern, so they get their own module that reuses the rate-limited request helper rather than growing that file.

**Files:**
- Create: `lib/klaviyo-profiles.js`
- Create: `scripts/giveaway/setup-list.mjs`
- Test: `tests/lib/klaviyo-profiles.test.js`

**Interfaces:**
- Consumes: `klaviyoRequest` from `lib/klaviyo.js`; `normalizeEmail` from `lib/giveaway/entries.js`.
- Produces:
  - `createList(name) -> { id, name }`
  - `findListByName(name) -> { id, name } | null`
  - `subscribeToList(listId, { email, firstName, properties }) -> { ok: true }`
  - `updateProfileProperties(email, properties) -> { id }`
  - `getProfileByEmail(email) -> { id, email, properties, ... } | null`
  - `listSubscribedProfiles(listId) -> Array<{ id, email, properties }>` (only profiles whose email consent is `SUBSCRIBED` — i.e. double-opt-in confirmed)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/klaviyo-profiles.test.js
// Klaviyo is stubbed at the fetch boundary. These tests assert the request
// SHAPES we send, because a wrong pointer or a missing relationship block is
// the failure mode that costs an afternoon against a live API.
import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';

const realFetch = globalThis.fetch;
let calls = [];

function stubFetch(responder) {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method, body });
    const { status = 200, json = {} } = responder({ url: String(url), method: opts.method, body }) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(),
      text: async () => JSON.stringify(json),
    };
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test('subscribeToList sends a subscription job with the profile inline and consent requested', async () => {
  stubFetch(() => ({ status: 202, json: {} }));
  const { subscribeToList } = await import('../../lib/klaviyo-profiles.js');

  await subscribeToList('ABC123', {
    email: '  Sean@Example.COM ',
    firstName: 'Sean',
    properties: { gv_entrant: true, gv_entries: 1 },
  });

  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.match(url, /profile-subscription-bulk-create-jobs/);
  const profile = body.data.attributes.profiles.data[0];
  assert.equal(profile.attributes.email, 'sean@example.com', 'email must be normalised before it reaches Klaviyo');
  assert.equal(profile.attributes.properties.gv_entrant, true);
  assert.equal(
    profile.attributes.subscriptions.email.marketing.consent,
    'SUBSCRIBED',
    'consent must be requested so the list double-opt-in flow fires',
  );
  assert.equal(body.data.relationships.list.data.id, 'ABC123');
});

test('listSubscribedProfiles excludes unconfirmed profiles and follows pagination', async () => {
  // Membership of the SUBSCRIBED set is what later tasks treat as proof of a
  // double-opt-in click, so an UNCONFIRMED profile leaking through would credit
  // bonus entries nobody earned.
  const sub = (consent) => ({ email: { marketing: { consent } } });
  let page = 0;
  stubFetch(() => {
    page += 1;
    return page === 1
      ? { json: {
          data: [
            { id: 'p1', attributes: { email: 'confirmed@b.com', properties: { gv_entries: 3 }, subscriptions: sub('SUBSCRIBED') } },
            { id: 'p2', attributes: { email: 'pending@b.com', properties: {}, subscriptions: sub('UNCONFIRMED') } },
          ],
          links: { next: 'https://a.klaviyo.com/api/next-page' },
        } }
      : { json: {
          data: [{ id: 'p3', attributes: { email: 'page2@b.com', properties: {}, subscriptions: sub('SUBSCRIBED') } }],
          links: {},
        } };
  });
  const { listSubscribedProfiles } = await import('../../lib/klaviyo-profiles.js');

  const out = await listSubscribedProfiles('ABC123');
  assert.deepEqual(
    out.map((p) => p.email),
    ['confirmed@b.com', 'page2@b.com'],
    'UNCONFIRMED must be dropped and page 2 must be included',
  );
  assert.match(decodeURIComponent(calls[0].url), /additional-fields\[profile\]=subscriptions/);
  // Verified live 2026-08-11: this endpoint 400s on a consent filter.
  assert.doesNotMatch(calls[0].url, /filter=/, 'must not send a filter this endpoint rejects');
});

test('findListByName tolerates case and whitespace so it cannot create a duplicate list', async () => {
  stubFetch(() => ({ json: { data: [{ id: 'L1', attributes: { name: 'Giveaway 2026-09 — Entrants' } }], links: {} } }));
  const { findListByName } = await import('../../lib/klaviyo-profiles.js');
  const hit = await findListByName('  giveaway 2026-09 — entrants ');
  assert.equal(hit?.id, 'L1');
});

test('updateProfileProperties PATCHes by id after resolving the email', async () => {
  stubFetch(({ method }) => (method === 'GET'
    ? { json: { data: [{ id: 'PROF1', attributes: { email: 'a@b.com', properties: {} } }] } }
    : { json: { data: { id: 'PROF1' } } }));
  const { updateProfileProperties } = await import('../../lib/klaviyo-profiles.js');

  const r = await updateProfileProperties('A@B.com', { gv_entries: 8 });
  assert.equal(r.id, 'PROF1');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /\/profiles\/PROF1\//);
  assert.equal(patch.body.data.id, 'PROF1', 'a PATCH without data.id is rejected by Klaviyo');
  assert.equal(patch.body.data.attributes.properties.gv_entries, 8);
});

test('getProfileByEmail returns null rather than throwing when nobody matches', async () => {
  stubFetch(() => ({ json: { data: [] } }));
  const { getProfileByEmail } = await import('../../lib/klaviyo-profiles.js');
  assert.equal(await getProfileByEmail('nobody@example.com'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/klaviyo-profiles.test.js`
Expected: FAIL — `Cannot find module '.../lib/klaviyo-profiles.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/klaviyo-profiles.js
/**
 * Klaviyo lists and profiles.
 *
 * Separate from lib/klaviyo.js, which owns templates and flows. Reuses that
 * module's klaviyoRequest so 429 backoff and error formatting stay in one place.
 *
 * IMPORTANT: double opt-in is a LIST SETTING, not an API field. Creating a list
 * here does not make it double opt-in — that is a one-time manual step in the
 * Klaviyo UI (List Settings -> Opt-in Process -> Double opt-in). Until it is
 * flipped, subscribeToList marks profiles SUBSCRIBED immediately and the +2
 * confirmation rung becomes meaningless. scripts/giveaway/verify-launch.mjs
 * prints a reminder; it cannot assert the setting, which the API does not expose.
 */
import { klaviyoRequest } from './klaviyo.js';
import { normalizeEmail } from './giveaway/entries.js';

// Compared trimmed and case-folded so a stray space, a case change, or an
// em-dash/hyphen edit to the list name does not silently create a duplicate
// list instead of reusing the existing one.
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export async function findListByName(name) {
  let url = '/lists/?fields%5Blist%5D=name';
  while (url) {
    const d = await klaviyoRequest('GET', url);
    const hit = (d.data || []).find((l) => sameName(l.attributes?.name, name));
    if (hit) return { id: hit.id, name: hit.attributes.name };
    url = d.links?.next || null;
  }
  return null;
}

export async function createList(name) {
  const d = await klaviyoRequest('POST', '/lists/', {
    data: { type: 'list', attributes: { name } },
  });
  return { id: d.data.id, name: d.data.attributes.name };
}

export async function subscribeToList(listId, { email, firstName = null, properties = {} }) {
  const normalized = normalizeEmail(email);
  const attributes = { email: normalized, properties };
  if (firstName) attributes.first_name = firstName;
  attributes.subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };

  await klaviyoRequest('POST', '/profile-subscription-bulk-create-jobs/', {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: 'Soap Giveaway 2026-09',
        profiles: { data: [{ type: 'profile', attributes }] },
      },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  });
  return { ok: true };
}

export async function getProfileByEmail(email) {
  const normalized = normalizeEmail(email);
  const filter = encodeURIComponent(`equals(email,"${normalized}")`);
  const d = await klaviyoRequest('GET', `/profiles/?filter=${filter}`);
  const p = (d.data || [])[0];
  if (!p) return null;
  return { id: p.id, email: p.attributes.email, properties: p.attributes.properties || {} };
}

export async function updateProfileProperties(email, properties) {
  const profile = await getProfileByEmail(email);
  if (!profile) throw new Error(`no Klaviyo profile for ${email}`);
  await klaviyoRequest('PATCH', `/profiles/${profile.id}/`, {
    data: { type: 'profile', id: profile.id, attributes: { properties } },
  });
  return { id: profile.id };
}

export async function listSubscribedProfiles(listId) {
  // The list-profiles endpoint does NOT support filtering on
  // subscriptions.email.marketing.consent. Verified live 2026-08-11:
  //   400: "'subscriptions.email.marketing.consent' is not a filterable field
  //   for this resource. The filterable fields on this resource are: _kx,
  //   email, joined_group_at, phone_number, push_token"
  // So request the subscriptions block and filter client-side. Membership of
  // the SUBSCRIBED set is what later tasks treat as double-opt-in confirmation,
  // so this filter must not be dropped.
  let url = `/lists/${listId}/profiles/?additional-fields%5Bprofile%5D=subscriptions&page%5Bsize%5D=100`;
  const out = [];
  while (url) {
    const d = await klaviyoRequest('GET', url);
    for (const p of d.data || []) {
      if (p.attributes?.subscriptions?.email?.marketing?.consent !== 'SUBSCRIBED') continue;
      out.push({ id: p.id, email: p.attributes.email, properties: p.attributes.properties || {} });
    }
    url = d.links?.next || null;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/klaviyo-profiles.test.js`
Expected: PASS, 5 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Write the list setup script**

```javascript
// scripts/giveaway/setup-list.mjs
/**
 * Create (idempotently) the giveaway entrant list and record its id.
 *
 * Run once:  node scripts/giveaway/setup-list.mjs
 *
 * AFTER RUNNING, one manual step is required and cannot be automated:
 * Klaviyo UI -> Lists -> "Giveaway 2026-09 - Entrants" -> Settings ->
 * Opt-in Process -> DOUBLE OPT-IN. The API does not expose this field. Without
 * it there is no confirmation click, the +2 rung is meaningless, and the
 * deliverability protection that the existing 481 subscribers depend on is gone.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findListByName, createList } from '../../lib/klaviyo-profiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_NAME = 'Giveaway 2026-09 — Entrants';
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');

const existing = await findListByName(LIST_NAME);
const list = existing || (await createList(LIST_NAME));
console.log(existing ? `Reusing list ${list.id}` : `Created list ${list.id}`);

const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
config.listId = list.id;
config.listName = LIST_NAME;
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote listId to ${CONFIG_PATH}`);
console.log('\n>>> MANUAL STEP: set this list to DOUBLE OPT-IN in the Klaviyo UI. <<<');
```

- [ ] **Step 6: Run it and confirm idempotency**

Run: `node scripts/giveaway/setup-list.mjs && node scripts/giveaway/setup-list.mjs`
Expected: first run prints `Created list <id>`, second prints `Reusing list <id>` with the same id. `config/giveaway.json` contains `listId`.

- [ ] **Step 7: Commit**

```bash
git add lib/klaviyo-profiles.js tests/lib/klaviyo-profiles.test.js scripts/giveaway/setup-list.mjs config/giveaway.json
git commit -m "feat(giveaway): Klaviyo list/profile access + idempotent list setup"
```

---

### Task 4: Public entry endpoint

The storefront has no server, and entry totals must never be client-supplied. This is a public unauthenticated route on the dashboard app, following `agents/dashboard/routes/rum.js` — the existing precedent for a storefront-reachable endpoint, including its body caps and disk discipline (this box's 24 GB disk has already taken down every cron job once by filling up).

**Files:**
- Create: `agents/dashboard/routes/giveaway.js`
- Modify: `agents/dashboard/index.js` (import the routes; add the path to the pre-auth allowlist beside `/api/rum`)
- Test: `tests/dashboard/giveaway-routes.test.js`

**Interfaces:**
- Consumes: `ENTRY_VALUES`, `normalizeEmail`, `entryTotal` from `lib/giveaway/entries.js`; `subscribeToList`, `getProfileByEmail`, `updateProfileProperties` from `lib/klaviyo-profiles.js`; `config/giveaway.json` for `listId`.
- Produces:
  - `POST /api/giveaway/enter` — body `{ email, firstName, referredBy? }` → `201 { ok: true, entries: 1 }`
  - `POST /api/giveaway/answers` — body `{ email, household, frustration, currentBrand, ... }` → `200 { ok: true, entries }`
  - `GET /api/giveaway/entries?email=` → `200 { entries, breakdown }`
  - Exported helper `computeAndPersistEntries(email, patch) -> { entries, breakdown }` used by Task 5's reconciler.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/dashboard/giveaway-routes.test.js
// The endpoint is public and paid-for: every dropped entry is ~$2.50 of ad
// spend. These tests pin the validation and the server-authority rule.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateEntryPayload, mergeBreakdown, answerProperties } from '../../agents/dashboard/routes/giveaway.js';

test('a client-supplied entry total is ignored — the server is the only authority', () => {
  const merged = mergeBreakdown(
    { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    { survey: true, gv_entries: 9999, referrals: 500 },
  );
  assert.equal(merged.survey, true);
  assert.equal(merged.referrals, 0, 'referrals are credited only by the reconciler, never by a request');
  assert.equal(merged.gv_entries, undefined, 'a client entry total must not survive the merge');
});

test('a missing or malformed email is a 400, not a silent drop', () => {
  assert.equal(validateEntryPayload({ email: 'a@b.com', firstName: 'A' }).ok, true);
  assert.equal(validateEntryPayload({ email: 'nope', firstName: 'A' }).ok, false);
  assert.equal(validateEntryPayload({ firstName: 'A' }).ok, false);
});

test('firstName is required, because every nurture email personalises on it', () => {
  const r = validateEntryPayload({ email: 'a@b.com' });
  assert.equal(r.ok, false);
  assert.match(r.error, /firstName/);
});

test('a self-referral in the entry payload is stripped rather than rejecting the entry', () => {
  // Losing a paid entry over a bad referral field would be the expensive
  // failure. Keep the entry, drop the referral.
  const r = validateEntryPayload({ email: 'a@b.com', firstName: 'A', referredBy: 'A@B.com' });
  assert.equal(r.ok, true);
  assert.equal(r.value.referredBy, null);
});

test('answer values outside the allowed enum are dropped, not stored', () => {
  const props = answerProperties({ household: 'martian', frustration: 'reactive' });
  assert.equal(props.gv_household, undefined, 'an unknown enum value must not reach the profile');
  assert.equal(props.gv_frustration, 'reactive');
});

test('survey answers are top-level gv_* properties, NOT keys inside the breakdown', () => {
  // A Klaviyo flow filter and a Klaviyo segment can only read a TOP-LEVEL
  // property. The nurture flow branches on gv_frustration and the daily report
  // reads gv_household / gv_frustration / gv_current_brand. Storing these inside
  // gv_breakdown made every one of those reads return empty forever, while the
  // unit tests on both sides still passed — this test pins the contract.
  const patch = { household: 'family', frustration: 'fragrance', currentBrand: 'cerave', survey: true };
  const props = answerProperties(patch);
  assert.deepEqual(props, {
    gv_household: 'family',
    gv_frustration: 'fragrance',
    gv_current_brand: 'cerave',
  });
  const breakdown = mergeBreakdown(
    { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    patch,
  );
  assert.equal(breakdown.survey, true, 'the ladder rung still lands in the breakdown');
  for (const k of ['household', 'frustration', 'currentBrand', 'gv_household', 'gv_frustration']) {
    assert.equal(breakdown[k], undefined, `${k} must not be in the breakdown`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dashboard/giveaway-routes.test.js`
Expected: FAIL — `Cannot find module '.../agents/dashboard/routes/giveaway.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// agents/dashboard/routes/giveaway.js
/**
 * Public giveaway entry collector.
 *
 * POST /api/giveaway/enter    — create the entry (the Meta `Lead` conversion)
 * POST /api/giveaway/answers  — store survey answers, credit the +3 rung
 * GET  /api/giveaway/entries  — read a profile's current entry total
 *
 * PUBLIC and unauthenticated, exactly like /api/rum, because storefront
 * browsers cannot send dashboard basic-auth and those credentials must never
 * appear in theme JS. Bodies are capped and every field is enum-validated.
 *
 * Entry totals are computed SERVER-SIDE ONLY. A client may say which action it
 * performed; it may never say what that action is worth. Referral credits come
 * only from scripts/giveaway/reconcile-referrals.mjs, after the referred friend
 * confirms — never from a request.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.js';
import { entryTotal, normalizeEmail } from '../../../lib/giveaway/entries.js';
import {
  subscribeToList, getProfileByEmail, updateProfileProperties,
} from '../../../lib/klaviyo-profiles.js';

const MAX_BODY_BYTES = 4 * 1024;

const ALLOWED_ORIGINS = new Set([
  'https://www.realskincare.com',
  'https://realskincare.com',
]);

const ENUMS = {
  household: new Set(['solo', 'couple', 'family', 'gift']),
  frustration: new Set(['dry', 'reactive', 'fragrance', 'ingredients']),
  currentBrand: new Set(['cerave', 'cetaphil', 'dove', 'natural_competitor', 'natural_brand', 'whatever']),
  switchBlocker: new Set(['price', 'didnt_work', 'confused', 'ingredients', 'first_time']),
  unscentedReaction: new Set(['multiple', 'once', 'no', 'unsure']),
};
const ALSO_BUYS = new Set(['deodorant', 'toothpaste', 'lotion', 'lipbalm', 'hair']);

const listId = () => JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8')).listId;

export function validateEntryPayload(body = {}) {
  let email;
  try {
    email = normalizeEmail(body.email);
  } catch {
    return { ok: false, error: 'a valid email is required' };
  }
  const firstName = String(body.firstName ?? '').trim();
  if (!firstName) return { ok: false, error: 'firstName is required' };

  let referredBy = null;
  if (body.referredBy) {
    try {
      const r = normalizeEmail(body.referredBy);
      // Self-referral: drop the referral, keep the entry. Losing a paid entry
      // over a bad optional field is the more expensive mistake.
      referredBy = r === email ? null : r;
    } catch { referredBy = null; }
  }
  return { ok: true, value: { email, firstName: firstName.slice(0, 80), referredBy } };
}

/**
 * Merge a client-declared patch into the entry-ladder breakdown.
 *
 * The breakdown holds LADDER STATE ONLY — the booleans and counts that
 * entryTotal() prices. Survey answers are deliberately NOT stored here: they go
 * out as top-level gv_* profile properties instead (see answerProperties below),
 * because a Klaviyo flow filter and a Klaviyo segment both need a top-level
 * property. The nurture flow branches on gv_frustration, and the daily report
 * reads gv_household / gv_frustration / gv_current_brand. Neither can see a key
 * buried inside a JSON-object property.
 */
export function mergeBreakdown(current, patch = {}) {
  const out = { ...current };
  if (patch.survey === true) out.survey = true;
  if (patch.instagram === true) out.instagram = true;
  if (patch.upload === true) out.upload = true;
  // referrals and confirmed are owned by the nightly reconciler; a client-supplied
  // total is never honoured.
  delete out.gv_entries;
  return out;
}

/** Enum answer name -> the top-level Klaviyo property it is stored as. */
const ANSWER_PROPERTY = {
  household: 'gv_household',
  frustration: 'gv_frustration',
  currentBrand: 'gv_current_brand',
  switchBlocker: 'gv_switch_blocker',
  unscentedReaction: 'gv_unscented_reaction',
};

/** Extract validated survey answers as top-level gv_* properties. Unknown enum values are dropped. */
export function answerProperties(patch = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (patch[key] !== undefined && allowed.has(patch[key])) out[ANSWER_PROPERTY[key]] = patch[key];
  }
  if (Array.isArray(patch.alsoBuys)) {
    const clean = patch.alsoBuys.filter((v) => ALSO_BUYS.has(v));
    if (clean.length) out.gv_also_buys = clean;
  }
  if (typeof patch.igHandle === 'string' && patch.igHandle.trim()) {
    out.gv_ig_handle = patch.igHandle.trim().replace(/^@/, '').slice(0, 40);
  }
  return out;
}

export async function computeAndPersistEntries(email, patch = {}) {
  const profile = await getProfileByEmail(email);
  const current = profile?.properties?.gv_breakdown
    ?? { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
  const breakdown = mergeBreakdown(current, patch);
  const entries = entryTotal(breakdown);
  await updateProfileProperties(email, {
    gv_breakdown: breakdown,
    gv_entries: entries,
    ...answerProperties(patch),
  });
  return { entries, breakdown };
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.realskincare.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function readCappedBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res, req, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
};

// Route objects are matched by `dispatch()` in agents/dashboard/lib/router.js,
// which reads `route.match` — NOT `route.path`. And when `match` is a string it
// compares against the full `req.url`, query string included, so an exact-string
// match breaks any route that takes query params. Both reasons to use a function
// that strips the query, exactly as routes/rum.js does.
export default [
  {
    method: 'OPTIONS',
    match: (url) => url.split('?')[0].startsWith('/api/giveaway/'),
    handler: (req, res) => { res.writeHead(204, corsHeaders(req)); res.end(); },
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/enter',
    handler: async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }

      const v = validateEntryPayload(parsed);
      if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

      const { email, firstName, referredBy } = v.value;
      try {
        // A resubmit must never reset earned progress. Klaviyo replaces the
        // value at a top-level property key rather than deep-merging it, so
        // writing the zeroed gv_breakdown again would wipe a confirmed,
        // surveyed, referred entrant back to a single entry. Double-submits and
        // back-button resubmissions are routine on a cold lander.
        const existing = await getProfileByEmail(email);
        const first = !existing?.properties?.gv_breakdown;

        const properties = { gv_entrant: true };
        if (first) {
          // confirmed starts false and is owned solely by the nightly
          // reconciler, which reads the SUBSCRIBED set — the only authority on
          // who actually clicked the double-opt-in link. No request may set it.
          properties.gv_breakdown = { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
          properties.gv_entries = 1;
        }
        // First referrer wins. Without this guard, re-entering lets someone
        // swap in a different referrer after the fact.
        if (referredBy && !existing?.properties?.gv_referred_by) {
          properties.gv_referred_by = referredBy;
        }

        await subscribeToList(listId(), { email, firstName, properties });
        return json(res, req, 201, { ok: true, entries: existing?.properties?.gv_entries ?? 1 });
      } catch (e) {
        console.error('[giveaway] enter failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not record entry' });
      }
    },
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/answers',
    handler: async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }
      let email;
      try { email = normalizeEmail(parsed.email); }
      catch { return json(res, req, 400, { ok: false, error: 'a valid email is required' }); }

      try {
        const out = await computeAndPersistEntries(email, { ...parsed, survey: true });
        return json(res, req, 200, { ok: true, ...out });
      } catch (e) {
        console.error('[giveaway] answers failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not save answers' });
      }
    },
  },
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/giveaway/entries',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let email;
      try { email = normalizeEmail(url.searchParams.get('email')); }
      catch { return json(res, req, 400, { ok: false, error: 'a valid email is required' }); }
      // MUST be wrapped. dispatch() in agents/dashboard/lib/router.js calls the
      // handler without awaiting it, and this codebase installs no
      // unhandledRejection hook — so an un-caught throw here terminates the
      // whole PM2 process under Node 22's defaults, taking every other
      // dashboard function down with it. This route is public and
      // unauthenticated, and klaviyoRequest throws on any non-2xx, so a routine
      // Klaviyo 5xx or rate-limit would be enough to do it.
      try {
        const profile = await getProfileByEmail(email);
        if (!profile) return json(res, req, 404, { ok: false, error: 'not found' });
        return json(res, req, 200, {
          ok: true,
          entries: profile.properties.gv_entries ?? 1,
          breakdown: profile.properties.gv_breakdown ?? {},
        });
      } catch (e) {
        console.error('[giveaway] entries lookup failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not read entries' });
      }
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dashboard/giveaway-routes.test.js`
Expected: PASS, 5 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Wire the routes into the server, pre-auth**

In `agents/dashboard/index.js`, add the import beside the others (~line 47):

```javascript
import giveawayRoutes from './routes/giveaway.js';
```

Add `...giveawayRoutes` to the `ROUTES` array wherever the other route modules are spread, then extend the pre-auth allowlist. Replace:

```javascript
  if (urlPath === '/api/rum') {
    if (dispatch(ROUTES, req, res, ctx)) return;
  }
```

with:

```javascript
  // Storefront-reachable routes. Browsers on realskincare.com cannot send
  // dashboard basic-auth, and those credentials must never appear in theme JS.
  // Abuse is bounded inside each route module: capped bodies, strict enum
  // validation, and no unbounded writes.
  if (urlPath === '/api/rum' || urlPath.startsWith('/api/giveaway/')) {
    if (dispatch(ROUTES, req, res, ctx)) return;
  }
```

- [ ] **Step 6: Verify the route answers without credentials**

Run:
```bash
node agents/dashboard/index.js &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4242/api/giveaway/enter \
  -H 'Content-Type: application/json' -d '{"email":"bad"}'
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:4242/api/giveaway/entries?email=bad'
kill %1
```
Expected: `400` then `400` — reached the handler, not `401`. A `401` means the allowlist edit did not take.

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/routes/giveaway.js agents/dashboard/index.js tests/dashboard/giveaway-routes.test.js
git commit -m "feat(giveaway): public entry endpoint with server-authoritative entry counts"
```

---

### Task 5: Nightly reconciliation — confirmation and referral rungs

This task owns the two rungs that no request can credit, because both depend on facts only Klaviyo knows.

**The `confirmed` rung (+2).** Nothing in a request can know whether someone clicked the double-opt-in link. `listSubscribedProfiles` filters to `SUBSCRIBED` consent, so **every profile it returns is confirmed by definition** — that set is the only authority. The reconciler is therefore the sole writer of `breakdown.confirmed`.

**The `referral` rung (+5).** Lands on the **referrer's** profile only once the friend they referred confirms. Asynchronous, so it reconciles nightly rather than via a hosted webhook; a 24-hour credit delay is acceptable.

Idempotency comes from comparing stored state to desired state — there is deliberately no separate credit counter, because two fields tracking one number is two things to get out of sync.

**Files:**
- Create: `scripts/giveaway/reconcile-referrals.mjs`
- Create: `lib/giveaway/reconcile.js`
- Test: `tests/lib/giveaway-reconcile.test.js`

**Interfaces:**
- Consumes: `validateReferral`, `REFERRAL_CAP`, `normalizeEmail`, `entryTotal` from `lib/giveaway/entries.js`; `listSubscribedProfiles`, `updateProfileProperties` from `lib/klaviyo-profiles.js`.
- Produces: `planEntryUpdates(confirmedProfiles) -> Array<{ email, entries, breakdown }>` — pure, so every rule is testable without Klaviyo. Returns one row per profile whose stored breakdown disagrees with reality, and nothing for profiles already correct.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/giveaway-reconcile.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planEntryUpdates } from '../../lib/giveaway/reconcile.js';
import { REFERRAL_CAP } from '../../lib/giveaway/entries.js';

// Every profile passed to planEntryUpdates came from listSubscribedProfiles, so
// it is double-opt-in confirmed. The fixtures below therefore represent the
// state AS STORED, which starts with confirmed:false straight from entry.
const profile = (email, props = {}) => ({
  id: `id-${email}`,
  email,
  properties: {
    gv_entrant: true,
    gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    ...props,
  },
});
const forEmail = (updates, email) => updates.find((u) => u.email === email);

test('REGRESSION: confirmation is credited — being in the SUBSCRIBED set IS the confirmation', () => {
  // Nothing in a request can know someone clicked the opt-in link, so if this
  // function does not credit it, the advertised +2 rung never pays and the
  // ladder shown on the entered page is a lie.
  const updates = planEntryUpdates([profile('a@x.com')]);
  const u = forEmail(updates, 'a@x.com');
  assert.ok(u, 'a profile stored as unconfirmed must produce an update');
  assert.equal(u.breakdown.confirmed, true);
  assert.equal(u.entries, 3, 'base 1 + confirm 2');
});

test('a confirmed entrant credits the referrer they named', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_referred_by: 'referrer@x.com' }),
  ]);
  const r = forEmail(updates, 'referrer@x.com');
  assert.equal(r.breakdown.referrals, 1);
  assert.equal(r.entries, 8, 'base 1 + confirm 2 + one referral 5');
});

test('a referrer who is not a confirmed entrant is never credited', () => {
  const updates = planEntryUpdates([profile('friend@x.com', { gv_referred_by: 'ghost@x.com' })]);
  assert.equal(forEmail(updates, 'ghost@x.com'), undefined, 'ghost is not in the confirmed set');
  assert.equal(forEmail(updates, 'friend@x.com').breakdown.referrals, 0);
});

test('self-referral credits nobody', () => {
  const updates = planEntryUpdates([profile('solo@x.com', { gv_referred_by: 'solo@x.com' })]);
  assert.equal(forEmail(updates, 'solo@x.com').breakdown.referrals, 0);
});

test('credits stop at the cap even with more confirmed referees', () => {
  const referees = Array.from({ length: 14 }, (_, i) => profile(`f${i}@x.com`, { gv_referred_by: 'r@x.com' }));
  const updates = planEntryUpdates([profile('r@x.com'), ...referees]);
  const r = forEmail(updates, 'r@x.com');
  assert.equal(r.breakdown.referrals, REFERRAL_CAP, 'capped');
  assert.equal(r.entries, 1 + 2 + 50);
});

test('the run is idempotent — a profile already in its final state produces no update', () => {
  const updates = planEntryUpdates([
    profile('r@x.com', { gv_breakdown: { confirmed: true, survey: false, referrals: 1, instagram: false, upload: false } }),
    profile('f1@x.com', { gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false }, gv_referred_by: 'r@x.com' }),
  ]);
  assert.deepEqual(updates, [], 'nothing left to change means no writes');
});

test('other rungs already earned are preserved, not reset', () => {
  const updates = planEntryUpdates([
    profile('a@x.com', { gv_breakdown: { confirmed: false, survey: true, referrals: 0, instagram: true, upload: true } }),
  ]);
  const u = forEmail(updates, 'a@x.com');
  assert.equal(u.breakdown.survey, true);
  assert.equal(u.breakdown.upload, true);
  assert.equal(u.entries, 1 + 2 + 3 + 3 + 10, 'crediting confirmation must not clobber survey/instagram/upload');
});

test('matching is case-insensitive, so a mixed-case referral field still pays', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_referred_by: 'ReFerrer@X.com' }),
  ]);
  assert.equal(forEmail(updates, 'referrer@x.com').breakdown.referrals, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/giveaway-reconcile.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/reconcile.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/giveaway/reconcile.js
/**
 * Reconcile stored entry state against what Klaviyo actually knows.
 *
 * Owns the two rungs no HTTP request can credit:
 *
 *   confirmed (+2) — every profile passed in came from listSubscribedProfiles,
 *     which filters to SUBSCRIBED consent. Being in that set IS the
 *     double-opt-in confirmation, and it is the only authority on it. Nothing
 *     in a request may set this flag.
 *   referral (+5) — lands on the REFERRER's profile once the friend they
 *     referred confirms. Direction is easy to invert, so state it once: the
 *     ENTRANT names their referrer in gv_referred_by; the credit goes the
 *     other way.
 *
 * Pure: no Klaviyo, no clock, no randomness — every rule is covered by tests
 * rather than discovered in production. Idempotency comes from comparing stored
 * state to desired state, so a re-run after a partial failure is safe.
 */
import { validateReferral, REFERRAL_CAP, normalizeEmail, entryTotal } from './entries.js';

export function planEntryUpdates(confirmedProfiles) {
  const byEmail = new Map();
  for (const p of confirmedProfiles) {
    try { byEmail.set(normalizeEmail(p.email), p); } catch { /* skip unusable rows */ }
  }

  // Count eligible confirmed referees per referrer.
  const earned = new Map();
  for (const p of confirmedProfiles) {
    const raw = p.properties?.gv_referred_by;
    if (!raw) continue;
    let referrer;
    try { referrer = normalizeEmail(raw); } catch { continue; }

    const check = validateReferral({
      referrerEmail: referrer,
      entrantEmail: p.email,
      referrerIsConfirmedEntrant: byEmail.has(referrer),
      referrerReferralCredits: 0, // the cap is applied to the total below
    });
    if (!check.ok) continue;
    earned.set(referrer, (earned.get(referrer) || 0) + 1);
  }

  const updates = [];
  for (const [email, profile] of byEmail) {
    const stored = profile.properties?.gv_breakdown || {};
    const storedReferrals = Number(stored.referrals ?? 0);
    // Never decrease: a referee who unsubscribes must not claw back a credit
    // already earned, and that also makes re-runs stable.
    const referrals = Math.max(Math.min(earned.get(email) ?? 0, REFERRAL_CAP), storedReferrals);

    if (stored.confirmed === true && referrals === storedReferrals) continue;

    const breakdown = {
      survey: stored.survey === true,
      instagram: stored.instagram === true,
      upload: stored.upload === true,
      confirmed: true,
      referrals,
    };
    updates.push({ email, entries: entryTotal(breakdown), breakdown });
  }
  return updates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/giveaway-reconcile.test.js`
Expected: PASS, 8 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Write the runner script**

```javascript
// scripts/giveaway/reconcile-referrals.mjs
/**
 * Credit referrers whose referred friends have now confirmed. Idempotent, so
 * safe to run nightly (and safe to re-run after a failure).
 *
 *   node scripts/giveaway/reconcile-referrals.mjs          # report only
 *   node scripts/giveaway/reconcile-referrals.mjs --apply  # write to Klaviyo
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSubscribedProfiles, updateProfileProperties } from '../../lib/klaviyo-profiles.js';
import { planEntryUpdates } from '../../lib/giveaway/reconcile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');

const confirmed = await listSubscribedProfiles(listId);
console.log(`${confirmed.length} confirmed entrants`);

const updates = planEntryUpdates(confirmed);
if (!updates.length) { console.log('Everything already reconciled.'); process.exit(0); }

let failures = 0;
for (const row of updates) {
  console.log(`${row.email}: confirmed=${row.breakdown.confirmed} referrals=${row.breakdown.referrals} -> ${row.entries} entries`);
  if (!apply) continue;
  try {
    await updateProfileProperties(row.email, {
      gv_breakdown: row.breakdown,
      gv_entries: row.entries,
    });
  } catch (e) {
    // One bad profile must not abandon the rest of the run. The next run
    // retries it, because the plan is recomputed from stored state.
    failures += 1;
    console.error(`  FAILED ${row.email}: ${e.message}`);
  }
}
console.log(apply
  ? `Updated ${updates.length - failures}/${updates.length} profile(s).`
  : 'Dry run — pass --apply to write.');
if (failures) process.exitCode = 1;
```

- [ ] **Step 6: Verify the dry run is genuinely read-only**

Run: `node scripts/giveaway/reconcile-referrals.mjs`
Expected: prints the confirmed count and either `Everything already reconciled.` or a plan ending in `Dry run`. No Klaviyo writes.

- [ ] **Step 7: Commit**

```bash
git add lib/giveaway/reconcile.js scripts/giveaway/reconcile-referrals.mjs tests/lib/giveaway-reconcile.test.js
git commit -m "feat(giveaway): nightly reconciliation of confirmation and referral rungs"
```

---

### Task 6: Lander page and official rules page

The lander is the ad destination. The rules page must exist before the lander links to it, so they ship together.

**Files:**
- Create: `theme/sections/giveaway-entry.liquid`
- Create: `theme/templates/page.giveaway.json`
- Create: `theme/assets/giveaway.js`
- Create: `data/giveaway/official-rules.html`
- Create: `scripts/giveaway/build-pages.mjs`

**Interfaces:**
- Consumes: `createPage`, `getPages`, `updatePage`, `getMainThemeId`, `updateThemeAsset` from `lib/shopify.js`.
- Produces: live pages `/pages/free-soap-giveaway` and `/pages/giveaway-official-rules`; `theme/assets/giveaway.js` exposes `window.RSCGiveaway.submitEntry(form)`.

- [ ] **Step 1: Write the official rules**

Create `data/giveaway/official-rules.html` containing, as plain HTML, all eight load-bearing clauses from spec §8. It must include verbatim:

- "**NO PURCHASE NECESSARY. A purchase will not improve your chances of winning.**"
- "**Purchases do not earn entries.**"
- Every entry method and its value: entry 1, confirming your email +2, answering the optional questions +3, each referred friend who confirms +5 up to a maximum of 10 friends, posting and tagging us on Instagram +3, uploading a photo or video +10.
- **A definition of "confirmed entrant"**, stated explicitly, because it gates a $536.40 payout decision: an entrant who has completed the email-confirmation step. Do not leave it to inference.
- **A carve-out reconciling one-entry-per-email with the bonus ladder.** "One entry per email address" read literally contradicts a ladder that stacks up to 69 entries on one address. Word it as one *base* entry per email address, except as provided by the bonus methods.
- Describe only mechanics that actually exist. There is **no unique referral link** — referral is a single optional email field on the entry form. Do not document a link.
- "**Void in Rhode Island** and where otherwise prohibited." (Total ARV $1,072.80 exceeds Rhode Island's $500 retail-sweepstakes registration threshold.)
- Referral prize: the winner's named referrer wins the same prize **only if that referrer is themselves a confirmed entrant**.
- **Self-referral must be voided TWICE, in two separate statements: once for entry-crediting, and once for prize eligibility.** Voiding it only for crediting leaves a double-payout hole — a winner who named their own address trivially satisfies "is themselves a confirmed entrant" and could claim two prizes, $1,072.80 instead of $536.40. State plainly that where the named referrer is the winner, no second prize is awarded.
- The Sensitive Skin Set shipments need a stated schedule, like the soap's 3-per-year. Without one, the liability cap's per-shipment language has nothing to attach to.
- Prize: 36 bars of Pure Unscented Moisturizing Coconut Soap over 3 years (3 shipments per year of 4 bars) plus 3 Sensitive Skin Moisturizing Sets. ARV **$536.40** per winner. If Pure Unscented is unavailable at the time of any shipment the sponsor may substitute a comparable bar of equal or greater retail value.
- Liability cap: if the sponsor ceases operations, remaining shipments may be fulfilled as a cash equivalent or terminated.
- "**Unsubscribing from our emails does not forfeit your entry.**"
- "This promotion is in no way sponsored, endorsed, administered by, or associated with Meta, Facebook, or Instagram."
- Sponsor name and postal address, entry period with timezone, one entry per email, odds depend on number of entries, winner drawn at random and notified by email within 48 hours with 7 days to respond, taxes are the winner's responsibility, and a link to the privacy policy.

**The sponsor postal address MUST be read from `data/brand/brand-kit.json` → `postal_address`.** It is currently `1623 Central Ave STE 201, Cheyenne, WY 82001, United States`. Do not take it from the live privacy policy or any other page — that copy is stale. `brand-kit.json` records that this address **replaced `6212 FM 933, Blum, TX 76627` on 2026-07-31**, and the superseded one was written into both the rules page and six email footers on this branch before the error was caught. The same field's note carries the standing constraint: it is a CAN-SPAM postal address and **never** a manufacturing location — products are "made in the USA" and no city or state is ever named as the place of manufacture.

- [ ] **Step 2: Write the entry section**

```liquid
{%- comment -%}
  Giveaway lander entry form.

  Posts to a first-party subdomain, matching theme/snippets/rsc-rum.liquid. An
  ad-blocker-filtered host would silently drop entries we paid ~$2.50 each for,
  which is the same mistake the RUM collector already learned once.

  Three fields only. Every extra field on a cold lander costs opt-in rate; the
  survey happens on the next page, after the entry is safely recorded.
{%- endcomment -%}

{%- liquid
  assign endpoint = 'https://entries.realskincare.com/api/giveaway'
-%}

<section class="gv-entry" id="gv-entry">
  <h1>{{ section.settings.headline }}</h1>
  <p class="gv-sub">{{ section.settings.subhead }}</p>

  <ul class="gv-stack">
    <li><strong>36 free bars</strong> of Pure Unscented soap, over 3 years</li>
    <li><strong>3 Sensitive Skin Moisturizing Sets</strong></li>
    <li>A <strong>$536</strong> prize. Entering is free.</li>
  </ul>

  <form class="gv-form" novalidate>
    <label for="gv-email">Email</label>
    <input id="gv-email" name="email" type="email" required autocomplete="email">

    <label for="gv-first">First name</label>
    <input id="gv-first" name="firstName" type="text" required autocomplete="given-name">

    <label for="gv-ref">Referred by a friend? Their email <span>(optional)</span></label>
    <input id="gv-ref" name="referredBy" type="email" autocomplete="off">

    <button type="submit">Enter free</button>
    <p class="gv-error" hidden role="alert"></p>
    <p class="gv-fine">
      No purchase necessary. Purchases do not earn entries.
      <a href="/pages/giveaway-official-rules">Official rules</a>.
      This promotion is not sponsored, endorsed, or administered by Meta.
    </p>
  </form>
</section>

<script>window.RSC_GIVEAWAY_ENDPOINT = {{ endpoint | json }};</script>
<script src="{{ 'giveaway.js' | asset_url }}" defer="defer"></script>

{% schema %}
{
  "name": "Giveaway entry",
  "settings": [
    { "id": "headline", "type": "text", "label": "Headline", "default": "Most 'unscented' soap isn't. Ours is." },
    { "id": "subhead", "type": "text", "label": "Subhead", "default": "We're giving away 36 free bars. Entering takes 10 seconds." }
  ],
  "presets": [{ "name": "Giveaway entry" }]
}
{% endschema %}
```

Note: schema `label` values must stay ≤70 characters.

- [ ] **Step 3: Write the storefront JS**

```javascript
// theme/assets/giveaway.js
// Entry submission. On success, hand off to the entered page, which is where
// the survey and the entry ladder live. There is NO offer on that page --
// the BOGO is the day-30 consolation prize.
(function () {
  var endpoint = window.RSC_GIVEAWAY_ENDPOINT;
  var form = document.querySelector('.gv-form');
  if (!form || !endpoint) return;
  var errorEl = form.querySelector('.gv-error');
  var button = form.querySelector('button[type="submit"]');

  function fail(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    button.disabled = false;
    button.textContent = 'Enter free';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    var data = new FormData(form);
    var email = (data.get('email') || '').trim();
    var firstName = (data.get('firstName') || '').trim();
    if (!email || !firstName) return fail('Email and first name are both required.');

    button.disabled = true;
    button.textContent = 'Entering…';

    fetch(endpoint + '/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, firstName: firstName, referredBy: data.get('referredBy') || null })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body.ok) return fail(res.body.error || 'Something went wrong. Please try again.');
        try { window.sessionStorage.setItem('gv_email', email); } catch (err) { /* private mode */ }
        window.location.href = '/pages/giveaway-entered';
      })
      .catch(function () { fail('Network error. Please try again.'); });
  });
})();
```

- [ ] **Step 4: Write the template and the push script**

`theme/templates/page.giveaway.json`:

```json
{
  "sections": {
    "main": { "type": "giveaway-entry", "settings": {} }
  },
  "order": ["main"]
}
```

```javascript
// scripts/giveaway/build-pages.mjs
/**
 * Push giveaway theme assets and create/update the Shopify pages.
 *
 *   node scripts/giveaway/build-pages.mjs
 *
 * Idempotent: existing pages are updated by handle rather than duplicated.
 * Verifies each page returns 200 afterwards -- success logs lie, the live page
 * is the evidence.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMainThemeId, updateThemeAsset, getPages, createPage, updatePage } from '../../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const abs = (...p) => join(ROOT, ...p);

// Source path -> theme asset key. Sources that do not exist yet are SKIPPED
// with a log line rather than throwing, so this script runs green while the
// giveaway pages are still being built out across tasks. A silent skip would be
// worse than a throw, so each one is announced.
const ASSETS = [
  [abs('theme', 'sections', 'giveaway-entry.liquid'), 'sections/giveaway-entry.liquid'],
  [abs('theme', 'sections', 'giveaway-entered.liquid'), 'sections/giveaway-entered.liquid'],
  [abs('theme', 'assets', 'giveaway.js'), 'assets/giveaway.js'],
  [abs('theme', 'templates', 'page.giveaway.json'), 'templates/page.giveaway.json'],
  [abs('theme', 'templates', 'page.giveaway-entered.json'), 'templates/page.giveaway-entered.json'],
];

const PAGES = [
  { handle: 'free-soap-giveaway', title: 'Win 36 Free Bars of Unscented Soap', template_suffix: 'giveaway', body_html: '', requires: abs('theme', 'sections', 'giveaway-entry.liquid') },
  { handle: 'giveaway-entered', title: "You're entered", template_suffix: 'giveaway-entered', body_html: '', requires: abs('theme', 'sections', 'giveaway-entered.liquid') },
  { handle: 'giveaway-official-rules', title: 'Giveaway Official Rules', template_suffix: null, bodyFrom: abs('data', 'giveaway', 'official-rules.html'), requires: abs('data', 'giveaway', 'official-rules.html') },
];

const themeId = await getMainThemeId();
console.log(`Theme ${themeId}`);
for (const [source, key] of ASSETS) {
  if (!existsSync(source)) { console.log(`  SKIP ${key} — not built yet`); continue; }
  await updateThemeAsset(themeId, key, readFileSync(source, 'utf8'));
  console.log(`  pushed ${key}`);
}

const existing = await getPages();
const live = [];
for (const { requires, bodyFrom, ...page } of PAGES) {
  if (!existsSync(requires)) { console.log(`  SKIP /pages/${page.handle} — not built yet`); continue; }
  if (bodyFrom) page.body_html = readFileSync(bodyFrom, 'utf8');
  const hit = existing.find((p) => p.handle === page.handle);
  const saved = hit ? await updatePage(hit.id, page) : await createPage(page);
  console.log(`  ${hit ? 'updated' : 'created'} /pages/${saved.handle} (${saved.id})`);
  live.push(page.handle);
}

// Success logs lie; the live page is the evidence.
for (const handle of live) {
  const url = `https://www.realskincare.com/pages/${handle}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  console.log(`  ${res.status} ${url}`);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
}
console.log(`Verified ${live.length} page(s) live.`);
```

- [ ] **Step 5: Run it and verify all three pages return 200**

Run: `node scripts/giveaway/build-pages.mjs`
Expected: three `pushed` lines, two `SKIP … not built yet` lines for the entered-page section and template (Task 7 creates those), two `created`/`updated` pages, one `SKIP /pages/giveaway-entered`, then two `200` lines and `Verified 2 page(s) live.`

The skips are why this task stands on its own — Task 7 adds the missing sources and the same script then pushes all five and verifies all three.

- [ ] **Step 6: Commit**

```bash
git add theme/sections/giveaway-entry.liquid theme/templates/page.giveaway.json theme/assets/giveaway.js data/giveaway/official-rules.html scripts/giveaway/build-pages.mjs
git commit -m "feat(giveaway): lander, entry form, and official rules page"
```

---

### Task 7: Entered page — survey and entry ladder

The page an entrant lands on after submitting. **No offer appears here** — the BOGO is the day-30 consolation prize. This page's job is the survey and the ladder.

**Files:**
- Create: `theme/sections/giveaway-entered.liquid`
- Create: `theme/templates/page.giveaway-entered.json`
- Modify: `theme/assets/giveaway.js` (append the entered-page controller)

**Interfaces:**
- Consumes: `POST /api/giveaway/answers` and `GET /api/giveaway/entries` from Task 4; `sessionStorage.gv_email` set by Task 6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the section**

```liquid
{%- comment -%}
  Post-entry page: three required questions, then the optional three, then the
  entry-ladder widget.

  Deliberately contains NO OFFER. The BOGO is released once, on draw day, as the
  consolation prize for not winning (spec 7.1). A full-price store link stays
  here so an entrant who wants to buy on day 3 is never blocked.

  Q1 (household) gates the duration claim on the day-30 offer: a shared bar does
  not last 25 days, so a family answer suppresses the months claim entirely.
{%- endcomment -%}

{%- liquid
  assign endpoint = 'https://entries.realskincare.com/api/giveaway'
-%}

<section class="gv-entered" data-gv-entered>
  <h1>You're in.</h1>
  <p>We'll email you to confirm — <strong>click that link</strong> and you get 2 bonus entries.</p>

  <form class="gv-survey" data-step="required">
    <fieldset>
      <legend>Who's the soap for?</legend>
      <label><input type="radio" name="household" value="solo" required> Just me</label>
      <label><input type="radio" name="household" value="couple"> Me and my partner</label>
      <label><input type="radio" name="household" value="family"> My whole family</label>
      <label><input type="radio" name="household" value="gift"> It's a gift</label>
    </fieldset>

    <fieldset>
      <legend>What's your #1 skin frustration?</legend>
      <label><input type="radio" name="frustration" value="dry" required> Dry and flaky</label>
      <label><input type="radio" name="frustration" value="reactive"> Itchy and reactive</label>
      <label><input type="radio" name="frustration" value="fragrance"> Fragrance sets me off</label>
      <label><input type="radio" name="frustration" value="ingredients"> Ingredient concerns</label>
    </fieldset>

    <fieldset>
      <legend>What are you using now?</legend>
      <label><input type="radio" name="currentBrand" value="cerave" required> CeraVe</label>
      <label><input type="radio" name="currentBrand" value="cetaphil"> Cetaphil</label>
      <label><input type="radio" name="currentBrand" value="dove"> Dove</label>
      <label><input type="radio" name="currentBrand" value="natural_competitor"> Dr. Squatch or Native</label>
      <label><input type="radio" name="currentBrand" value="natural_brand"> Another natural brand</label>
      <label><input type="radio" name="currentBrand" value="whatever"> Whatever's on sale</label>
    </fieldset>

    <button type="submit">Save — and get 3 bonus entries</button>
  </form>

  <div class="gv-ladder" data-gv-ladder hidden>
    <h2>Your entries: <span data-gv-count>1</span></h2>
    <ul>
      <li data-rung="confirm">Confirm your email — <strong>+2</strong></li>
      <li data-rung="survey">Answer 3 quick questions — <strong>+3</strong></li>
      <li data-rung="referral">Each friend who enters and names you — <strong>+5</strong> (up to 10)</li>
      <li data-rung="instagram">Post and tag @realskincare — <strong>+3</strong></li>
      <li data-rung="upload">Send us a photo or video — <strong>+10</strong></li>
    </ul>
    <p class="gv-fine">Purchases do not earn entries.
      <a href="/pages/giveaway-official-rules">Official rules</a>.</p>
  </div>

  <p class="gv-shop">
    Not waiting for the draw? <a href="/products/coconut-soap">Shop the unscented bar</a>
    or the <a href="/products/sensitive-skin-starter-set">Sensitive Skin Set</a>.
  </p>
</section>

<script>window.RSC_GIVEAWAY_ENDPOINT = {{ endpoint | json }};</script>
<script src="{{ 'giveaway.js' | asset_url }}" defer="defer"></script>

{% schema %}
{
  "name": "Giveaway entered",
  "settings": [],
  "presets": [{ "name": "Giveaway entered" }]
}
{% endschema %}
```

- [ ] **Step 2: Append the entered-page controller to `theme/assets/giveaway.js`**

```javascript
// --- entered page: survey submit + ladder ---
(function () {
  var endpoint = window.RSC_GIVEAWAY_ENDPOINT;
  var root = document.querySelector('[data-gv-entered]');
  if (!root || !endpoint) return;

  // Identity, in priority order:
  //   1. ?e= on the URL — this is how a nurture email brings someone back.
  //      sessionStorage is TAB-SCOPED and does not survive an email-client ->
  //      browser jump, so for return visitors it is almost always empty. That
  //      is the dominant return path, so without this param the ladder would
  //      show a wrong count to exactly the people the campaign drove back.
  //   2. sessionStorage, set by the lander on first entry.
  var email = null;
  try {
    var qp = new URLSearchParams(window.location.search);
    email = qp.get('e') || window.sessionStorage.getItem('gv_email');
    if (email) window.sessionStorage.setItem('gv_email', email);
  } catch (e) { /* private mode, or no URLSearchParams */ }

  var survey = root.querySelector('.gv-survey');
  var ladder = root.querySelector('[data-gv-ladder]');
  var count = root.querySelector('[data-gv-count]');

  // Never display a number we do not know. The markup ships a placeholder of 1;
  // showing that to someone who actually has 11 entries makes the ladder — the
  // campaign's whole engagement mechanic — actively misleading. If we cannot
  // establish the real total, hide the count instead of inventing one.
  function showLadder(entries) {
    if (typeof entries === 'number') {
      count.textContent = String(entries);
      count.parentNode.hidden = false;
    } else {
      count.parentNode.hidden = true;
    }
    ladder.hidden = false;
  }

  // Without an email we cannot attribute answers. Show the ladder's actions so
  // the page is still useful, but post nothing and claim no count.
  if (!email) { survey.hidden = true; showLadder(null); return; }

  // We know who they are, so fetch the authoritative total. A 404 means they
  // have not entered yet; anything else is a transient failure. In both cases
  // fall back to hiding the count rather than showing a fabricated one.
  fetch(endpoint + '/entries?email=' + encodeURIComponent(email))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (body) { showLadder(body && typeof body.entries === 'number' ? body.entries : null); })
    .catch(function () { showLadder(null); });

  survey.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(survey);
    var payload = {
      email: email,
      household: data.get('household'),
      frustration: data.get('frustration'),
      currentBrand: data.get('currentBrand')
    };
    if (!payload.household || !payload.frustration || !payload.currentBrand) return;

    var button = survey.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving…';

    fetch(endpoint + '/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        survey.hidden = true;
        showLadder(body && body.entries);
      })
      .catch(function () {
        button.disabled = false;
        button.textContent = 'Save — and get 3 bonus entries';
      });
  });
})();
```

- [ ] **Step 3: Write the template**

`theme/templates/page.giveaway-entered.json`:

```json
{
  "sections": {
    "main": { "type": "giveaway-entered", "settings": {} }
  },
  "order": ["main"]
}
```

- [ ] **Step 4: Push and verify both pages render**

Run: `node scripts/giveaway/build-pages.mjs`
Expected: now that Task 7's sources exist, five `pushed` lines with no skips, three pages, three `200` lines, `Verified 3 page(s) live.` Then confirm the entered page has no offer copy:

```bash
curl -s -A 'Mozilla/5.0' https://www.realskincare.com/pages/giveaway-entered | grep -c -iE '\$99|\$66|months free' || echo "0 — correct, no offer on this page"
```
Expected: `0`. Any match means offer copy leaked onto the pre-draw page.

- [ ] **Step 5: Commit**

```bash
git add theme/sections/giveaway-entered.liquid theme/templates/page.giveaway-entered.json theme/assets/giveaway.js
git commit -m "feat(giveaway): entered page with survey and entry ladder, no offer"
```

---

### Task 8: Daily report

The only in-flight signals are cost and lead quality, because deferring the offer removes every revenue signal until day 30. That makes this report the campaign's whole instrument panel.

**Files:**
- Create: `scripts/giveaway/report.mjs`
- Create: `lib/giveaway/summarize.js`
- Test: `tests/lib/giveaway-summarize.test.js`

**Interfaces:**
- Consumes: `listSubscribedProfiles` from `lib/klaviyo-profiles.js`.
- Produces: `summarizeEntrants(profiles) -> { total, entriesTotal, ladder: {...}, answers: { household, frustration, currentBrand, switchBlocker, unscentedReaction } }` — no `barsCommitted`: bars are committed by ORDERS, and no order can exist until the offer opens on day 30, so that belongs to the Phase 2 report; writes `data/reports/giveaway/latest.json`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/lib/giveaway-summarize.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';

const p = (props) => ({ id: 'x', email: `${Math.random()}@x.com`, properties: props });

test('counts entrants and sums server-side entry totals', () => {
  const s = summarizeEntrants([
    p({ gv_entries: 1, gv_breakdown: { confirmed: false, survey: false, referrals: 0 } }),
    p({ gv_entries: 8, gv_breakdown: { confirmed: true, survey: false, referrals: 1 } }),
  ]);
  assert.equal(s.total, 2);
  assert.equal(s.entriesTotal, 9);
});

test('tallies the answer mix, which is the day-5 lead-quality gate', () => {
  const s = summarizeEntrants([
    p({ gv_entries: 1, gv_frustration: 'reactive' }),
    p({ gv_entries: 1, gv_frustration: 'reactive' }),
    p({ gv_entries: 1, gv_frustration: 'dry' }),
  ]);
  assert.equal(s.answers.frustration.reactive, 2);
  assert.equal(s.answers.frustration.dry, 1);
});

test('reports referral participation, the day-10 gate', () => {
  const s = summarizeEntrants([
    p({ gv_entries: 6, gv_breakdown: { referrals: 1 } }),
    p({ gv_entries: 1, gv_breakdown: { referrals: 0 } }),
  ]);
  assert.equal(s.ladder.referrals, 1);
  assert.equal(s.ladder.entrantsWithReferrals, 1);
});

test('a missing gv_entries falls back to 1 rather than NaN', () => {
  const s = summarizeEntrants([p({})]);
  assert.equal(s.entriesTotal, 1);
});

test('a corrupt gv_entries falls back to 1 instead of poisoning the whole total', () => {
  // NaN + x is NaN for every later addition, so one bad row would blank the
  // entire report -- and the day-5 spend decision is made from this number.
  const s = summarizeEntrants([p({ gv_entries: 'unknown' }), p({ gv_entries: 5 })]);
  assert.equal(s.entriesTotal, 6);
});

test('INTEGRATION: a profile shaped the way the endpoint actually writes it yields a populated answer mix', () => {
  // This is the test whose absence let a real defect ship. summarizeEntrants
  // reads TOP-LEVEL gv_* properties; an earlier version of the endpoint stored
  // survey answers inside gv_breakdown instead. Both sides' unit tests passed
  // while answers.* was permanently empty in production, which would have made
  // the day-5 answer-mix gate fire a false alarm on every single run.
  const asEndpointWrites = {
    gv_entrant: true,
    gv_entries: 4,
    gv_breakdown: { confirmed: false, survey: true, referrals: 0, instagram: false, upload: false },
    gv_household: 'family',
    gv_frustration: 'fragrance',
    gv_current_brand: 'cerave',
  };
  const s = summarizeEntrants([{ id: 'x', email: 'a@x.com', properties: asEndpointWrites }]);
  assert.equal(s.answers.frustration.fragrance, 1, 'the report must see the answers the endpoint wrote');
  assert.equal(s.answers.household.family, 1);
  assert.equal(s.answers.currentBrand.cerave, 1);
  assert.equal(s.ladder.survey, 1, 'and the ladder rung still comes from the breakdown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/giveaway-summarize.test.js`
Expected: FAIL — `Cannot find module '.../lib/giveaway/summarize.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/giveaway/summarize.js
/**
 * Roll confirmed entrant profiles into the daily report shape.
 *
 * Deferring the offer to day 30 removes every in-flight revenue signal, so the
 * answer mix and ladder participation below ARE the campaign's early gates.
 */
const ANSWER_KEYS = [
  'gv_household', 'gv_frustration', 'gv_current_brand',
  'gv_switch_blocker', 'gv_unscented_reaction',
];

export function summarizeEntrants(profiles) {
  const answers = {};
  for (const key of ANSWER_KEYS) answers[key.replace(/^gv_/, '').replace(/_(.)/g, (_, c) => c.toUpperCase())] = {};

  const ladder = { confirmed: 0, survey: 0, referrals: 0, instagram: 0, upload: 0, entrantsWithReferrals: 0 };
  let entriesTotal = 0;

  for (const profile of profiles) {
    const props = profile.properties || {};
    // A corrupt gv_entries must not silently poison the total -- NaN + x is NaN
    // for every later addition, and the day-5 spend decision is made from this
    // number. Fall back to 1 rather than propagating NaN.
    const n = Number(props.gv_entries ?? 1);
    entriesTotal += Number.isFinite(n) ? n : 1;

    const b = props.gv_breakdown || {};
    if (b.confirmed) ladder.confirmed += 1;
    if (b.survey) ladder.survey += 1;
    if (b.instagram) ladder.instagram += 1;
    if (b.upload) ladder.upload += 1;
    const refs = Number(b.referrals ?? 0);
    if (refs > 0) { ladder.referrals += refs; ladder.entrantsWithReferrals += 1; }

    for (const key of ANSWER_KEYS) {
      const value = props[key];
      if (!value) continue;
      const bucket = answers[key.replace(/^gv_/, '').replace(/_(.)/g, (_, c) => c.toUpperCase())];
      bucket[value] = (bucket[value] || 0) + 1;
    }
  }

  return { total: profiles.length, entriesTotal, ladder, answers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/giveaway-summarize.test.js`
Expected: PASS, 4 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Write the report runner**

```javascript
// scripts/giveaway/report.mjs
/**
 * Daily giveaway report -> data/reports/giveaway/latest.json
 *   node scripts/giveaway/report.mjs
 *
 * Prints the day-5 and day-10 gates from spec 11 so a human reading the log
 * sees the decision, not just the numbers.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSubscribedProfiles } from '../../lib/klaviyo-profiles.js';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'data', 'reports', 'giveaway');

const profiles = await listSubscribedProfiles(listId);
const summary = summarizeEntrants(profiles);
const report = { generatedAt: new Date().toISOString(), ...summary };

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);

const f = summary.answers.frustration || {};
// Denominator is survey RESPONDENTS, not all entrants. Dividing by every
// entrant counts people who have not reached the survey step as if they had
// answered "not reactive", mechanically deflating the share and firing a false
// drift alarm early in the campaign.
const answered = Object.values(f).reduce((a, b) => a + b, 0);
const reactiveShare = answered ? ((f.reactive || 0) + (f.fragrance || 0)) / answered : 0;

console.log(`Entrants: ${summary.total}  Entries: ${summary.entriesTotal}`);
console.log(`Reactive/fragrance share: ${(reactiveShare * 100).toFixed(0)}%`);
if (answered >= 50 && reactiveShare < 0.5) {
  console.log('GATE: answer mix is drifting off the fragrance-free angle — shift budget to creative #3.');
}
if (summary.total >= 50 && summary.ladder.entrantsWithReferrals === 0) {
  console.log('GATE: zero referral participation — rework the nurture CTA, do not raise budget.');
}
```

- [ ] **Step 6: Run it**

Run: `node scripts/giveaway/report.mjs && cat data/reports/giveaway/latest.json`
Expected: prints the counts and writes valid JSON containing `total`, `entriesTotal`, `ladder`, `answers`.

- [ ] **Step 7: Commit**

```bash
git add lib/giveaway/summarize.js scripts/giveaway/report.mjs tests/lib/giveaway-summarize.test.js
git commit -m "feat(giveaway): daily entrant report with day-5 and day-10 gates"
```

---

### Task 9: Nurture flow

Six sends across 30 days whose CTA is a ladder action, never a purchase. The ladder is what gives entrants something to do during a 30-day wait, and referrals are what pull CPL down as the audience saturates.

**Files:**
- Create: `scripts/giveaway/build-nurture-flow.mjs`
- Create: `data/giveaway/nurture/*.html` (6 files)

**Interfaces:**
- Consumes: `upsertTemplateByName`, `createFlow`, `updateFlowStatus` from `lib/klaviyo.js`; `listId` from `config/giveaway.json`.
- Produces: a live Klaviyo flow named `Giveaway — Entry & Nurture`; writes its id to `config/giveaway.json` as `nurtureFlowId`.

- [ ] **Step 1: Write the six email bodies**

Create `data/giveaway/nurture/01-confirm.html` … `06-final-call.html`. Content rules, all from the spec:

- **01 (immediate) — confirmation.** Sequenced anticipation → **resell staying subscribed** → *then* confirm the entry. There is no reward to hand over at this stage, so the resell is the entire job of the email. CTA: click to confirm, +2 entries.
- **02 (day 2) — referral push.** CTA: get a friend to enter and name you, +5 each up to 10. States that if you win, the friend who referred you wins too.
- **03 (day 6) — the angle.** "Most 'unscented' soap isn't." Names the objection as a category fact, never as a claim about the reader. CTA: the optional 3 questions, +3.
- **04 (day 12) — UGC.** CTA: send us a photo or video, +10, or post and tag on Instagram, +3. States that uploading grants usage rights.
- **05 (day 20) — referral reminder** with the reader's current entry total.
- **06 (day 28) — final call.** Entries close, draw is in 2 days.

Every email must include: an unsubscribe link, and the line **"Unsubscribing does not forfeit your entry."** No email may contain a discount code or an offer.

**Every link back to `/pages/giveaway-entered` MUST carry `?e={{ person.email|urlencode }}`.** `sessionStorage` is tab-scoped and does not survive an email-client → browser jump, so without that param the page cannot identify the visitor and will hide their entry count instead of showing it. Emails 02, 04, 05 and 06 all drive entrants back to that page to claim rungs, and a ladder that cannot show a total is a broken CTA.

- [ ] **Step 2: Write the flow builder**

```javascript
// scripts/giveaway/build-nurture-flow.mjs
/**
 * Build the giveaway nurture flow.
 *
 *   node scripts/giveaway/build-nurture-flow.mjs templates
 *   node scripts/giveaway/build-nurture-flow.mjs flow
 *   node scripts/giveaway/build-nurture-flow.mjs golive
 *
 * Trigger: added to the giveaway list. Every CTA is a ladder action; nothing in
 * this flow sells. The consolation offer is a separate day-30 campaign.
 *
 * NOTE: entrants must be suppressed from the Welcome flow (UUa3Qk) or FIRST20
 * stacks on the day-30 offer and silently costs ~$20 of a $40 contribution.
 * That is a one-time manual filter in the Klaviyo UI, printed as a reminder below.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertTemplateByName, createFlow, updateFlowStatus } from '../../lib/klaviyo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const NURTURE_DIR = join(ROOT, 'data', 'giveaway', 'nurture');
const DELAYS_HOURS = [0, 48, 144, 288, 480, 672]; // 0, d2, d6, d12, d20, d28
const mode = process.argv[2] || 'templates';

const files = readdirSync(NURTURE_DIR).filter((f) => f.endsWith('.html')).sort();
if (files.length !== 6) throw new Error(`expected 6 nurture emails, found ${files.length}`);

for (const file of files) {
  const html = readFileSync(join(NURTURE_DIR, file), 'utf8');
  if (!/unsubscribe/i.test(html)) throw new Error(`${file} has no unsubscribe link`);
  if (!/does not forfeit your entry/i.test(html)) throw new Error(`${file} is missing the entry-retention line`);
  if (/SOAP4MO|SOAP6MO|\$99|\$66/.test(html)) throw new Error(`${file} contains offer copy — the offer is day 30 only`);
}
console.log('All 6 emails pass the content gates.');

if (mode === 'templates' || mode === 'flow') {
  config.nurtureTemplates = {};
  for (const file of files) {
    const name = `Giveaway Nurture — ${file.replace(/\.html$/, '')}`;
    const tpl = await upsertTemplateByName(name, readFileSync(join(NURTURE_DIR, file), 'utf8'));
    config.nurtureTemplates[file] = tpl.id;
    console.log(`  template ${name} -> ${tpl.id}`);
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

if (mode === 'flow') {
  const actions = files.map((file, i) => ({
    type: 'send-email',
    delay_hours: DELAYS_HOURS[i],
    template_id: config.nurtureTemplates[file],
  }));
  const flow = await createFlow({
    name: 'Giveaway — Entry & Nurture',
    definition: { triggers: [{ type: 'list', list_id: config.listId }], actions },
  });
  config.nurtureFlowId = flow.id;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Flow ${flow.id} created (draft).`);
}

if (mode === 'golive') {
  await updateFlowStatus(config.nurtureFlowId, 'live');
  console.log(`Flow ${config.nurtureFlowId} is live.`);
  console.log('\n>>> MANUAL STEP: add a suppression filter excluding gv_entrant profiles');
  console.log('    from the Welcome flow (UUa3Qk), or FIRST20 will stack on the day-30 offer. <<<');
}
```

Note: `createFlow` takes a Klaviyo flow definition. If the exact `definition` shape is rejected, read the shape used by the existing `scripts/flows/build-reset-delivery.mjs` — that script has a working `create-flow-with-definition` payload against revision `2025-07-15` — and match it.

- [ ] **Step 3: Run the content gates**

Run: `node scripts/giveaway/build-nurture-flow.mjs templates`
Expected: `All 6 emails pass the content gates.` then six `template ... -> <id>` lines. If any email is missing the unsubscribe or entry-retention line, or contains offer copy, it throws — fix the HTML.

- [ ] **Step 4: Create and go live**

Run: `node scripts/giveaway/build-nurture-flow.mjs flow && node scripts/giveaway/build-nurture-flow.mjs golive`
Expected: flow created then live, with the Welcome-flow suppression reminder printed.

- [ ] **Step 5: Commit**

```bash
git add scripts/giveaway/build-nurture-flow.mjs data/giveaway/nurture config/giveaway.json
git commit -m "feat(giveaway): 6-email nurture flow with ladder CTAs and no-offer content gates"
```

---

### Task 10: Gate A — pixel, AEM, and end-to-end launch verification

Nothing goes live on Meta until a real entry passes end to end. No offer is involved in Gate A; Gate B (the offer) belongs to Phase 2.

**Files:**
- Create: `scripts/giveaway/verify-launch.mjs`
- Create: `docs/runbooks/2026-08-11-giveaway-launch.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a pass/fail launch gate.

- [ ] **Step 1: Sean-gated setup (cannot be automated)**

Record in the runbook, and confirm each before proceeding:

1. Meta Business Manager + ad account + payment method.
2. **DNS, batch both records in one Cloudflare visit:** the Meta domain-verification `TXT` on `realskincare.com`, **and** a `CNAME` for `entries.realskincare.com` pointing at the same origin as `rum.realskincare.com`. The entry endpoint must be first-party — an ad-blocker-filtered host silently drops entries paid for at ~$2.50 each. *Fallback if the CNAME slips: serve the endpoint from the existing `rum.realskincare.com` host and update the two `endpoint` assigns in the Liquid sections.*
3. Install the **official Facebook & Instagram sales channel app** for pixel + CAPI. Do not hand-add a pixel to `theme.liquid` — that is how the orphaned `twq` pixel came to throw on every page and push Clarity's script-error rate to 12.4%.
4. **Aggregated Event Measurement: rank `Lead` at priority #1.** If Purchase outranks Lead, iOS lead conversions are silently dropped and the campaign optimises on partial data.
5. **Klaviyo list set to DOUBLE OPT-IN** (List Settings → Opt-in Process).
6. **Welcome flow `UUa3Qk` filtered to exclude `gv_entrant` profiles.**

- [ ] **Step 2: Write the verification script**

```javascript
// scripts/giveaway/verify-launch.mjs
/**
 * Gate A: everything that must be true before a single ad dollar is spent.
 *
 *   node scripts/giveaway/verify-launch.mjs
 *
 * Exits non-zero on any failure. Success logs lie; this checks the live surfaces.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const UA = { 'User-Agent': 'Mozilla/5.0' };
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures.push(label); };

// 1. All three pages live.
for (const handle of ['free-soap-giveaway', 'giveaway-entered', 'giveaway-official-rules']) {
  const res = await fetch(`https://www.realskincare.com/pages/${handle}`, { headers: UA });
  check(res.ok, `/pages/${handle} returns 200 (got ${res.status})`);
}

// 2. The lander carries the required legal lines.
const lander = await (await fetch('https://www.realskincare.com/pages/free-soap-giveaway', { headers: UA })).text();
check(/no purchase necessary/i.test(lander), 'lander states NO PURCHASE NECESSARY');
check(/not sponsored, endorsed/i.test(lander), 'lander carries the Meta release');
check(/official-rules/.test(lander), 'lander links the official rules');

// 3. No offer copy has leaked onto a pre-draw page.
const entered = await (await fetch('https://www.realskincare.com/pages/giveaway-entered', { headers: UA })).text();
check(!/\$99|\$66|months free|SOAP6MO|SOAP4MO/.test(entered), 'entered page contains NO offer copy');

// 4. Rules contain the clauses that bound our liability.
const rules = await (await fetch('https://www.realskincare.com/pages/giveaway-official-rules', { headers: UA })).text();
// These assert what the storefront SERVES, not what the Admin API stored.
// On 2026-08-11 the corrected rules were saved and confirmed byte-identical via
// the Admin API while the storefront kept serving the previous version from
// edge cache — including the double-payout wording it was corrected to remove.
// Saved is not served, and only served matters to an entrant.
for (const [re, label] of [
  [/void in rhode island/i, 'rules: void in Rhode Island'],
  [/purchases do not earn entries/i, 'rules: purchases do not earn entries'],
  [/does not forfeit your entry/i, 'rules: unsubscribing does not forfeit an entry'],
  [/536\.40/, 'rules: ARV $536.40 stated'],
  [/confirmed entrant/i, 'rules: referrer must be a confirmed entrant'],
  [/cash equivalent|terminated/i, 'rules: liability cap on the 3-year obligation'],
  [/no second prize/i, 'rules: self-referral earns NO SECOND PRIZE (double-payout guard)'],
  [/independently void/i, 'rules: self-referral voided for prize eligibility, separately from crediting'],
  [/base entry per email/i, 'rules: one-base-entry carve-out reconciles §4 with the bonus ladder'],
]) check(re.test(rules), label);

// 5. The Meta pixel is present (installed via the sales channel app).
check(/connect\.facebook\.net|fbevents|fbq\(/.test(lander), 'Meta pixel fires on the lander');

// 6. The entry endpoint is reachable and first-party.
const endpointMatch = lander.match(/https:\/\/[a-z0-9.-]+\/api\/giveaway/);
check(!!endpointMatch, 'lander declares an entry endpoint');
if (endpointMatch) {
  const host = new URL(endpointMatch[0]).host;
  check(host.endsWith('realskincare.com'), `endpoint is first-party (${host})`);
  const res = await fetch(`${endpointMatch[0]}/entries?email=bad`, { headers: UA });
  check(res.status === 400, `endpoint answers without auth (got ${res.status})`);
}

// 7. Config is complete.
check(!!config.listId, 'config.listId is set');
check(!!config.nurtureFlowId, 'config.nurtureFlowId is set');

console.log('');
if (failures.length) { console.error(`${failures.length} failure(s). DO NOT launch.`); process.exit(1); }
console.log('Gate A passed. Manual step remaining: submit a real test entry and confirm the email arrives.');
```

- [ ] **Step 3: Run the full test suite, then the gate**

Run: `nvm use && npm test`
Expected: all tests pass. **Check the cancelled count is 0**, not just `# fail 0`.

Run: `node scripts/giveaway/verify-launch.mjs`
Expected: every line `PASS`, ending `Gate A passed.` Any `FAIL` blocks launch.

- [ ] **Step 4: Submit a real test entry**

Manually, in a browser: open `/pages/free-soap-giveaway`, enter a real address you control, land on `/pages/giveaway-entered`, answer the three questions, confirm the entry count reads **4** (base 1 + survey 3), then click the confirmation email and re-check it reads **6** (+2 confirm).

Then verify the profile server-side:

```bash
node -e "import('./lib/klaviyo-profiles.js').then(async m => console.log(await m.getProfileByEmail('YOUR@EMAIL')))"
```
Expected: `gv_entrant: true`, `gv_entries: 6`, and `gv_household` / `gv_frustration` / `gv_current_brand` all populated.

- [ ] **Step 5: Write the runbook and commit**

`docs/runbooks/2026-08-11-giveaway-launch.md` records: the six Sean-gated items with their completion state, the Gate A output, the test-entry result, the two `endpoint` assigns to change if the CNAME fallback is used, and the nightly cron line for the reconciler:

```
# Credit referrers whose referred friends have confirmed. Idempotent.
30 8 * * * cd /root/seo-claude && /usr/bin/node scripts/giveaway/reconcile-referrals.mjs --apply >> /var/log/giveaway-reconcile.log 2>&1
```

```bash
git add scripts/giveaway/verify-launch.mjs docs/runbooks/2026-08-11-giveaway-launch.md
git commit -m "feat(giveaway): Gate A launch verification and runbook"
```

---

### Task 11: Upload and Instagram rungs

The last two ladder rungs. Both are priced in `ENTRY_VALUES` and promoted by nurture email 04 (day 12), so they must exist before that email sends — but neither is a launch blocker, so this task can land during the campaign's first week.

The upload rung is the more valuable of the two: a tagged Instagram post gives reach but **no licence to use the asset**, whereas an upload with a usage-rights checkbox produces licensed target-demo creative — a documented gap, since the founder is not the target demo.

**Files:**
- Modify: `agents/dashboard/routes/giveaway.js` (add `POST /api/giveaway/upload`)
- Modify: `theme/sections/giveaway-entered.liquid` (add the upload + Instagram fields)
- Modify: `theme/assets/giveaway.js` (wire both)
- Test: `tests/dashboard/giveaway-upload.test.js`

**Interfaces:**
- Consumes: `computeAndPersistEntries` from Task 4; `uploadImageToShopifyCDN` from `lib/shopify.js` (image-only — the supported path).
- Produces: `POST /api/giveaway/upload` — body `{ email, filename, dataBase64, rightsGranted }` → `200 { ok: true, entries, url }`; exported `validateUpload(body) -> { ok, error?, value? }`.

Design note: the payload is base64 JSON rather than multipart. The dashboard's other storefront route reads a capped JSON body, and adding a multipart parser for one field would be the only such code in the app. The trade is ~33% wire overhead, which is acceptable for a handful of uploads.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/dashboard/giveaway-upload.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateUpload } from '../../agents/dashboard/routes/giveaway.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUg==';

test('an upload without granted rights is rejected — an unlicensed asset is worthless to us', () => {
  const r = validateUpload({ email: 'a@b.com', filename: 'me.png', dataBase64: tinyPng, rightsGranted: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /rights/i);
});

test('a valid upload passes and the filename is sanitised to a safe basename', () => {
  const r = validateUpload({
    email: 'a@b.com', filename: '../../etc/passwd.png', dataBase64: tinyPng, rightsGranted: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.filename, 'passwd.png', 'path traversal must not survive validation');
});

test('a non-image extension is rejected, because the CDN helper is image-only', () => {
  const r = validateUpload({ email: 'a@b.com', filename: 'payload.svg', dataBase64: tinyPng, rightsGranted: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /jpg, jpeg, png, webp/i);
});

test('an oversized payload is rejected before it is decoded', () => {
  const huge = 'A'.repeat(9 * 1024 * 1024);
  const r = validateUpload({ email: 'a@b.com', filename: 'big.png', dataBase64: huge, rightsGranted: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/i);
});

test('a bad email is rejected', () => {
  const r = validateUpload({ email: 'nope', filename: 'me.png', dataBase64: tinyPng, rightsGranted: true });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dashboard/giveaway-upload.test.js`
Expected: FAIL — `validateUpload is not a function`

- [ ] **Step 3: Add the validator and route to `agents/dashboard/routes/giveaway.js`**

Add these imports at the top of the file:

```javascript
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname } from 'node:path';
import { uploadImageToShopifyCDN } from '../../../lib/shopify.js';
```

Add the validator beside `validateEntryPayload`:

```javascript
const UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_UPLOAD_BASE64 = 8 * 1024 * 1024; // ~6MB file

export function validateUpload(body = {}) {
  let email;
  try { email = normalizeEmail(body.email); }
  catch { return { ok: false, error: 'a valid email is required' }; }

  if (body.rightsGranted !== true) {
    return { ok: false, error: 'usage rights must be granted for us to use your photo' };
  }
  const data = String(body.dataBase64 ?? '');
  if (!data) return { ok: false, error: 'no file supplied' };
  if (data.length > MAX_UPLOAD_BASE64) return { ok: false, error: 'file is too large (6MB max)' };

  // basename() strips any traversal before we ever touch the filesystem.
  const filename = basename(String(body.filename ?? '')).slice(-80);
  const ext = extname(filename).toLowerCase();
  if (!UPLOAD_EXTS.has(ext)) {
    return { ok: false, error: 'please send a jpg, jpeg, png, or webp' };
  }
  return { ok: true, value: { email, filename, dataBase64: data } };
}
```

Add this route to the exported array:

```javascript
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/upload',
    handler: async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req, MAX_UPLOAD_BASE64 + 2048)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }

      const v = validateUpload(parsed);
      if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

      const tmp = join(tmpdir(), `gv-${Date.now()}-${v.value.filename}`);
      try {
        writeFileSync(tmp, Buffer.from(v.value.dataBase64, 'base64'));
        const url = await uploadImageToShopifyCDN(tmp, 'Giveaway entrant submission');
        const out = await computeAndPersistEntries(v.value.email, { upload: true });
        await updateProfileProperties(v.value.email, { gv_upload_url: url });
        return json(res, req, 200, { ok: true, url, ...out });
      } catch (e) {
        console.error('[giveaway] upload failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not save your photo' });
      } finally {
        // This box's 24GB disk has already taken down every cron job once by
        // filling up. The temp file goes, success or failure.
        try { unlinkSync(tmp); } catch { /* already gone */ }
      }
    },
  },
```

Make `readCappedBody` accept a per-route cap by changing its signature:

```javascript
function readCappedBody(req, cap = MAX_BODY_BYTES) {
```

and replacing the two uses of `MAX_BODY_BYTES` inside it with `cap`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dashboard/giveaway-upload.test.js`
Expected: PASS, 5 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Add both fields to the entered page**

In `theme/sections/giveaway-entered.liquid`, inside `.gv-ladder`, after the `<ul>`:

```liquid
  <form class="gv-bonus" data-gv-bonus>
    <label for="gv-ig">Posted about us? Your Instagram handle <span>(+3)</span></label>
    <input id="gv-ig" name="igHandle" type="text" placeholder="@yourhandle" autocomplete="off">

    <label for="gv-file">Send us a photo or video <span>(+10)</span></label>
    <input id="gv-file" name="file" type="file" accept="image/jpeg,image/png,image/webp">

    <label class="gv-rights">
      <input type="checkbox" name="rightsGranted" value="1">
      I'm happy for Real Skin Care to use my photo in its marketing.
    </label>

    <button type="submit">Claim my bonus entries</button>
    <p class="gv-bonus-error" hidden role="alert"></p>
  </form>
```

- [ ] **Step 6: Wire both in `theme/assets/giveaway.js`**

Append inside the entered-page controller, before its closing `})();`:

```javascript
  var bonus = root.querySelector('[data-gv-bonus]');
  if (bonus) {
    bonus.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = bonus.querySelector('.gv-bonus-error');
      err.hidden = true;
      var handle = bonus.querySelector('[name="igHandle"]').value.trim();
      var fileInput = bonus.querySelector('[name="file"]');
      var rights = bonus.querySelector('[name="rightsGranted"]').checked;
      var file = fileInput.files && fileInput.files[0];

      function showError(msg) { err.textContent = msg; err.hidden = false; }

      if (handle) {
        fetch(endpoint + '/answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, igHandle: handle, instagram: true })
        })
          .then(function (r) { return r.json(); })
          .then(function (b) { if (b && b.entries) count.textContent = String(b.entries); });
      }

      if (!file) return;
      if (!rights) return showError('Please tick the box so we can use your photo.');

      var reader = new FileReader();
      reader.onload = function () {
        var base64 = String(reader.result).split(',')[1];
        fetch(endpoint + '/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, filename: file.name, dataBase64: base64, rightsGranted: true })
        })
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (!b || !b.ok) return showError((b && b.error) || 'Upload failed. Please try again.');
            count.textContent = String(b.entries);
          })
          .catch(function () { showError('Upload failed. Please try again.'); });
      };
      reader.readAsDataURL(file);
    });
  }
```

- [ ] **Step 7: Push, then verify end to end with a real image**

Run: `node scripts/giveaway/build-pages.mjs`

Then in a browser on `/pages/giveaway-entered`, submit an Instagram handle and a real photo with the rights box ticked. Confirm the entry count rises by 13 (+3 +10) and check the profile:

```bash
node -e "import('./lib/klaviyo-profiles.js').then(async m => { const p = await m.getProfileByEmail('YOUR@EMAIL'); console.log(p.properties.gv_entries, p.properties.gv_ig_handle, p.properties.gv_upload_url); })"
```
Expected: the total includes both rungs, and `gv_upload_url` is a `cdn.shopify.com` URL that returns 200.

- [ ] **Step 8: Commit**

```bash
git add agents/dashboard/routes/giveaway.js theme/sections/giveaway-entered.liquid theme/assets/giveaway.js tests/dashboard/giveaway-upload.test.js
git commit -m "feat(giveaway): upload and Instagram ladder rungs with usage-rights gate"
```

---

## Self-Review

**Spec coverage.** Walked spec §§1–14. Covered: prize/economics constants (T2), funnel pages (T6, T7), entry form and all six questions (T6, T7), the bonus ladder (T1, T4, T5), duration guarding (T2), official rules and all eight load-bearing clauses (T6, verified T10), Meta pixel/CAPI/AEM (T10), Klaviyo list quarantine and double opt-in (T3), Welcome-flow suppression (T9, T10), nurture (T9), reporting and the day-5/day-10 gates (T8), Gate A (T10).

Deliberately deferred to Phase 2, all day-34+: offer page, BXGY codes, weighted draw, draw-result campaign, Gate B, day-90 sunset script, the day-12–15 full-price Set send.

The first pass of this review found two ladder rungs — upload (+10) and Instagram (+3) — priced in `ENTRY_VALUES` and promoted by nurture email 04 with no implementation. **Task 11 now covers both.** It is sequenced last because neither blocks launch, but it must land before email 04 sends on day 12.

**Task ordering.** Tasks 1–3 are pure libraries with no external dependency and can run in any order. Task 4 depends on 1 and 3; Task 5 on 1 and 3; Task 7 on 6 (shared JS file and push script); Task 8 on 3; Task 10 on everything. Task 11 depends on 4 and 7. Only Tasks 6 and 7 touch the same files, so they should not be parallelised.

**Placeholder scan.** No TBD/TODO. Every code step is real, runnable code. Two steps intentionally describe content rather than emit it — T6 Step 1 (rules HTML) and T9 Step 1 (six emails) — because both are long-form legal and marketing copy; each is specified as an explicit, checkable clause list, and both are enforced by automated gates (`verify-launch.mjs` regexes for rules; the content gates in `build-nurture-flow.mjs` for emails).

**Type consistency.** `normalizeEmail`, `entryTotal`, `validateReferral`, `REFERRAL_CAP` are defined in T1 and used with matching signatures in T4, T5, T8. The breakdown object keys (`confirmed`, `survey`, `referrals`, `instagram`, `upload`) are identical across T1, T4, T5, T8. `listSubscribedProfiles` returns `{id, email, properties}` in T3 and is consumed with that shape in T5 and T8. `SOAP_VARIANT_ID` is the same string in T2 and the Global Constraints. `config/giveaway.json` keys (`listId`, `nurtureTemplates`, `nurtureFlowId`) are written in T3/T9 and read in T4/T5/T8/T10.
