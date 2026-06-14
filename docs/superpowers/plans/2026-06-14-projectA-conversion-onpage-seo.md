# Project A — Conversion & On-Page SEO (article pipeline)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD, checkbox steps.

**Goal:** Stop the "impressions but no product clicks" leak and fix cheap on-page SEO misses in the article pipeline: (1) feature the most *relevant* linked product with stronger CTA copy, (2) complete Article + BreadcrumbList schema (dates, image, author URL, keywords), (3) descriptive keyword-informed hero-image alt text.

**Design decisions (made):**
- Product selection changes from *most-linked* to *most-relevant among linked* (token overlap of target keyword+title vs product title/handle/tags/type), tie-break by link count. No-linked-products behavior (publisher_block) is unchanged. We never inject a product the post doesn't link.
- Schema builders extracted to a pure, tested `lib/schema-builders.js`; schema-injector consumes it. datePublished/dateModified sourced from existing meta fields. BreadcrumbList = Home › News › <title>.
- Hero-image alt text generated deterministically from the creative-director scene + keyword in image-generator (`meta.image_alt`); publisher uses it for the Shopify image `alt`.
- Collection schema is OUT of scope here → Project C.

**Files:** `lib/schema-builders.js` (new), `lib/image-alt.js` (new), `agents/schema-injector/index.js`, `agents/featured-product-injector/index.js`, `agents/image-generator/index.js`, `agents/publisher/index.js`, tests under `tests/lib/`.

---

## Task 1 — lib/schema-builders.js (pure, enhanced Article + Breadcrumb)

**Files:** Create `lib/schema-builders.js`, `tests/lib/schema-builders.test.js`.

- [ ] **Step 1 — failing tests** `tests/lib/schema-builders.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildArticleSchema, buildBreadcrumb } from '../../lib/schema-builders.js';

const CONFIG = { name: 'Real Skin Care', url: 'https://www.realskincare.com', author: { name: 'Sean Fillmore', slug: 'sean-fillmore' } };

test('buildArticleSchema: core fields + author url + publisher', () => {
  const s = buildArticleSchema({ title: 'Best Natural Deodorant', meta_description: 'desc' }, 'https://www.realskincare.com/blogs/news/x', CONFIG);
  assert.equal(s['@type'], 'Article');
  assert.equal(s.headline, 'Best Natural Deodorant');
  assert.equal(s.author.name, 'Sean Fillmore');
  assert.equal(s.author.url, 'https://www.realskincare.com/pages/sean-fillmore');
  assert.equal(s.publisher.name, 'Real Skin Care');
  assert.equal(s.mainEntityOfPage, 'https://www.realskincare.com/blogs/news/x');
});

test('buildArticleSchema: datePublished/dateModified from meta', () => {
  const s = buildArticleSchema({ title: 'X', published_at: '2026-05-01T08:00:00Z', last_refreshed_at: '2026-06-10T08:00:00Z' }, 'u', CONFIG);
  assert.equal(s.datePublished, '2026-05-01T08:00:00Z');
  assert.equal(s.dateModified, '2026-06-10T08:00:00Z');
});

test('buildArticleSchema: dateModified falls back to datePublished', () => {
  const s = buildArticleSchema({ title: 'X', published_at: '2026-05-01T08:00:00Z' }, 'u', CONFIG);
  assert.equal(s.dateModified, '2026-05-01T08:00:00Z');
});

test('buildArticleSchema: image prefers shopify_image_url then image_url', () => {
  assert.deepEqual(buildArticleSchema({ title: 'X', shopify_image_url: 'a', image_url: 'b' }, 'u', CONFIG).image, ['a']);
  assert.deepEqual(buildArticleSchema({ title: 'X', image_url: 'b' }, 'u', CONFIG).image, ['b']);
  assert.equal('image' in buildArticleSchema({ title: 'X' }, 'u', CONFIG), false);
});

test('buildArticleSchema: keywords from target_keyword + semantic', () => {
  const s = buildArticleSchema({ title: 'X', target_keyword: 'natural deodorant', semantic_keywords: ['aluminum free', 'baking soda'] }, 'u', CONFIG);
  assert.equal(s.keywords, 'natural deodorant, aluminum free, baking soda');
});

test('buildArticleSchema: no datePublished key when no date available', () => {
  const s = buildArticleSchema({ title: 'X' }, 'u', CONFIG);
  assert.equal('datePublished' in s, false);
  assert.equal('dateModified' in s, false);
});

test('buildBreadcrumb: builds positioned ItemList', () => {
  const b = buildBreadcrumb([{ name: 'Home', url: 'https://x' }, { name: 'News', url: 'https://x/blogs/news' }, { name: 'Post', url: 'https://x/blogs/news/p' }]);
  assert.equal(b['@type'], 'BreadcrumbList');
  assert.equal(b.itemListElement.length, 3);
  assert.equal(b.itemListElement[0].position, 1);
  assert.equal(b.itemListElement[2].item, 'https://x/blogs/news/p');
  assert.equal(b.itemListElement[2].name, 'Post');
});
```

- [ ] **Step 2** — run, confirm FAIL.
- [ ] **Step 3** — implement `lib/schema-builders.js`:

```js
// lib/schema-builders.js
// Pure JSON-LD builders shared by schema-injector (articles) and the collection
// agents (Project C). No I/O.

export function buildArticleSchema(meta, url, config) {
  const author = config.author;
  const authorName = typeof author === 'object' ? author.name : author;
  const authorUrl = typeof author === 'object' ? `${config.url}/pages/${author.slug}` : config.url;
  const published = meta.published_at || meta.shopify_publish_at || meta.uploaded_at || null;
  const modified = meta.last_refreshed_at || meta.updated_at || meta.uploaded_at || published || null;
  const image = meta.shopify_image_url || meta.image_url || null;
  const kws = [meta.target_keyword, ...(meta.semantic_keywords || [])].filter(Boolean);

  const s = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: (meta.title || meta.recommended_title || '').slice(0, 110),
    description: (meta.meta_description || meta.summary || '').slice(0, 300),
    author: { '@type': 'Person', name: authorName, url: authorUrl },
    publisher: { '@type': 'Organization', name: config.name, url: config.url },
    url,
    mainEntityOfPage: url,
  };
  if (published) s.datePublished = published;
  if (modified) s.dateModified = modified;
  if (image) s.image = [image];
  if (kws.length) s.keywords = kws.join(', ');
  return s;
}

export function buildBreadcrumb(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items || []).map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}
```

- [ ] **Step 4** — run, all pass. **Step 5** — commit `feat(schema-builders): pure Article + BreadcrumbList builders with dates/image/keywords`.

---

## Task 2 — schema-injector uses the lib + adds breadcrumb

**Files:** `agents/schema-injector/index.js`.

- [ ] **Step 1** — Replace the local `buildArticleSchema` with an import from `../../lib/schema-builders.js` (also import `buildBreadcrumb`). Pass `config` to it: `buildArticleSchema(meta, url, config)`.
- [ ] **Step 2** — In the injection assembly (where schemas array is built, ~line 184-196), after the Article schema, push a BreadcrumbList:

```js
schemas.push(buildBreadcrumb([
  { name: 'Home', url: config.url },
  { name: 'News', url: `${config.url}/blogs/news` },
  { name: (meta.title || '').slice(0, 110), url },
]));
schemaTypes.push('BreadcrumbList');
```

- [ ] **Step 3** — Verify: run `node agents/schema-injector/index.js --slug <any existing slug with content.html>` (or `node --check`). Confirm output JSON-LD now includes `datePublished`/`dateModified` (when meta has them), `BreadcrumbList`, and no crash. If no slug handy, at minimum `node --check agents/schema-injector/index.js`.
- [ ] **Step 4** — commit `feat(schema-injector): full Article schema (dates/image/keywords) + BreadcrumbList via shared lib`.

---

## Task 3 — featured-product: relevance ranking + CTA copy

**Files:** `agents/featured-product-injector/index.js`, `tests/lib/featured-product.test.js` (or extend existing test file if present — check `tests/` for featured-product tests first).

- [ ] **Step 1 — failing tests** (new file `tests/lib/featured-product.test.js`):

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { rankLinkedProducts, buildCtaCopy, findPrimaryProduct } from '../../agents/featured-product-injector/index.js';

const PRODUCTS = [
  { handle: 'coconut-deodorant', title: 'Coconut Oil Deodorant', tags: ['deodorant', 'aluminum free'], product_type: 'Deodorant' },
  { handle: 'body-lotion', title: 'Non-Toxic Body Lotion', tags: ['lotion'], product_type: 'Lotion' },
];

test('rankLinkedProducts: picks the product most relevant to the keyword, not the most-linked', () => {
  const linked = [{ handle: 'body-lotion', count: 3 }, { handle: 'coconut-deodorant', count: 1 }];
  const ranked = rankLinkedProducts(linked, PRODUCTS, { keyword: 'best natural deodorant', title: 'Best Natural Deodorant for Men' });
  assert.equal(ranked[0].handle, 'coconut-deodorant'); // relevance beats link count
});

test('rankLinkedProducts: tie on relevance falls back to link count', () => {
  const linked = [{ handle: 'body-lotion', count: 1 }, { handle: 'coconut-deodorant', count: 5 }];
  const ranked = rankLinkedProducts(linked, PRODUCTS, { keyword: 'skincare', title: 'Skincare' }); // neither matches
  assert.equal(ranked[0].handle, 'coconut-deodorant'); // higher count wins the tie
});

test('rankLinkedProducts: empty linked → []', () => {
  assert.deepEqual(rankLinkedProducts([], PRODUCTS, { keyword: 'x', title: 'y' }), []);
});

test('buildCtaCopy: benefit headline + product-specific button text', () => {
  const c = buildCtaCopy({ product: { title: 'Coconot Oil Deodorant' }, keyword: 'natural deodorant' });
  assert.ok(c.headline.length > 0);
  assert.match(c.buttonText, /shop/i);
  assert.ok(c.buttonText.toLowerCase().includes('deodorant') || c.buttonText.toLowerCase().includes('shop'));
});

test('findPrimaryProduct still returns most-linked handle (kept for back-compat)', () => {
  assert.equal(findPrimaryProduct('<a href="/products/a"></a><a href="/products/a"></a><a href="/products/b"></a>'), 'a');
});
```

- [ ] **Step 2** — run, confirm FAIL.
- [ ] **Step 3** — implement. Add a helper that returns linked handles WITH counts, and the ranking:

```js
/** Linked product handles with link counts, descending. */
export function linkedProductCounts(html) {
  const counts = {};
  const re = /href="(?:https?:\/\/[^"]*)?\/products\/([^"/?#]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) counts[m[1]] = (counts[m[1]] || 0) + 1;
  return Object.entries(counts).map(([handle, count]) => ({ handle, count })).sort((a, b) => b.count - a.count);
}

function tokens(s) { return new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []); }

/** Rank linked products by relevance to keyword+title; tie-break by link count. */
export function rankLinkedProducts(linked, products, { keyword, title }) {
  const want = new Set([...tokens(keyword), ...tokens(title)]);
  const byHandle = new Map((products || []).map((p) => [p.handle, p]));
  const scored = (linked || []).map((l) => {
    const p = byHandle.get(l.handle) || {};
    const hay = tokens(`${p.title || ''} ${p.handle || l.handle} ${(p.tags || []).join(' ')} ${p.product_type || ''}`);
    let overlap = 0;
    for (const t of want) if (hay.has(t)) overlap++;
    return { ...l, product: p, relevance: overlap };
  });
  scored.sort((a, b) => (b.relevance - a.relevance) || (b.count - a.count));
  return scored;
}

/** Conversion-oriented CTA copy for the product card. */
export function buildCtaCopy({ product, keyword }) {
  const name = (product && product.title) || 'this pick';
  const kw = keyword || 'what you need';
  return {
    headline: `Our pick for ${kw}: ${name}`,
    buttonText: `Shop ${name}`.slice(0, 60),
  };
}
```

Then in the main flow: replace the `findPrimaryProduct(html)` selection with `linkedProductCounts(html)` → fetch product data for those handles → `rankLinkedProducts(...)` using the post's `meta.target_keyword` + `meta.title` → pick `ranked[0]`. If `ranked` is empty, keep the existing no-products `publisher_block` path. Use `buildCtaCopy` to set the card's headline/button text in the card HTML builder. (Adapt to the file's actual product-fetch + card-render functions; keep the Shopify/Judge.me fetch as-is, just feed it the relevance-chosen handle.)

- [ ] **Step 4** — run tests, all pass; `node --check agents/featured-product-injector/index.js`.
- [ ] **Step 5** — commit `feat(featured-product): relevance-ranked product selection + conversion CTA copy`.

---

## Task 4 — image alt text

**Files:** Create `lib/image-alt.js` + `tests/lib/image-alt.test.js`; modify `agents/image-generator/index.js`, `agents/publisher/index.js`.

- [ ] **Step 1 — failing tests** `tests/lib/image-alt.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImageAlt } from '../../lib/image-alt.js';

test('buildImageAlt: uses scene description, keyword-anchored, under 125 chars', () => {
  const alt = buildImageAlt({ keyword: 'natural deodorant', title: 'Best Natural Deodorant', scene: 'A coconut oil deodorant stick on a bright bathroom vanity with eucalyptus' });
  assert.ok(alt.length > 0 && alt.length <= 125);
  assert.match(alt.toLowerCase(), /deodorant/);
});

test('buildImageAlt: falls back to keyword + title when no scene', () => {
  const alt = buildImageAlt({ keyword: 'natural lip balm', title: 'Best Lip Balm' });
  assert.ok(alt.toLowerCase().includes('lip balm'));
  assert.ok(alt.length <= 125);
});

test('buildImageAlt: empty everything → safe non-empty string', () => {
  const alt = buildImageAlt({});
  assert.equal(typeof alt, 'string');
});
```

- [ ] **Step 2** — run, confirm FAIL.
- [ ] **Step 3** — implement `lib/image-alt.js`:

```js
// lib/image-alt.js
// Build descriptive, keyword-anchored alt text for a hero image. Deterministic
// (no extra LLM call) — derived from the creative-director scene + target keyword.

export function buildImageAlt({ keyword, title, scene } = {}) {
  const kw = (keyword || title || 'product').trim();
  let base = (scene || '').replace(/\s+/g, ' ').trim();
  if (base) {
    // Ensure the keyword is represented; prepend if the scene omits it.
    if (kw && !base.toLowerCase().includes(kw.toLowerCase().split(' ')[0])) base = `${kw} — ${base}`;
  } else {
    base = title ? `${kw}: ${title}` : kw;
  }
  return base.length <= 125 ? base : base.slice(0, 122).replace(/\s+\S*$/, '') + '…';
}
```

- [ ] **Step 4** — run tests, all pass.
- [ ] **Step 5** — In `agents/image-generator/index.js`: import `buildImageAlt`; where it finalizes metadata (near `meta.image_path = ...`, ~line 1028), set `meta.image_alt = buildImageAlt({ keyword: meta.target_keyword, title: meta.title, scene: <the creative-director scene/description variable in scope, e.g. review.scene or finalPrompt> })`. Use the real scene variable available there (prefer the CD scene description; fall back to nothing → helper handles it).
- [ ] **Step 6** — In `agents/publisher/index.js`: change both `alt: meta.title` occurrences (lines ~207 and ~216) to `alt: meta.image_alt || meta.title`.
- [ ] **Step 7** — `node --check` both agents. Commit `feat(images): descriptive keyword-anchored hero-image alt text`.

---

## Final
- [ ] Run all new tests: `node --test tests/lib/schema-builders.test.js tests/lib/featured-product.test.js tests/lib/image-alt.test.js`
- [ ] One code review of the diff (spec + quality), fix issues.
- [ ] PR `feature/conversion-onpage-seo` → main.
