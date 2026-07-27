# Collection Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse 62 live Shopify collections down to 4, redirect the rest to the surviving collection or the category's PDP, strip 49 collection links out of the store's navigation, and change the code that generated the sprawl so it cannot regrow.

**Architecture:** A pure classifier library decides every collection's fate from its handle and is fully unit-tested with no network. Four thin scripts drive it against the Shopify Admin API — consolidation (REST), navigation (GraphQL `menuUpdate`), survivor setup, and theme metadata. Every mutating script is dry-run by default and requires `--apply`. Nothing auto-applies during implementation; the live run is a separate gated task.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, Shopify Admin REST + GraphQL via `lib/shopify.js`. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-collection-consolidation-design.md`. It governs; this plan implements it.
- Work on branch `worktree-collection-consolidation` in the worktree at `.claude/worktrees/collection-consolidation`. Never commit to `main`.
- **Read navigation from the `menus` GraphQL query, never from rendered HTML.** Two spec drafts described the menus from page source and were wrong both times.
- **Never redirect to an unpublished or missing target.** Every target must be verified to return HTTP 200 before its redirect is written.
- **Every mutating script defaults to dry-run.** `--apply` is required to write. No script mutates the live store as a side effect of being run without arguments.
- Cloudflare caches collection URLs ~10s. After a mutation, confirm via the API (`published_at`, redirect existence) before trusting a `curl`.
- The four survivors are exactly: `non-toxic-body-lotion`, `foaming-hand-soap`, `all-products`, `on-sale`. Everything else redirects.
- Baseline test suite: 986 tests, 985 passing. The single failure is `tests/agents/priority-tuner.test.js` — environmental (stale local `data/reports/seo-impact/` trips a freshness gate), unrelated, expected to keep failing. Any OTHER failure is yours.
- Run `npm test` once before each commit, not after every edit.

## Known store state (verified 2026-07-27, Admin API)

- 88 collections total; **62 live**, 26 draft. 4 survivors → **84 to redirect** (58 live, 26 draft).
- Catalog: 19 products; 10 tagged `bundle`/`value-set`; **9 distinct single products**.
- Menus: 12 total, 5 carry collection links, **49 items across 35 distinct collection URLs**.
  - `product-menu` `gid://shopify/Menu/200084193450` — 7 top-level items already `type: PRODUCT` pointing at the right PDPs, each with collection children. 32 children total.
  - `main-menu` `gid://shopify/Menu/113248698403` — `Shop` → `/collections` with 7 collection children, plus `On Sale`.
  - `sidebar-menu` `gid://shopify/Menu/113860214819` — 7 collection links, no children.
  - `footer` `gid://shopify/Menu/113248731171` and `multi-main` — 1 `on-sale` link each; leave alone.
- Live theme: `gid://shopify/OnlineStoreTheme/147480051882` ("Real Skin Care — Live").

---

### Task 1: The classifier library

**Files:**
- Create: `lib/collection-consolidation.js`
- Test: `tests/lib/collection-consolidation.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SURVIVORS` (a `Set<string>`), `classifyTarget(handle) -> string | null` (null means "survivor, do not touch"), and `buildRedirectPlan(collections) -> Array<{handle, id, kind, live, products, target}>` where `collections` is an array of `{handle, id, kind, live, products}`. Tasks 2 and 3 both consume these.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/collection-consolidation.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURVIVORS, classifyTarget, buildRedirectPlan } from '../../lib/collection-consolidation.js';

test('survivors classify as null so they are never redirected', () => {
  for (const h of ['non-toxic-body-lotion', 'foaming-hand-soap', 'all-products', 'on-sale']) {
    assert.equal(classifyTarget(h), null, `${h} must survive`);
  }
  assert.equal(SURVIVORS.size, 4);
});

test('lotion-family handles route to the lotion survivor', () => {
  for (const h of ['coconut-oil-lotion', 'vegan-body-lotion', 'coconut-body-cream',
                   'rose-lotion', 'moisturizing-body-cream', 'coconut-body-butter',
                   'coconut-oil-as-moisturizer']) {
    assert.equal(classifyTarget(h), '/collections/non-toxic-body-lotion', h);
  }
});

test('single-SKU categories route to their PDP, not to a collection', () => {
  assert.equal(classifyTarget('cinnamon-toothpaste'), '/products/coconut-oil-toothpaste');
  assert.equal(classifyTarget('sls-free-toothpaste'), '/products/coconut-oil-toothpaste');
  assert.equal(classifyTarget('vegan-deodorant'), '/products/coconut-oil-deodorant');
  assert.equal(classifyTarget('organic-lip-balm'), '/products/coconut-oil-lip-balm');
  assert.equal(classifyTarget('mens-natural-soap'), '/products/coconut-soap');
  assert.equal(classifyTarget('best-soap-for-tattoos'), '/products/coconut-soap');
});

test('hand-soap handles route to the hand-soap survivor, not to the bar-soap PDP', () => {
  assert.equal(classifyTarget('foaming-soap-dispenser'), '/collections/foaming-hand-soap');
});

test('toothpaste wins over soap when a handle could match both', () => {
  // 'sls' and 'mint' are toothpaste markers; ordering must not let a generic rule win first.
  assert.equal(classifyTarget('mint-toothpaste'), '/products/coconut-oil-toothpaste');
});

test('unclassifiable handles fall back to all-products rather than throwing', () => {
  assert.equal(classifyTarget('live-collection'), '/collections/all-products');
  assert.equal(classifyTarget('main-menu-3'), '/collections/all-products');
  assert.equal(classifyTarget('coconut-oil-products'), '/collections/all-products');
});

test('buildRedirectPlan omits survivors and keeps every other collection', () => {
  const input = [
    { handle: 'all-products', id: 1, kind: 'smart', live: true, products: 19 },
    { handle: 'vegan-deodorant', id: 2, kind: 'smart', live: true, products: 1 },
    { handle: 'coconut-body-butter', id: 3, kind: 'custom', live: false, products: 0 },
  ];
  const plan = buildRedirectPlan(input);
  assert.equal(plan.length, 2);
  assert.ok(!plan.some((r) => r.handle === 'all-products'));
  const deo = plan.find((r) => r.handle === 'vegan-deodorant');
  assert.equal(deo.target, '/products/coconut-oil-deodorant');
  assert.equal(deo.live, true);
});

test('buildRedirectPlan never emits a redirect whose source equals its target', () => {
  const plan = buildRedirectPlan([
    { handle: 'non-toxic-body-lotion', id: 9, kind: 'custom', live: true, products: 2 },
  ]);
  assert.deepEqual(plan, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/collection-consolidation.test.js`
Expected: FAIL — cannot find module `lib/collection-consolidation.js`.

- [ ] **Step 3: Implement**

Create `lib/collection-consolidation.js`:

```javascript
/**
 * Decide each collection's fate in the 2026-07-27 consolidation.
 *
 * The rule (see the spec): a collection exists only where a category holds 2+
 * distinct products. Single-product categories are PDP-only, so their
 * collections redirect to the product page rather than to another collection.
 *
 * Pure and network-free so the mapping is testable without touching Shopify.
 */

export const SURVIVORS = new Set([
  'non-toxic-body-lotion', // lotion: 2 SKUs
  'foaming-hand-soap',     // hand soap: 2 SKUs (dispenser + refill)
  'all-products',          // native catch-all
  'on-sale',               // merchandising, not a category
]);

const PDP = {
  toothpaste: '/products/coconut-oil-toothpaste',
  deodorant: '/products/coconut-oil-deodorant',
  lipBalm: '/products/coconut-oil-lip-balm',
  barSoap: '/products/coconut-soap',
};

const LOTION = '/collections/non-toxic-body-lotion';
const HAND_SOAP = '/collections/foaming-hand-soap';
const FALLBACK = '/collections/all-products';

/**
 * Returns the redirect target for a collection handle, or null if the handle
 * is a survivor and must not be touched.
 *
 * Order matters: the specific category markers are tested before the generic
 * 'soap' and 'lotion' families, so 'mint-toothpaste' does not fall into a
 * broader bucket first.
 */
export function classifyTarget(handle) {
  if (!handle) return FALLBACK;
  if (SURVIVORS.has(handle)) return null;
  if (/toothpaste|fluoride|sls|cinnamon|mint/.test(handle)) return PDP.toothpaste;
  if (/deodorant/.test(handle)) return PDP.deodorant;
  if (/lip-?balm|lip-moistur/.test(handle)) return PDP.lipBalm;
  if (/hand-soap|foaming|soap-dispenser|liquid-soap/.test(handle)) return HAND_SOAP;
  if (/soap|tattoo/.test(handle)) return PDP.barSoap;
  if (/lotion|moistur|cream|butter/.test(handle)) return LOTION;
  return FALLBACK;
}

/**
 * Expand a list of collections into the redirect plan. Survivors are dropped,
 * as is any row whose target would equal its own path — a self-redirect is a
 * loop, and Shopify will happily create one.
 */
export function buildRedirectPlan(collections) {
  const out = [];
  for (const c of collections || []) {
    const target = classifyTarget(c.handle);
    if (!target) continue;
    if (target === `/collections/${c.handle}`) continue;
    out.push({ ...c, target });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/collection-consolidation.test.js`
Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```bash
git add lib/collection-consolidation.js tests/lib/collection-consolidation.test.js
git commit -m "feat(collections): pure classifier for the consolidation redirect map

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The consolidation script

**Files:**
- Create: `scripts/consolidate-collections.mjs`
- Test: `tests/scripts/consolidate-collections.test.js`

**Interfaces:**
- Consumes: `buildRedirectPlan`, `SURVIVORS` from Task 1.
- Produces: `partitionByTargetHealth(plan, isLive) -> {ready, blocked}` exported from the script for testing, where `isLive` is an async `(path) => boolean`. Task 7 runs this script with `--apply`.

**Context:** `lib/shopify.js` already exports everything needed: `getCustomCollections({limit})`, `getSmartCollections({limit})`, `getCollectionProductCount(id)`, `updateCustomCollection(id, fields)`, `updateSmartCollection(id, fields)`, `createRedirect(path, target)`, `getRedirects({limit})`.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/consolidate-collections.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionByTargetHealth } from '../../scripts/consolidate-collections.mjs';

const plan = [
  { handle: 'vegan-deodorant', target: '/products/coconut-oil-deodorant' },
  { handle: 'rose-lotion', target: '/collections/non-toxic-body-lotion' },
  { handle: 'orphan', target: '/collections/does-not-exist' },
];

test('a target that is not live blocks its redirect instead of writing it', async () => {
  const isLive = async (p) => p !== '/collections/does-not-exist';
  const { ready, blocked } = await partitionByTargetHealth(plan, isLive);
  assert.equal(ready.length, 2);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].handle, 'orphan');
});

test('each distinct target is health-checked once, not once per source', async () => {
  const seen = [];
  const isLive = async (p) => { seen.push(p); return true; };
  const many = [
    { handle: 'a', target: '/collections/non-toxic-body-lotion' },
    { handle: 'b', target: '/collections/non-toxic-body-lotion' },
    { handle: 'c', target: '/collections/non-toxic-body-lotion' },
  ];
  await partitionByTargetHealth(many, isLive);
  assert.equal(seen.length, 1, 'target health must be cached per distinct target');
});

test('all targets dead means nothing is ready and nothing throws', async () => {
  const { ready, blocked } = await partitionByTargetHealth(plan, async () => false);
  assert.equal(ready.length, 0);
  assert.equal(blocked.length, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/consolidate-collections.test.js`
Expected: FAIL — cannot find module `scripts/consolidate-collections.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/consolidate-collections.mjs`:

```javascript
/**
 * Collection consolidation — unpublish + 301 every non-survivor.
 *
 * Dry-run by default. Pass --apply to mutate the live store.
 *
 * Usage:
 *   node scripts/consolidate-collections.mjs            # dry run, prints the plan
 *   node scripts/consolidate-collections.mjs --apply    # writes
 *   node scripts/consolidate-collections.mjs --json     # machine-readable plan
 */

import {
  getCustomCollections, getSmartCollections, getCollectionProductCount,
  updateCustomCollection, updateSmartCollection, createRedirect, getRedirects,
} from '../lib/shopify.js';
import { buildRedirectPlan } from '../lib/collection-consolidation.js';

const SITE = 'https://www.realskincare.com';

/**
 * Split the plan into redirects whose target is actually live and those whose
 * is not. Never redirect to an unpublished or missing target — a 301 into a 404
 * destroys the equity the redirect exists to preserve.
 *
 * Health is cached per distinct target: 84 sources share 7 targets, so an
 * uncached check would issue 84 requests for 7 answers.
 */
export async function partitionByTargetHealth(plan, isLive) {
  const cache = new Map();
  const ready = [];
  const blocked = [];
  for (const row of plan) {
    if (!cache.has(row.target)) cache.set(row.target, await isLive(row.target));
    (cache.get(row.target) ? ready : blocked).push(row);
  }
  return { ready, blocked };
}

async function targetIsLive(path) {
  try {
    const res = await fetch(`${SITE}${path}`, { method: 'HEAD', redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function loadCollections() {
  const [custom, smart] = await Promise.all([
    getCustomCollections({ limit: 250 }),
    getSmartCollections({ limit: 250 }),
  ]);
  const rows = [];
  for (const c of [...custom.map((x) => ({ ...x, kind: 'custom' })),
                   ...smart.map((x) => ({ ...x, kind: 'smart' }))]) {
    let products = 0;
    try { products = await getCollectionProductCount(c.id); } catch { products = -1; }
    rows.push({ handle: c.handle, id: c.id, kind: c.kind, live: Boolean(c.published_at), products });
  }
  return rows;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');

  const collections = await loadCollections();
  const plan = buildRedirectPlan(collections);
  const { ready, blocked } = await partitionByTargetHealth(plan, targetIsLive);

  const existing = new Set((await getRedirects({ limit: 250 })).map((r) => r.path));
  const toWrite = ready.filter((r) => !existing.has(`/collections/${r.handle}`));

  if (asJson) {
    console.log(JSON.stringify({ plan, ready, blocked, toWrite }, null, 1));
    return;
  }

  console.log(`\nCollection consolidation — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  collections: ${collections.length} (live ${collections.filter((c) => c.live).length})`);
  console.log(`  to redirect: ${plan.length}  ready: ${ready.length}  blocked: ${blocked.length}`);
  console.log(`  redirects already present: ${ready.length - toWrite.length}`);

  if (blocked.length) {
    console.log('\n  BLOCKED (target not returning 200 — not redirected):');
    for (const b of blocked) console.log(`    /collections/${b.handle} -> ${b.target}`);
  }

  console.log('\n  Plan:');
  for (const r of toWrite) {
    console.log(`    ${r.live ? 'LIVE ' : 'draft'} /collections/${r.handle} -> ${r.target}`);
  }

  if (!apply) {
    console.log('\n  Dry run: nothing written. Re-run with --apply.');
    return;
  }

  let unpublished = 0;
  let redirected = 0;
  for (const r of toWrite) {
    if (r.live) {
      const fields = { published: false };
      if (r.kind === 'custom') await updateCustomCollection(r.id, fields);
      else await updateSmartCollection(r.id, fields);
      unpublished++;
    }
    await createRedirect(`/collections/${r.handle}`, r.target);
    redirected++;
    console.log(`    ✓ ${r.handle} -> ${r.target}`);
  }
  console.log(`\n  Unpublished ${unpublished}, redirected ${redirected}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run tests, then a real dry run**

```bash
node --test tests/scripts/consolidate-collections.test.js
node scripts/consolidate-collections.mjs
```

Expected: 3/3 tests pass. The dry run reports **84 to redirect** and prints the plan. It must print `Dry run: nothing written`. Report the `ready` / `blocked` counts in your report — a non-zero `blocked` count is information the controller needs, not a failure.

- [ ] **Step 5: Commit**

```bash
git add scripts/consolidate-collections.mjs tests/scripts/consolidate-collections.test.js
git commit -m "feat(collections): consolidation script with dead-target guard, dry-run default

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Navigation rewrite

**Files:**
- Create: `scripts/update-navigation.mjs`
- Test: `tests/scripts/update-navigation.test.js`

**Interfaces:**
- Consumes: `SURVIVORS` from Task 1.
- Produces: `stripCollectionChildren(items) -> items` and `retargetToPdp(items, map) -> items`, both pure and exported for testing.

**Context:** `shopifyGraphQL(query, variables)` is exported from `lib/shopify.js`. Menu items come back as `{id, title, type, url, items}`. The `menuUpdate` mutation replaces a menu's whole item tree, so the script must send the full desired structure, not a patch.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/update-navigation.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCollectionChildren, retargetToPdp } from '../../scripts/update-navigation.mjs';

const header = [
  { id: 'gid://1', title: 'Lotion', type: 'PRODUCT', url: '/products/coconut-lotion', items: [
    { id: 'gid://11', title: 'Rose Lotion', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
    { id: 'gid://12', title: 'Unscented', type: 'COLLECTION', url: '/collections/unscented-lotion', items: [] },
  ] },
  { id: 'gid://2', title: 'Toothpaste', type: 'PRODUCT', url: '/products/coconut-oil-toothpaste', items: [
    { id: 'gid://21', title: 'Mint', type: 'COLLECTION', url: '/collections/mint-toothpaste', items: [] },
  ] },
];

test('stripCollectionChildren removes every child while preserving top-level items', () => {
  const out = stripCollectionChildren(header);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.url),
    ['/products/coconut-lotion', '/products/coconut-oil-toothpaste']);
  assert.ok(out.every((i) => (i.items || []).length === 0), 'no dropdowns may remain');
});

test('stripCollectionChildren keeps children that are not collections', () => {
  const mixed = [{ id: 'a', title: 'More', type: 'HTTP', url: '/pages/x', items: [
    { id: 'b', title: 'FAQ', type: 'PAGE', url: '/pages/faq', items: [] },
    { id: 'c', title: 'Rose', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
  ] }];
  const out = stripCollectionChildren(mixed);
  assert.equal(out[0].items.length, 1);
  assert.equal(out[0].items[0].url, '/pages/faq');
});

test('stripCollectionChildren preserves a child pointing at a survivor', () => {
  const m = [{ id: 'a', title: 'Shop', type: 'HTTP', url: '/collections', items: [
    { id: 'b', title: 'Hand Soap', type: 'COLLECTION', url: '/collections/foaming-hand-soap', items: [] },
    { id: 'c', title: 'Rose', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
  ] }];
  const out = stripCollectionChildren(m);
  assert.equal(out[0].items.length, 1);
  assert.equal(out[0].items[0].url, '/collections/foaming-hand-soap');
});

test('retargetToPdp rewrites mapped collection links and leaves others alone', () => {
  const sidebar = [
    { id: 's1', title: 'Deodorant', type: 'COLLECTION', url: '/collections/natural-deodorant', items: [] },
    { id: 's2', title: 'Hand Soap', type: 'COLLECTION', url: '/collections/foaming-hand-soap', items: [] },
  ];
  const out = retargetToPdp(sidebar, { '/collections/natural-deodorant': '/products/coconut-oil-deodorant' });
  assert.equal(out[0].url, '/products/coconut-oil-deodorant');
  assert.equal(out[0].type, 'PRODUCT');
  assert.equal(out[1].url, '/collections/foaming-hand-soap', 'survivor link untouched');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/update-navigation.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `scripts/update-navigation.mjs`:

```javascript
/**
 * Strip collection links out of the store's navigation.
 *
 * The header (`product-menu`) already links its 7 top-level items to the right
 * PDPs — the work is deleting their 32 collection children, not retargeting
 * anything. `main-menu`'s `Shop` item already points at /collections, which is
 * the Collections link; only its children go.
 *
 * Dry-run by default. Pass --apply to mutate.
 *
 * Usage:
 *   node scripts/update-navigation.mjs
 *   node scripts/update-navigation.mjs --apply
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { SURVIVORS } from '../lib/collection-consolidation.js';

const MENUS_QUERY = `{ menus(first: 20) { nodes { id handle title
  items { id title type url items { id title type url } } } } }`;

const MENU_UPDATE = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id handle }
    userErrors { field message }
  }
}`;

const isSurvivorUrl = (url) => {
  const m = /^\/collections\/([a-z0-9-]+)$/.exec(url || '');
  return Boolean(m && SURVIVORS.has(m[1]));
};

const isCollectionLink = (item) =>
  item?.type === 'COLLECTION' || /^\/collections\/[a-z0-9-]+$/.test(item?.url || '');

/** Drop every child that points at a non-survivor collection. */
export function stripCollectionChildren(items) {
  return (items || []).map((it) => ({
    ...it,
    items: (it.items || []).filter((c) => !isCollectionLink(c) || isSurvivorUrl(c.url)),
  }));
}

/** Rewrite collection links to PDPs using an explicit url->url map. */
export function retargetToPdp(items, map) {
  return (items || []).map((it) => {
    const to = map[it.url];
    if (!to) return it;
    return { ...it, url: to, type: 'PRODUCT' };
  });
}

// sidebar-menu mirrors the header's category->PDP mapping.
const SIDEBAR_MAP = {
  '/collections/coconut-oil-lotion': '/products/coconut-lotion',
  '/collections/body-cream': '/products/coconut-moisturizer',
  '/collections/natural-deodorant': '/products/coconut-oil-deodorant',
  '/collections/natural-toothpaste': '/products/coconut-oil-toothpaste',
  '/collections/natural-bar-soap': '/products/coconut-soap',
  '/collections/natural-lip-balm': '/products/coconut-oil-lip-balm',
  // foaming-hand-soap is a survivor and stays a collection link.
};

const toInput = (items) => items.map((it) => ({
  title: it.title,
  type: it.type,
  url: it.url,
  items: (it.items || []).map((c) => ({ title: c.title, type: c.type, url: c.url })),
}));

async function main() {
  const apply = process.argv.includes('--apply');
  const { menus } = await shopifyGraphQL(MENUS_QUERY);
  const byHandle = Object.fromEntries(menus.nodes.map((m) => [m.handle, m]));

  const changes = [];

  for (const handle of ['product-menu', 'main-menu']) {
    const m = byHandle[handle];
    if (!m) continue;
    const before = m.items.reduce((n, i) => n + (i.items || []).length, 0);
    const items = stripCollectionChildren(m.items);
    const after = items.reduce((n, i) => n + (i.items || []).length, 0);
    changes.push({ menu: m, items, note: `children ${before} -> ${after}` });
  }

  const sidebar = byHandle['sidebar-menu'];
  if (sidebar) {
    changes.push({
      menu: sidebar,
      items: retargetToPdp(sidebar.items, SIDEBAR_MAP),
      note: 'collection links retargeted to PDPs',
    });
  }

  console.log(`\nNavigation update — ${apply ? 'APPLY' : 'DRY RUN'}`);
  for (const ch of changes) {
    console.log(`\n  ${ch.menu.handle}: ${ch.note}`);
    for (const it of ch.items) {
      console.log(`    ${it.title} [${it.type}] ${it.url}`);
      for (const c of it.items || []) console.log(`        - ${c.title} ${c.url}`);
    }
  }

  if (!apply) {
    console.log('\n  Dry run: nothing written. Re-run with --apply.');
    return;
  }

  for (const ch of changes) {
    const res = await shopifyGraphQL(MENU_UPDATE, {
      id: ch.menu.id,
      title: ch.menu.title,
      handle: ch.menu.handle,
      items: toInput(ch.items),
    });
    const errs = res.menuUpdate.userErrors;
    if (errs?.length) throw new Error(`${ch.menu.handle}: ${errs.map((e) => e.message).join('; ')}`);
    console.log(`  ✓ ${ch.menu.handle} updated`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run tests, then a real dry run**

```bash
node --test tests/scripts/update-navigation.test.js
node scripts/update-navigation.mjs
```

Expected: 4/4 pass. The dry run must show `product-menu: children 32 -> 0`, `main-menu` children reduced to at most the survivor links, and `sidebar-menu` items pointing at `/products/...`. Paste that output into your report.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-navigation.mjs tests/scripts/update-navigation.test.js
git commit -m "feat(nav): strip collection links from menus via menuUpdate, dry-run default

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Survivor setup

**Files:**
- Create: `scripts/setup-survivor-collections.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks. Task 7 runs it with `--apply`.

**Context:** Three edits the spec requires on the surviving collections. `createSmartCollection` is NOT currently exported from `lib/shopify.js` — check for it, and if absent add it following the exact shape of the existing `createCustomCollection` (POST `/smart_collections.json` with a `smart_collection` body). Adding that export is part of this task.

- [ ] **Step 1: Verify what the library already exports**

```bash
grep -n "export async function create" lib/shopify.js
```

If `createSmartCollection` is missing, add it directly beneath `createCustomCollection`:

```javascript
export async function createSmartCollection(fields) {
  const data = await shopifyRequest('POST', '/smart_collections.json', {
    smart_collection: fields,
  });
  return data.smart_collection;
}
```

- [ ] **Step 2: Write the script**

Create `scripts/setup-survivor-collections.mjs`:

```javascript
/**
 * Prepare the surviving collections.
 *
 *   1. Create `sets-and-bundles` — a smart collection on `tag equals bundle`,
 *      so it maintains itself as bundles are added. Merchandising, not SEO:
 *      it is measured on AOV, not impressions.
 *   2. Add `foam-soap-refill-32oz` to `foaming-hand-soap`. Without this the
 *      collection holds one product and is a duplicate of its own PDP.
 *   3. Give `all-products` a description — its body_html is currently empty.
 *
 * Dry-run by default. Pass --apply to mutate.
 */

import {
  getSmartCollections, getCustomCollections, createSmartCollection,
  updateSmartCollection, updateCustomCollection, getProducts,
} from '../lib/shopify.js';

const ALL_PRODUCTS_BODY = `<p>Every Real Skin Care product in one place: coconut-oil body
lotion and body cream, fluoride-free toothpaste, aluminium-free deodorant, bar and foaming
hand soap, and lip balm. Small-batch, made for skin that reacts to fragrance, parabens and
harsh preservatives.</p>`;

async function main() {
  const apply = process.argv.includes('--apply');
  const log = (m) => console.log(`  ${m}`);
  console.log(`\nSurvivor setup — ${apply ? 'APPLY' : 'DRY RUN'}`);

  const smart = await getSmartCollections({ limit: 250 });
  const custom = await getCustomCollections({ limit: 250 });
  const all = [...smart, ...custom];

  // 1. sets-and-bundles
  const existing = all.find((c) => c.handle === 'sets-and-bundles');
  if (existing) {
    log(`sets-and-bundles already exists (id ${existing.id}) — skipping create`);
  } else if (apply) {
    const created = await createSmartCollection({
      title: 'Sets & Bundles',
      handle: 'sets-and-bundles',
      published: true,
      body_html: '<p>Multi-product sets and value packs — the cheapest way to switch your whole routine.</p>',
      rules: [{ column: 'tag', relation: 'equals', condition: 'bundle' }],
      disjunctive: false,
    });
    log(`created sets-and-bundles (id ${created.id})`);
  } else {
    log('would create sets-and-bundles (smart, tag equals bundle)');
  }

  // 2. refill into foaming-hand-soap
  const hs = all.find((c) => c.handle === 'foaming-hand-soap');
  const products = await getProducts({ limit: 250 });
  const refill = products.find((p) => p.handle === 'foam-soap-refill-32oz');
  if (!hs) log('WARN foaming-hand-soap not found');
  else if (!refill) log('WARN foam-soap-refill-32oz not found');
  else if (hs.rules) {
    log(`foaming-hand-soap is a SMART collection — cannot add a product directly.`);
    log(`  Its rule set decides membership; ensure the refill matches, or convert to custom.`);
    log(`  rules: ${JSON.stringify(hs.rules)}`);
  } else if (apply) {
    log('foaming-hand-soap is custom — add the refill via a collect in the admin or a Collect API call');
  } else {
    log('would add foam-soap-refill-32oz to foaming-hand-soap');
  }

  // 3. all-products description
  const ap = all.find((c) => c.handle === 'all-products');
  if (!ap) log('WARN all-products not found');
  else if ((ap.body_html || '').trim().length > 0) {
    log('all-products already has a description — leaving it alone');
  } else if (apply) {
    const fields = { body_html: ALL_PRODUCTS_BODY };
    if (ap.rules) await updateSmartCollection(ap.id, fields);
    else await updateCustomCollection(ap.id, fields);
    log('wrote all-products description');
  } else {
    log(`would write all-products description (${ALL_PRODUCTS_BODY.length} chars)`);
  }

  if (!apply) console.log('\n  Dry run: nothing written. Re-run with --apply.');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the dry run**

```bash
node scripts/setup-survivor-collections.mjs
```

Expected: three lines describing what would happen. **Report exactly what it says about `foaming-hand-soap`** — whether it is smart or custom decides how the refill gets added, and the spec's two-SKU justification for that survivor depends on it. If it is smart and its rules exclude the refill, say so plainly; that is a finding for the controller, not something to work around silently.

- [ ] **Step 4: Run the full suite and commit**

```bash
npm test
git add scripts/setup-survivor-collections.mjs lib/shopify.js
git commit -m "feat(collections): survivor setup — sets-and-bundles, refill, all-products copy

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The operating change

**Files:**
- Modify: `scheduler.js` (the `collection-creator` lines in the Sunday block)
- Modify: `lib/seo-opportunities.js:117-118`
- Modify: `CLAUDE.md` (Prime Directive section)
- Test: `tests/lib/seo-opportunities.test.js` (append, if it exists; otherwise create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This is the change that stops the sprawl regrowing.

**Context:** Without this task the cleanup is temporary — the fleet rebuilds collections within weeks. `scheduler.js` currently runs `collection-creator --from-opportunities --queue` and `--publish-approved` inside the Sunday block. `lib/seo-opportunities.js` sets `COLLECTION_BOOST = 1.6` above `PRODUCT_BOOST = 1.5`, which ranks "build another collection" above every other opportunity type.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/seo-opportunities.test.js` (create the file with the two imports if it does not exist):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('collections are no longer boosted above products in opportunity scoring', () => {
  const src = readFileSync(new URL('../../lib/seo-opportunities.js', import.meta.url), 'utf8');
  const coll = Number(/const COLLECTION_BOOST = ([0-9.]+)/.exec(src)[1]);
  const prod = Number(/const PRODUCT_BOOST = ([0-9.]+)/.exec(src)[1]);
  assert.ok(coll < prod,
    `COLLECTION_BOOST (${coll}) must be below PRODUCT_BOOST (${prod}) — collections are no longer the priority`);
});

test('the scheduler does not run collection-creator on a timer', () => {
  const src = readFileSync(new URL('../../scheduler.js', import.meta.url), 'utf8');
  const active = src.split('\n').filter((l) =>
    l.includes('collection-creator') && l.includes('runStep') && !l.trim().startsWith('//'));
  assert.deepEqual(active, [], `collection-creator must not be scheduled:\n${active.join('\n')}`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/lib/seo-opportunities.test.js`
Expected: FAIL on both — `COLLECTION_BOOST` is 1.6 vs 1.5, and two `runStep('collection-creator'...)` lines are active.

- [ ] **Step 3: Make the three changes**

In `lib/seo-opportunities.js`, replace the two constants:

```javascript
// Collections were boosted above products until 2026-07-27. With 9 distinct
// products the store had 62 collections, splitting ranking signal across
// near-duplicate pages that earned 51 clicks on 93,785 impressions. A collection
// now exists only where a category holds 2+ distinct products, so "build another
// collection" is no longer an opportunity type worth boosting.
// See docs/superpowers/specs/2026-07-27-collection-consolidation-design.md
const COLLECTION_BOOST = 1.0;
const PRODUCT_BOOST = 1.5;
```

In `scheduler.js`, comment out both `collection-creator` `runStep` lines, replacing them with a note in the style of the existing "Step 5e: (removed 2026-06-21)" block:

```javascript
// collection-creator: REMOVED FROM THE SCHEDULE 2026-07-27. Running it weekly
// produced 62 live collections for 9 distinct products — near-duplicate pages
// that split ranking signal and earned 51 clicks on 93,785 impressions in 90
// days. The agent remains in the repo for deliberate manual use; it no longer
// runs on a timer. A collection is now created only where a category holds 2+
// distinct products. See the 2026-07-27 collection-consolidation spec.
```

In `CLAUDE.md`, in the Prime Directive's bullet list, replace the "Commercial pages first" bullet's collection-creation guidance with:

```markdown
- **Commercial pages first, but do not multiply them.** Collections and PDPs convert; informational blog posts mostly don't. **A collection exists only where a category holds 2 or more distinct products — single-product categories are PDP-only, and a collection is never created to chase a keyword.** Chasing rankings with new collections produced 62 live collections for 9 products, which split ranking signal and earned 51 clicks on 93,785 impressions in 90 days. Optimize the pages that exist before creating another.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/lib/seo-opportunities.test.js
npm test
```

Expected: both new tests pass; suite otherwise at its baseline.

- [ ] **Step 5: Commit**

```bash
git add lib/seo-opportunities.js scheduler.js CLAUDE.md tests/lib/seo-opportunities.test.js
git commit -m "fix(seo): stop generating collections — unschedule creator, drop boost, update rule

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Brand-query metadata

**Files:**
- Create: `scripts/fix-brand-metadata.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed later. Task 7 runs it with `--apply`.

**Context:** The homepage ranks at average position 4.5 for `real skin care` / `realskincare` — 9,723 impressions and 170 clicks over 90 days — behind several of the store's own pages. Two causes are in the theme: the homepage `<title>` is `Coconut Oil Based Skin Care Products | Real Skin Care` (brand last), and its meta description is 352 characters and never names the brand. `/collections` inherits that same description verbatim.

Live theme: `gid://shopify/OnlineStoreTheme/147480051882`. `lib/shopify.js` exports `getThemeAsset(themeId, key)`, `listThemeAssets(themeId)`, `updateThemeAsset(themeId, key, value)` — note these take the **numeric** theme id, so pass `147480051882`.

- [ ] **Step 1: Locate where the title and description come from**

```bash
node -e "
import('/Users/seanfillmore/Code/Claude/lib/shopify.js').then(async (s) => {
  const assets = await s.listThemeAssets(147480051882);
  console.log(assets.map(a => a.key).filter(k => /theme.liquid|settings_data|list-collections/.test(k)).join('\n'));
});
"
```

Then read `layout/theme.liquid` and find the `<title>` and `<meta name=\"description\">` blocks. In most Shopify themes the homepage description falls back to `shop.description` when `page_description` is empty — in that case the fix is the shop's own SEO description in admin, not the theme. **Report which it is before changing anything.** Do not edit the theme if the source turns out to be a shop-level setting.

- [ ] **Step 2: Write the script for whichever source you found**

Create `scripts/fix-brand-metadata.mjs`. If the source is the theme, the script reads the asset, replaces only the two specific strings, and writes it back; if it is a shop setting, the script prints exactly what to change and where, because `write_content` does not cover shop SEO fields.

Required copy:

```javascript
const TITLE = 'Real Skin Care | Coconut Oil Skin Care for Sensitive Skin';
const DESCRIPTION =
  'Real Skin Care makes small-batch coconut-oil lotion, body cream, toothpaste, ' +
  'deodorant, soap and lip balm for skin that reacts to fragrance and harsh ' +
  'preservatives. Clean ingredients, no parabens.';
```

`DESCRIPTION` must be under 160 characters — assert that in the script and fail loudly if an edit pushes it over:

```javascript
if (DESCRIPTION.length > 160) throw new Error(`meta description is ${DESCRIPTION.length} chars, max 160`);
```

- [ ] **Step 3: Dry run and report**

```bash
node scripts/fix-brand-metadata.mjs
```

Report the current title, the current description length, and where each comes from. If the fix requires a manual admin change, say so explicitly — that is a finding, not a failure.

- [ ] **Step 4: Commit**

```bash
git add scripts/fix-brand-metadata.mjs
git commit -m "feat(seo): brand-first homepage title and meta description

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Live execution and verification

**GATE: do not start this task until the controller has reviewed the dry-run output from Tasks 2, 3, 4 and 6 and explicitly released it.** This task mutates the production store.

**Files:**
- Create: `data/reports/collection-consolidation/2026-07-27.md`

**Interfaces:**
- Consumes: all four scripts.
- Produces: the report and the live change.

- [ ] **Step 1: Apply in dependency order**

Targets must exist and be live before anything redirects into them:

```bash
node scripts/setup-survivor-collections.mjs --apply
node scripts/consolidate-collections.mjs --apply
node scripts/update-navigation.mjs --apply
node scripts/fix-brand-metadata.mjs --apply
```

- [ ] **Step 2: Verify the redirects resolve**

```bash
node -e "
import('/Users/seanfillmore/Code/Claude/lib/shopify.js').then(async (s) => {
  const rs = await s.getRedirects({ limit: 250 });
  const mine = rs.filter(r => r.path.startsWith('/collections/'));
  console.log('collection redirects:', mine.length);
  let bad = 0;
  for (const r of mine.slice(0, 250)) {
    const res = await fetch('https://www.realskincare.com' + r.target, { method: 'HEAD', redirect: 'manual' });
    if (res.status !== 200) { console.log('DEAD TARGET', r.path, '->', r.target, res.status); bad++; }
  }
  console.log(bad === 0 ? 'all targets 200' : bad + ' dead targets');
});
"
```

Expected: `all targets 200`. Any dead target is a stop-and-report.

- [ ] **Step 3: Verify the live collection count and navigation**

```bash
node -e "
import('/Users/seanfillmore/Code/Claude/lib/shopify.js').then(async (s) => {
  const c = await s.getCustomCollections({limit:250}), m = await s.getSmartCollections({limit:250});
  const live = [...c, ...m].filter(x => x.published_at);
  console.log('live collections:', live.length, '->', live.map(x=>x.handle).sort().join(', '));
});
"
node scripts/update-navigation.mjs   # dry run: must now report 0 collection children to remove
```

Expected: live collections are exactly `all-products`, `foaming-hand-soap`, `non-toxic-body-lotion`, `on-sale`, `sets-and-bundles`. The navigation dry run must report nothing left to change.

- [ ] **Step 4: Log the measurement windows**

For each survivor, call `logChangeEvent` from `lib/change-log.js` so `change-verdict` opens a 28-day window:

```javascript
import { logChangeEvent } from '../lib/change-log.js';
await logChangeEvent({
  url: '/collections/non-toxic-body-lotion',
  slug: 'collection-non-toxic-body-lotion',
  changeType: 'consolidation',
  category: 'seo',
  source: 'collection-consolidation',
  targetQuery: 'non toxic body lotion',
});
```

**Caveat to record in the report:** `change-log captureBaseline` reads GSC daily snapshots, which store only top pages, so a low-ranking collection gets an `impr=0` baseline. The trustworthy signal is rank-tracker on the query, not the change-log window.

- [ ] **Step 5: Write the report and commit**

Write `data/reports/collection-consolidation/2026-07-27.md` containing: collections before/after, redirects written, blocked redirects if any, navigation items removed per menu, and the 90-day baseline (93,785 collection impressions / 51 clicks) against which the 28-day result will be read.

```bash
git add data/reports/collection-consolidation/
git commit -m "data(collections): consolidation run report 2026-07-27

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

Checked against the spec:

| Spec requirement | Task |
|---|---|
| Workstream A — unpublish + 301 with dead-target guard | 2 |
| Draft collections still earning impressions get redirects | 2 (plan includes all 26 drafts) |
| Live collections with zero products get redirects | 2 |
| Workstream B — unschedule `collection-creator` | 5 |
| Workstream B — `COLLECTION_BOOST < PRODUCT_BOOST` | 5 |
| Workstream B — CLAUDE.md rule | 5 |
| Workstream C — `sets-and-bundles` smart collection on `tag equals bundle` | 4 |
| Workstream C — exclude the digital product | 4 (the `bundle` tag excludes it; verify in the dry run) |
| Workstream D — `all-products` description | 4 |
| Workstream E — brand-first title and <160 char meta | 6 |
| Workstream F — strip 32 header children | 3 |
| Workstream F — `main-menu` keeps `Shop` → `/collections` | 3 |
| Workstream F — `sidebar-menu` retargeted to PDPs | 3 |
| Workstream F — read nav from the API, never HTML | 3 (script queries `menus`) |
| Survivors get an above-the-fold PDP link | **GAP — see below** |
| `/collections` gets its own meta description | 6 (fold in with the homepage fix) |
| Measurement windows via `logChangeEvent` | 7 |

**Two gaps found and not silently dropped:**

1. **"Each surviving collection gets a prominent above-the-fold link to its primary PDP"** has no task. It is a theme/section change per collection, and it is the step that makes this "focus clicks on the PDP" rather than just fewer collections. It is deferred rather than dropped: the four survivors' descriptions are editable via `body_html` (Task 4 already writes one), so the cheapest version is a prominent link in each survivor's description. **Recommend adding it to Task 4 during execution rather than opening a seventh workstream.**
2. **Task 6 Step 1 may discover the homepage description is a shop-level setting**, not a theme asset, in which case `write_content` cannot reach it and it becomes a manual admin change. The plan instructs the implementer to report that rather than work around it.
