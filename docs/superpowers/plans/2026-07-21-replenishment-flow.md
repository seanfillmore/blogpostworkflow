# Replenishment Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Klaviyo "time to replenish" email flow that nudges one-time buyers to re-purchase — preferentially by converting them to a Subscribe & Save subscription — filling the day-35/50 gap in RSC's lifecycle and lifting repeat rate (17.8% → 25%+).

**Architecture:** A new flow module in the existing `scripts/flows/` system (`flows/replenishment.js`), built and shipped with the existing `build.js` CLI. Because it is a net-new flow (no old flow to clone), `build.js` gains a small enhancement to read the trigger + profile-filter from the module itself. Emails reuse the shared `components.js` template library. A one-time `RESTOCK10` Shopify discount backs the Email 2 fallback.

**Tech Stack:** Node ESM, `node:test` + `node:assert`, Klaviyo API via `lib/klaviyo.js`, Shopify Admin GraphQL via `lib/shopify.js` `getAccessToken()`.

## Global Constraints

- **Email only** (SMS is out of scope for v1).
- **Trigger:** Klaviyo `Placed Order` metric id **`V69ueg`**.
- **Profile filter:** exit anyone who places another order after flow start (reuse the exact JSON in Task 2).
- **Timeline:** Email 1 at **day 35**, Email 2 at **day 50** (delay 15d after E1). Non-actors age into the existing Winback flow at day 75. Do not exceed day ~55.
- **Subscription messaging:** promote **Subscribe & Save 15%** at an **every 6–8 weeks** cadence — **never** say "monthly". Every subscription mention MUST include the flexibility line: **"Skip, pause, swap scent, or cancel anytime from your account."**
- **Incentive:** Email 1 has **no coupon**. Email 2 keeps subscription as the hero and offers **`RESTOCK10` (10% one-time)** only as the "won't subscribe" fallback.
- **Dynamic product:** reference the purchased product name in-template via `{{ event.Items|first|default:"..." }}` (RSC flows personalize in-template, not via item-split branches).
- **Follow existing patterns:** flow module shape `{ name, oldFlowId, entry, emails, actions }`; email components from `scripts/flows/components.js`.
- **Ship path:** templates → draft flow → verify → render → seed test → golive. Never golive before verify passes.

---

### Task 1: `build.js` — support net-new flows (no `oldFlowId`)

`build.js` currently clones the trigger + profile_filter from `mod.oldFlowId`. A net-new flow has none, so add a pure resolver in `klaviyo-graph.js` (safely importable — no top-level side effects) and wire it in. Also make golive skip the "retire old flow" step when there is no old flow.

**Files:**
- Modify: `scripts/flows/klaviyo-graph.js` (add `resolveEnrollment`)
- Modify: `scripts/flows/build.js` (use it in `cmdFlow`; guard `cmdGolive`)
- Test: `tests/flows/klaviyo-graph.test.js`

**Interfaces:**
- Produces: `resolveEnrollment(mod, oldDef) -> { triggers, profileFilter }`. If `mod.triggers` AND `mod.profileFilter` are set, returns those (net-new). Else returns `{ triggers: oldDef.triggers, profileFilter: oldDef.profile_filter }`. Throws if neither is available.

- [ ] **Step 1: Write the failing test**

Create `tests/flows/klaviyo-graph.test.js`:

```js
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolveEnrollment } from '../../scripts/flows/klaviyo-graph.js';

test('resolveEnrollment: net-new module uses its own triggers/profileFilter', () => {
  const mod = { triggers: [{ type: 'metric', id: 'V69ueg', trigger_filter: null }], profileFilter: { condition_groups: [] } };
  const out = resolveEnrollment(mod, null);
  assert.equal(out.triggers[0].id, 'V69ueg');
  assert.deepEqual(out.profileFilter, { condition_groups: [] });
});

test('resolveEnrollment: legacy module clones from the old flow definition', () => {
  const mod = { oldFlowId: 'ABC123' };
  const oldDef = { triggers: [{ type: 'metric', id: 'X' }], profile_filter: { condition_groups: [{ a: 1 }] } };
  const out = resolveEnrollment(mod, oldDef);
  assert.equal(out.triggers[0].id, 'X');
  assert.deepEqual(out.profileFilter, { condition_groups: [{ a: 1 }] });
});

test('resolveEnrollment: throws when neither inline nor cloned enrollment is available', () => {
  assert.throws(() => resolveEnrollment({ name: 'z' }, null), /enrollment/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/flows/klaviyo-graph.test.js`
Expected: FAIL — `resolveEnrollment` is not exported.

- [ ] **Step 3: Add the resolver to `klaviyo-graph.js`**

Append to `scripts/flows/klaviyo-graph.js`:

```js
/**
 * Resolve a flow's enrollment (triggers + profile_filter). Net-new flows set
 * `mod.triggers` + `mod.profileFilter` inline; legacy flows clone them from an
 * existing flow's definition (`oldDef`).
 */
export function resolveEnrollment(mod, oldDef) {
  if (mod.triggers && mod.profileFilter) {
    return { triggers: mod.triggers, profileFilter: mod.profileFilter };
  }
  if (!oldDef) throw new Error(`flow "${mod.name}": no inline enrollment and no cloned flow to derive it from`);
  return { triggers: oldDef.triggers, profileFilter: oldDef.profile_filter };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/flows/klaviyo-graph.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into `build.js`**

In `scripts/flows/build.js`, add `resolveEnrollment` to the import from `./klaviyo-graph.js`:

```js
import { send, delay, itemSplit, verifyFlow, resolveEnrollment } from './klaviyo-graph.js';
```

Replace the body of `cmdFlow` between the idempotent-delete block and `createFlow` — specifically these two lines:

```js
  const old = await k.getFlowDefinition(mod.oldFlowId);
  const def = buildDefinition(mod, templateIds, old.definition.triggers, old.definition.profile_filter, sendStatus);
```

with:

```js
  const oldDef = (mod.triggers && mod.profileFilter) ? null : (await k.getFlowDefinition(mod.oldFlowId)).definition;
  const { triggers, profileFilter } = resolveEnrollment(mod, oldDef);
  const def = buildDefinition(mod, templateIds, triggers, profileFilter, sendStatus);
```

In `cmdGolive`, guard the retire-old-flow line. Replace:

```js
  await k.updateFlowStatus(mod.oldFlowId, 'draft');
  console.log(`✓ ${flowName} LIVE (${id}); old flow ${mod.oldFlowId} set to draft. Messages: ${v.sends.length}/${v.sends.length} live.`);
```

with:

```js
  if (mod.oldFlowId) {
    await k.updateFlowStatus(mod.oldFlowId, 'draft');
    console.log(`✓ ${flowName} LIVE (${id}); old flow ${mod.oldFlowId} set to draft. Messages: ${v.sends.length}/${v.sends.length} live.`);
  } else {
    console.log(`✓ ${flowName} LIVE (${id}); net-new flow (no old flow to retire). Messages: ${v.sends.length}/${v.sends.length} live.`);
  }
```

- [ ] **Step 6: Verify existing flows still parse (no regression)**

Run: `node -c scripts/flows/build.js && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add scripts/flows/klaviyo-graph.js scripts/flows/build.js tests/flows/klaviyo-graph.test.js
git commit -m "feat(flows): support net-new Klaviyo flows in build.js (inline triggers/profile_filter)"
```

---

### Task 2: Replenishment flow module

**Files:**
- Create: `scripts/flows/flows/replenishment.js`
- Test: `tests/flows/replenishment.test.js`

**Interfaces:**
- Consumes: `send`, `delay` from `scripts/flows/klaviyo-graph.js`; `shell`, `H1`, `P_`, `SIGN`, `button`, `codeBox`, `P` from `scripts/flows/components.js`.
- Produces: default export `{ name, oldFlowId: null, triggers, profileFilter, entry: 'd1', emails: { replenish_1, replenish_2 }, actions(msg, {send, delay}, sendStatus) }`. `actions` returns `[delay 35d → send e1 → delay 15d → send e2 → null]`.

- [ ] **Step 1: Write the failing test**

Create `tests/flows/replenishment.test.js`:

```js
import { strict as assert } from 'node:assert';
import test from 'node:test';
import mod from '../../scripts/flows/flows/replenishment.js';
import { send, delay } from '../../scripts/flows/klaviyo-graph.js';

test('module shape: net-new flow with inline enrollment', () => {
  assert.equal(mod.oldFlowId, null);
  assert.equal(mod.entry, 'd1');
  assert.equal(mod.triggers[0].id, 'V69ueg');
  assert.ok(mod.profileFilter.condition_groups[0].conditions[0].metric_id === 'V69ueg');
  assert.ok(mod.emails.replenish_1 && mod.emails.replenish_2);
});

test('actions build the day-35 / day-50 two-email graph', () => {
  const msg = (key) => ({ subject: key, preview: '', template_id: 't-' + key, name: key });
  const acts = mod.actions(msg, { send, delay }, 'draft');
  assert.deepEqual(acts.map((a) => a.temporary_id), ['d1', 'e1', 'd2', 'e2']);
  assert.equal(acts[0].data.value, 35);
  assert.equal(acts[0].data.unit, 'days');
  assert.equal(acts[0].links.next, 'e1');
  assert.equal(acts[1].links.next, 'd2');
  assert.equal(acts[2].data.value, 15);
  assert.equal(acts[3].links.next, null);
});

test('Email 1: subscription-first, flexibility line, dynamic product, NO coupon', () => {
  const h = mod.emails.replenish_1.html;
  assert.match(h, /Subscribe & Save/);
  assert.match(h, /Skip, pause, swap scent, or cancel anytime/);
  assert.match(h, /event\.Items\|first/);
  assert.doesNotMatch(h, /RESTOCK10/);
  assert.doesNotMatch(h, /monthly/i);
});

test('Email 2: keeps subscription hero + RESTOCK10 fallback', () => {
  const h = mod.emails.replenish_2.html;
  assert.match(h, /Subscribe & Save/);
  assert.match(h, /RESTOCK10/);
  assert.match(h, /Skip, pause, swap scent, or cancel anytime/);
  assert.doesNotMatch(h, /monthly/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/flows/replenishment.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the module**

Create `scripts/flows/flows/replenishment.js`:

```js
/**
 * Replenishment (net-new) — trigger: Placed Order (V69ueg).
 * Fills the gap between Review (day 14) and Winback (day 75). Nudges one-time
 * buyers to re-purchase, preferentially via Subscribe & Save.
 *   E1 (35d)  no coupon — subscribe-first + one-time reorder
 *   E2 (+15d) subscribe hero + RESTOCK10 (10% one-time) fallback
 * Profile filter exits anyone who reorders after flow start (same shape as Winback).
 */
import { shell, H1, P_, SIGN, button, codeBox, P } from '../components.js';

const FLEX = P_('Skip, pause, swap scent, or cancel anytime from your account.');
const PROD = '{{ event.Items|first|default:"your Real Skin Care favorites" }}';

export default {
  name: 'Replenishment (RSC v2)',
  oldFlowId: null,
  triggers: [{ type: 'metric', id: 'V69ueg', trigger_filter: null }],
  profileFilter: {
    condition_groups: [{
      conditions: [{
        type: 'profile-metric', metric_id: 'V69ueg', measurement: 'count',
        measurement_filter: { type: 'numeric', operator: 'equals', value: 0 },
        timeframe_filter: { type: 'date', operator: 'flow-start' }, metric_filters: null,
      }],
    }],
  },
  entry: 'd1',
  emails: {
    replenish_1: {
      name: 'Replenishment — 01 Running Low',
      subject: `Running low on ${PROD}?`,
      preview: 'Most folks are getting low around now — the easy way to restock.',
      html: shell(
        'Most folks are getting low around now — the easy way to restock.',
        H1('Running low?') +
        P_(`Hi {{ first_name|default:"there" }}, you picked up ${PROD} about five weeks ago — right around when most folks start running low.`) +
        P_('The easiest way to never run out? <strong>Subscribe &amp; Save — 15% off every order</strong>, delivered every 6&ndash;8 weeks to match how fast you actually use it.') +
        FLEX +
        button(P.lotion.url, 'Subscribe & Save 15%') +
        P_(`Prefer to grab it just once? <a href="${P.bestSellers.url}" style="color:#2f5e3f;font-weight:600;">Reorder here</a>.`) +
        SIGN,
      ),
    },
    replenish_2: {
      name: 'Replenishment — 02 Never Run Out',
      subject: `Never run out of ${PROD} 🥥`,
      preview: 'Your favorite is probably empty by now — here are two easy ways to restock.',
      html: shell(
        'Your favorite is probably empty by now — here are two easy ways to restock.',
        H1('Never run out again') +
        P_(`Hi {{ first_name|default:"there" }}, your ${PROD} is probably running empty about now.`) +
        P_('Subscribe &amp; Save is the no-brainer: <strong>15% off every order</strong>, delivered every 6&ndash;8 weeks.') +
        FLEX +
        button(P.lotion.url, 'Subscribe & Save 15%') +
        P_('Not ready to subscribe? Here&rsquo;s <strong>10% off a one-time restock</strong>:') +
        codeBox('10% off your restock', 'RESTOCK10') +
        button(P.bestSellers.url, 'Reorder once') +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 35, 'days', 'e1'),
      send('e1', msg('replenish_1'), 'd2', sendStatus),
      delay('d2', 15, 'days', 'e2'),
      send('e2', msg('replenish_2'), null, sendStatus),
    ];
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/flows/replenishment.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/flows/flows/replenishment.js tests/flows/replenishment.test.js
git commit -m "feat(flows): replenishment flow module (subscribe-first, day 35/50)"
```

---

### Task 3: Create the `RESTOCK10` Shopify discount

Email 2 references `RESTOCK10`. Create it once via the Shopify Admin GraphQL API (10% off, once per customer, no minimum). Idempotent: a "code already exists" userError is treated as success.

**Files:**
- Create: `scripts/flows/create-restock10-discount.mjs`

**Interfaces:**
- Consumes: `getAccessToken` from `lib/shopify.js`; `SHOPIFY_STORE` from `.env`.

- [ ] **Step 1: Write the script**

Create `scripts/flows/create-restock10-discount.mjs`:

```js
/**
 * One-time: create the RESTOCK10 discount (10% off, once per customer) used by
 * the Replenishment flow's Email 2 fallback. Idempotent.
 *   node scripts/flows/create-restock10-discount.mjs
 */
import { readFileSync } from 'fs';
import { getAccessToken } from '../../lib/shopify.js';

const env = {};
for (const l of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const STORE = env.SHOPIFY_STORE;
const token = await getAccessToken();

const mutation = `mutation($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}`;
const variables = {
  d: {
    title: 'RESTOCK10',
    code: 'RESTOCK10',
    startsAt: new Date().toISOString(),
    customerSelection: { all: true },
    customerGets: { value: { percentage: 0.10 }, items: { all: true } },
    appliesOncePerCustomer: true,
  },
};
const res = await fetch(`https://${STORE}/admin/api/2025-01/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: mutation, variables }),
});
const j = await res.json();
const errs = j.data?.discountCodeBasicCreate?.userErrors ?? [];
const node = j.data?.discountCodeBasicCreate?.codeDiscountNode;
if (node) { console.log('✓ RESTOCK10 created:', node.id); }
else if (errs.some((e) => /taken|already exists|has already/i.test(e.message))) { console.log('✓ RESTOCK10 already exists — nothing to do.'); }
else { console.error('ERROR:', JSON.stringify(errs.length ? errs : j, null, 2)); process.exit(1); }
```

- [ ] **Step 2: Run it**

Run: `node scripts/flows/create-restock10-discount.mjs`
Expected: `✓ RESTOCK10 created: gid://shopify/...` (or `already exists`).

- [ ] **Step 3: Verify in Shopify admin**

Confirm in Shopify → Discounts that `RESTOCK10` exists, is **Active**, **10% off**, **once per customer**. (Manual visual check — a mis-created discount is worse than none.)

- [ ] **Step 4: Commit**

```bash
git add scripts/flows/create-restock10-discount.mjs
git commit -m "feat(flows): script to create RESTOCK10 discount for replenishment fallback"
```

---

### Task 4: Build, verify, and go live

Operational task — no new code. Uses the `build.js` CLI. Each step gates the next; do not golive until verify is clean and a seed test lands.

**Files:** none (runs `scripts/flows/build.js`).

- [ ] **Step 1: Upsert the two email templates**

Run: `cd scripts/flows && node build.js replenishment templates`
Expected: two lines — `✓ replenish_1 <id>` and `✓ replenish_2 <id>`.

- [ ] **Step 2: Render both emails and eyeball them**

Run:
```bash
cd scripts/flows
node build.js replenishment render replenish_1 "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients"
node build.js replenishment render replenish_2 "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients"
```
Expected: two `rendered ...` lines. Open the two `flow-replenishment-*.html` files in the scratchpad and confirm: the product name resolves in the copy, "Subscribe & Save 15%" + the flexibility line appear in both, `RESTOCK10` appears in Email 2 only, and the word "monthly" appears nowhere.

- [ ] **Step 3: Create the DRAFT flow**

Run: `cd scripts/flows && node build.js replenishment flow`
Expected: `✓ Created flow <id> (flow: draft, messages: draft)`.

- [ ] **Step 4: Verify the flow graph**

Run: `cd scripts/flows && node build.js replenishment verify`
Expected: `Issues: NONE`, status `draft`, and a graph showing `time-delay 35 days → send-email → time-delay 15 days → send-email`.

- [ ] **Step 5: Live-test on a seed profile**

In Klaviyo (UI), open the draft "Replenishment (RSC v2)" flow and send a preview/test of both messages to a seed address (e.g. support@realskincare.com). Confirm deliverability and that links resolve. (Dynamic `{{ event.Items|first }}` may be blank in a bare preview — that's expected; the `default:` fallback covers it. The render check in Step 2 is the real content gate.)

- [ ] **Step 6: Go live**

Run: `cd scripts/flows && node build.js replenishment golive`
Expected: `✓ replenishment LIVE (<id>); net-new flow (no old flow to retire). Messages: 2/2 live.`

- [ ] **Step 7: Confirm live in Klaviyo**

In Klaviyo, confirm the "Replenishment (RSC v2)" flow status is **Live** and both messages are **Live** (not manual/draft). Verify the trigger is **Placed Order** and the profile filter "hasn't placed an order since starting" is present.

- [ ] **Step 8: Commit the build-state**

```bash
git add scripts/flows/build-state.json
git commit -m "chore(flows): replenishment flow live (build-state)"
```

---

## Self-Review

**Spec coverage:**
- Trigger `Placed Order V69ueg` + profile filter → Task 2 (module), Task 1 (build support). ✓
- Timeline day 35 / +15 / handoff at 75 → Task 2 `actions`. ✓
- Subscribe-first, 6–8 week cadence, no "monthly", flexibility line → Task 2 emails + tests. ✓
- Email 1 no coupon; Email 2 RESTOCK10 fallback → Task 2 tests + Task 3 discount. ✓
- Dynamic product via `event.Items|first` → Task 2 + Task 4 render check. ✓
- Email-only, existing components/pattern → Task 2. ✓
- Ship path templates→draft→verify→render→seed→golive → Task 4. ✓
- Subscriber-handling-via-profile-filter (v1), dunning as next project → documented in spec; no code here (correct — out of scope). ✓

**Placeholder scan:** No TBD/TODO. All code blocks complete. `{{ ... }}` are intentional Klaviyo merge tags. ✓

**Type consistency:** `resolveEnrollment(mod, oldDef)` signature identical in Task 1 test, implementation, and build.js call site. Module export keys (`triggers`, `profileFilter`, `emails.replenish_1/2`, `entry:'d1'`, `oldFlowId:null`) match Task 2 test assertions and build.js expectations (`mod.name`, `mod.entry`, `mod.emails`, `mod.actions`). Metric id `V69ueg` consistent across trigger, profile filter, and tests. ✓
