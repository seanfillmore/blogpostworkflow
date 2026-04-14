# LLM Optimization Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three independent agents that improve LLM citation visibility: rebuild legacy blog posts through the full pipeline, generate a curated llms.txt for LLM crawlers, and flag vague product copy for review-sourced rewrites.

**Architecture:** Each agent is a standalone Node.js script in `agents/`. All integrate with the existing performance-queue approval system where applicable and run weekly via the scheduler. No shared state between the three features.

**Tech Stack:** Node.js ES modules, Shopify Admin REST API, DataForSEO API, Google Search Console API, Judge.me API, Anthropic Claude API

---

## Phase 1: Legacy Post Rebuilder

### Task 1: Create the legacy-rebuilder agent

**Files:**
- Create: `agents/legacy-rebuilder/index.js`

- [ ] **Step 1: Create the agent directory**

```bash
mkdir -p agents/legacy-rebuilder
```

- [ ] **Step 2: Write the agent**

Create `agents/legacy-rebuilder/index.js`:

```js
/**
 * Legacy Post Rebuilder
 *
 * Identifies blog posts that lack FAQ schema (a proxy for "built before the
 * current pipeline existed") and reruns them through the full content
 * pipeline: research → write → image → answer-first → featured-product →
 * schema → editor → publish as article update.
 *
 * Usage:
 *   node agents/legacy-rebuilder/index.js                    # list legacy posts (dry run)
 *   node agents/legacy-rebuilder/index.js <slug> --apply     # rebuild one post
 *   node agents/legacy-rebuilder/index.js --limit 3 --apply  # rebuild N posts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getContentPath, getPostMeta, getMetaPath } from '../../lib/posts.js';
import { getArticle, updateArticle, getBlogs } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BACKUPS_DIR = join(ROOT, 'data', 'backups', 'legacy-rebuild');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const slugArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');

function isLegacy(slug) {
  const p = getContentPath(slug);
  if (!existsSync(p)) return false;
  const html = readFileSync(p, 'utf8');
  return !html.includes('FAQPage');
}

function findLegacyPosts() {
  return listAllSlugs()
    .filter((slug) => isLegacy(slug))
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter((p) => p.meta && p.meta.shopify_article_id);
}

function run(cmd, label) {
  console.log(`  > ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    console.error(`  ✗ ${label} failed`);
    return false;
  }
}

async function rebuildPost(slug) {
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for ${slug}`);
  if (!meta.shopify_article_id || !meta.shopify_blog_id) {
    throw new Error(`Missing shopify_article_id or shopify_blog_id for ${slug}`);
  }
  const keyword = meta.target_keyword || meta.title;
  if (!keyword) throw new Error(`No target_keyword for ${slug}`);

  console.log(`\nRebuilding: ${slug}`);
  console.log(`  Keyword: ${keyword}`);
  console.log(`  Article ID: ${meta.shopify_article_id}`);

  // Backup original body_html from Shopify (live version, not local)
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const liveArticle = await getArticle(meta.shopify_blog_id, meta.shopify_article_id);
  const backupPath = join(BACKUPS_DIR, `${slug}.${stamp}.html`);
  writeFileSync(backupPath, liveArticle.body_html || '');
  console.log(`  Backup saved: ${backupPath}`);

  // Pipeline steps
  if (!run(`node agents/content-researcher/index.js "${keyword}"`, `research: ${keyword}`)) return false;
  if (!run(`node agents/blog-post-writer/index.js data/briefs/${slug}.json`, `write: ${slug}`)) return false;

  const imagePath = join(ROOT, 'data', 'images', `${slug}.webp`);
  if (!existsSync(imagePath) && !existsSync(imagePath.replace('.webp', '.png'))) {
    if (!run(`node agents/image-generator/index.js data/posts/${slug}.json`, `image: ${slug}`)) return false;
  }

  run(`node agents/answer-first-rewriter/index.js ${slug} --apply`, `answer-first: ${slug}`);
  run(`node agents/featured-product-injector/index.js --handle ${slug}`, `featured-product: ${slug}`);
  run(`node agents/schema-injector/index.js --slug ${slug} --apply`, `schema: ${slug}`);

  if (!run(`node agents/editor/index.js ${getContentPath(slug)}`, `editor: ${slug}`)) {
    console.error(`  ⛔ Editor failed — aborting rebuild, original post untouched on Shopify`);
    return false;
  }

  // Push to Shopify as an update (same article_id)
  const rebuiltHtml = readFileSync(getContentPath(slug), 'utf8');
  await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { body_html: rebuiltHtml });
  console.log(`  ✓ Published to Shopify (article_id: ${meta.shopify_article_id})`);

  // Stamp metadata
  const updatedMeta = { ...getPostMeta(slug), rebuilt_at: new Date().toISOString() };
  writeFileSync(getMetaPath(slug), JSON.stringify(updatedMeta, null, 2));

  return true;
}

async function main() {
  console.log('\nLegacy Post Rebuilder\n');

  const legacy = findLegacyPosts();
  console.log(`Found ${legacy.length} legacy post(s) missing FAQ schema.`);

  if (!apply) {
    console.log('\nDry run — no changes. Pass --apply to rebuild.');
    for (const p of legacy.slice(0, 20)) {
      console.log(`  - ${p.slug} (${p.meta.target_keyword || p.meta.title})`);
    }
    if (legacy.length > 20) console.log(`  ... and ${legacy.length - 20} more`);
    return;
  }

  // Filter by single slug or limit
  let toRebuild = legacy;
  if (slugArg) toRebuild = legacy.filter((p) => p.slug === slugArg);
  else if (limit) toRebuild = legacy.slice(0, limit);

  console.log(`\nRebuilding ${toRebuild.length} post(s)...`);

  let succeeded = 0;
  let failed = 0;
  for (const p of toRebuild) {
    try {
      const ok = await rebuildPost(p.slug);
      if (ok) succeeded++;
      else failed++;
    } catch (err) {
      console.error(`  ✗ ${p.slug}: ${err.message}`);
      failed++;
    }
  }

  await notify({
    subject: `Legacy Rebuilder: ${succeeded} rebuilt, ${failed} failed`,
    body: `Rebuilt ${succeeded} post(s), ${failed} failed. ${legacy.length - succeeded} legacy posts remain.`,
    status: failed > 0 ? 'warning' : 'success',
  });

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
}

main().catch((err) => {
  notify({ subject: 'Legacy Rebuilder failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 3: Test dry-run locally**

```bash
node agents/legacy-rebuilder/index.js
```

Expected: Lists ~80 legacy posts.

- [ ] **Step 4: Commit**

```bash
git add agents/legacy-rebuilder/index.js
git commit -m "feat: add legacy post rebuilder — rebuild posts missing FAQ schema"
```

---

### Task 2: Add legacy-rebuilder to weekly scheduler

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add the scheduler step**

In `scheduler.js`, find the weekly Sunday section (around line 196). After the AI citation tracker step, add:

```js
  // Step 8c: rebuild legacy posts (missing FAQ schema) — max 3 per week
  runStep('legacy-rebuilder', `"${NODE}" agents/legacy-rebuilder/index.js --limit 3 --apply${dryFlag}`, { indent: '    ' });
```

- [ ] **Step 2: Commit**

```bash
git add scheduler.js
git commit -m "feat: add legacy-rebuilder to weekly scheduler (3 posts/week)"
```

---

## Phase 2: llms.txt Generator

### Task 3: Create the llms-txt-generator agent

**Files:**
- Create: `agents/llms-txt-generator/index.js`

- [ ] **Step 1: Create the agent directory and file**

```bash
mkdir -p agents/llms-txt-generator
```

Create `agents/llms-txt-generator/index.js`:

```js
/**
 * llms.txt Generator
 *
 * Builds a curated llms.txt file listing the site's best content for LLM
 * crawlers (Perplexity, Anthropic, etc.). Deploys to Shopify as a page
 * at /pages/llms-txt with a redirect from /llms.txt.
 *
 * Selection:
 *   - Blog posts with ≥100 GSC impressions in last 90 days
 *   - All active products
 *   - Top 10 collections by organic traffic (DataForSEO)
 *
 * Usage:
 *   node agents/llms-txt-generator/index.js              # generate + deploy
 *   node agents/llms-txt-generator/index.js --dry-run    # generate only
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getProducts, getCustomCollections, getSmartCollections,
  getPages, createPage, updatePage,
  getRedirects, createRedirect,
} from '../../lib/shopify.js';
import { getRankedKeywords } from '../../lib/dataforseo.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(ROOT, 'data', 'reports', 'llms-txt');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// GSC is optional
let gsc = null;
async function loadGSC() {
  try { gsc = await import('../../lib/gsc.js'); } catch { /* skip */ }
}

function truncate(text, max = 160) {
  if (!text) return '';
  const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/\s\S*$/, '') + '…';
}

async function selectBlogPosts() {
  const selected = [];
  const slugs = listAllSlugs();
  for (const slug of slugs) {
    const meta = getPostMeta(slug);
    if (!meta || !meta.shopify_article_id) continue;

    const url = `${config.url}/blogs/${meta.shopify_blog_handle || 'news'}/${meta.shopify_handle || slug}`;

    let impressions = 0;
    if (gsc) {
      try {
        const perf = await gsc.getPagePerformance(url, 90);
        impressions = perf?.impressions ?? 0;
      } catch { /* skip */ }
    }

    if (impressions >= 100) {
      selected.push({
        url,
        title: meta.title || slug.replace(/-/g, ' '),
        description: truncate(meta.meta_description || meta.summary || ''),
        impressions,
      });
    }
  }
  return selected.sort((a, b) => b.impressions - a.impressions);
}

async function selectProducts() {
  const products = await getProducts();
  return products
    .filter((p) => p.status === 'active')
    .map((p) => ({
      url: `${config.url}/products/${p.handle}`,
      title: p.title,
      description: truncate(p.body_html || ''),
    }));
}

async function selectTopCollections() {
  const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let rankedKeywords = [];
  try {
    rankedKeywords = await getRankedKeywords(domain, { limit: 500 });
  } catch { /* skip */ }

  // Aggregate traffic by collection URL
  const collectionTraffic = new Map();
  for (const kw of rankedKeywords) {
    const path = kw.url || '';
    if (!path.startsWith('/collections/')) continue;
    collectionTraffic.set(path, (collectionTraffic.get(path) || 0) + (kw.traffic || 0));
  }

  // Fetch all collections for metadata
  const [custom, smart] = await Promise.all([getCustomCollections(), getSmartCollections()]);
  const allCollections = [...custom, ...smart];
  const byHandle = new Map(allCollections.map((c) => [c.handle, c]));

  const topTen = Array.from(collectionTraffic.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path]) => {
      const handle = path.replace('/collections/', '');
      const coll = byHandle.get(handle);
      if (!coll) return null;
      return {
        url: `${config.url}${path}`,
        title: coll.title,
        description: truncate(coll.body_html || ''),
      };
    })
    .filter(Boolean);

  return topTen;
}

function buildLlmsTxt({ blogPosts, products, collections }) {
  const lines = [];
  lines.push(`# ${config.name}`);
  lines.push('');
  lines.push(`> Natural coconut-based skincare and personal care products handcrafted with clean ingredients.`);
  lines.push('');

  if (products.length > 0) {
    lines.push('## Products');
    lines.push('');
    for (const p of products) {
      lines.push(`- [${p.title}](${p.url})${p.description ? ': ' + p.description : ''}`);
    }
    lines.push('');
  }

  if (collections.length > 0) {
    lines.push('## Collections');
    lines.push('');
    for (const c of collections) {
      lines.push(`- [${c.title}](${c.url})${c.description ? ': ' + c.description : ''}`);
    }
    lines.push('');
  }

  if (blogPosts.length > 0) {
    lines.push('## Blog Posts');
    lines.push('');
    for (const b of blogPosts) {
      lines.push(`- [${b.title}](${b.url})${b.description ? ': ' + b.description : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function deployToShopify(content) {
  // Find existing /pages/llms-txt or create it
  const pages = await getPages();
  const existing = pages.find((p) => p.handle === 'llms-txt');
  const body_html = `<pre style="white-space:pre-wrap;font-family:monospace">${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;

  let pageId;
  if (existing) {
    await updatePage(existing.id, { title: 'llms.txt', body_html });
    pageId = existing.id;
    console.log(`  Updated page /pages/llms-txt (id: ${pageId})`);
  } else {
    const created = await createPage({ title: 'llms.txt', handle: 'llms-txt', body_html, published: true });
    pageId = created.id;
    console.log(`  Created page /pages/llms-txt (id: ${pageId})`);
  }

  // Ensure /llms.txt redirect exists
  const redirects = await getRedirects({ path: '/llms.txt' });
  const hasRedirect = redirects.some((r) => r.path === '/llms.txt');
  if (!hasRedirect) {
    await createRedirect('/llms.txt', '/pages/llms-txt');
    console.log('  Created redirect /llms.txt → /pages/llms-txt');
  } else {
    console.log('  Redirect /llms.txt already exists');
  }
}

async function main() {
  console.log('\nllms.txt Generator\n');

  await loadGSC();

  console.log('  Selecting content...');
  const [blogPosts, products, collections] = await Promise.all([
    selectBlogPosts(),
    selectProducts(),
    selectTopCollections(),
  ]);
  console.log(`  Blog posts (≥100 impressions): ${blogPosts.length}`);
  console.log(`  Products (active): ${products.length}`);
  console.log(`  Top collections by traffic: ${collections.length}`);

  const content = buildLlmsTxt({ blogPosts, products, collections });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const localPath = join(OUTPUT_DIR, 'llms.txt');
  writeFileSync(localPath, content);
  console.log(`\n  Saved: ${localPath}`);

  if (dryRun) {
    console.log('\nDry run — no Shopify changes.');
    return;
  }

  console.log('\n  Deploying to Shopify...');
  await deployToShopify(content);

  await notify({
    subject: `llms.txt generated: ${blogPosts.length + products.length + collections.length} items`,
    body: `Blog: ${blogPosts.length}, Products: ${products.length}, Collections: ${collections.length}`,
    status: 'success',
  });

  console.log('\nDone.');
}

main().catch((err) => {
  notify({ subject: 'llms.txt Generator failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Test dry-run locally**

```bash
node agents/llms-txt-generator/index.js --dry-run
```

Expected: Lists counts, saves `data/reports/llms-txt/llms.txt`. No Shopify changes.

- [ ] **Step 3: Commit**

```bash
git add agents/llms-txt-generator/index.js
git commit -m "feat: add llms.txt generator for LLM crawler discovery"
```

---

### Task 4: Add llms-txt-generator to weekly scheduler

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add the step**

After the legacy-rebuilder step in `scheduler.js`:

```js
  // Step 8d: generate llms.txt for LLM crawlers
  runStep('llms-txt-generator', `"${NODE}" agents/llms-txt-generator/index.js`, { indent: '    ' });
```

- [ ] **Step 2: Commit**

```bash
git add scheduler.js
git commit -m "feat: add llms-txt-generator to weekly scheduler"
```

---

## Phase 3: Specificity Audit

### Task 5: Create the flagged vocabulary config

**Files:**
- Create: `config/specificity-flags.json`

- [ ] **Step 1: Create the config**

```json
{
  "vague_phrases": [
    "premium", "luxurious", "luxury", "crafted with", "crafted from",
    "high-quality", "high quality", "quality ingredients",
    "carefully selected", "carefully chosen", "finest",
    "artisanal", "handcrafted with love", "made with love",
    "revolutionary", "cutting-edge", "state-of-the-art", "best-in-class",
    "transforms your skin", "works wonders", "miraculous", "magical",
    "nourishes deeply", "deeply moisturizing"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add config/specificity-flags.json
git commit -m "feat: add flagged vocabulary for specificity audit"
```

---

### Task 6: Create the specificity-audit agent

**Files:**
- Create: `agents/specificity-audit/index.js`

- [ ] **Step 1: Create the agent directory and file**

```bash
mkdir -p agents/specificity-audit
```

Create `agents/specificity-audit/index.js`:

```js
/**
 * Specificity Audit
 *
 * Scans product descriptions for vague marketing language, fetches Judge.me
 * reviews for context, and asks Claude to produce a rewritten description
 * sourced from concrete review claims. Results queued for approval via
 * the performance queue.
 *
 * Usage:
 *   node agents/specificity-audit/index.js              # audit + queue
 *   node agents/specificity-audit/index.js --dry-run    # audit only
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProducts } from '../../lib/shopify.js';
import { resolveExternalId } from '../../lib/judgeme.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const flags = JSON.parse(readFileSync(join(ROOT, 'config', 'specificity-flags.json'), 'utf8'));

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const SHOP_DOMAIN = env.SHOPIFY_STORE;
const JUDGEME_TOKEN = env.JUDGEME_API_TOKEN;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

function findFlaggedPhrases(html) {
  const text = (html || '').toLowerCase().replace(/<[^>]+>/g, ' ');
  const found = [];
  for (const phrase of flags.vague_phrases) {
    const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) found.push(phrase);
  }
  return found;
}

async function fetchReviews(handle) {
  if (!SHOP_DOMAIN || !JUDGEME_TOKEN) return [];
  try {
    const externalId = await resolveExternalId(handle, SHOP_DOMAIN, JUDGEME_TOKEN);
    if (!externalId) return [];
    const url = `https://judge.me/api/v1/reviews?shop_domain=${SHOP_DOMAIN}&api_token=${JUDGEME_TOKEN}&product_id=${externalId}&per_page=20`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.reviews || [])
      .filter((r) => r.body && r.body.length > 40 && r.rating >= 4)
      .map((r) => r.body)
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function rewriteDescription(product, flaggedPhrases, reviews) {
  const prompt = `You are rewriting a product description for Real Skin Care, a natural skincare brand.

CURRENT PRODUCT: ${product.title}
CURRENT DESCRIPTION (HTML):
${product.body_html}

FLAGGED VAGUE PHRASES TO REPLACE:
${flaggedPhrases.join(', ')}

CUSTOMER REVIEWS (SOURCE OF SPECIFIC CLAIMS):
${reviews.map((r, i) => `${i + 1}. ${r}`).join('\n\n')}

Rewrite the description with these rules:
1. Replace every vague flagged phrase with a specific, concrete claim — use actual language and observations from the customer reviews above.
2. Keep the same overall length and structure (headings, lists, paragraphs).
3. Preserve brand voice: warm, conversational, 8th-grade reading level. Short sentences. No em-dashes.
4. Keep any existing <h2>, <h3>, <ul>, <li> tags. Keep ingredient lists exactly as they are.
5. Do NOT invent claims not supported by the reviews.
6. Do NOT mention competitor brands.

Output ONLY the rewritten HTML body. No explanation, no code fence, no preamble.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('Rewrite truncated at max_tokens');
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function main() {
  console.log('\nSpecificity Audit\n');

  const products = await getProducts();
  console.log(`  Fetched ${products.length} product(s)`);

  const flagged = [];
  for (const p of products) {
    if (p.status !== 'active') continue;
    const phrases = findFlaggedPhrases(p.body_html);
    if (phrases.length > 0) flagged.push({ product: p, phrases });
  }
  console.log(`  Flagged: ${flagged.length} product(s) with vague language\n`);

  if (flagged.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  mkdirSync(QUEUE_DIR, { recursive: true });
  let queued = 0;
  for (const { product, phrases } of flagged) {
    console.log(`  [${product.handle}] flagged: ${phrases.join(', ')}`);

    const reviews = await fetchReviews(product.handle);
    if (reviews.length < 2) {
      console.log(`    Skipped — only ${reviews.length} quality review(s), need 2+ for review-sourced rewrite`);
      continue;
    }

    if (dryRun) {
      console.log(`    Would rewrite using ${reviews.length} review(s)`);
      continue;
    }

    let newHtml;
    try {
      newHtml = await rewriteDescription(product, phrases, reviews);
    } catch (err) {
      console.log(`    Rewrite failed: ${err.message}`);
      continue;
    }

    const queueItem = {
      slug: product.handle,
      title: `Product Rewrite: ${product.title}`,
      trigger: 'product-description-rewrite',
      resource_type: 'product',
      resource_id: product.id,
      current_body_html: product.body_html,
      proposed_body_html: newHtml,
      flagged_phrases: phrases,
      review_sample_count: reviews.length,
      signal_source: { type: 'specificity-audit', reviews_analyzed: reviews.length },
      summary: {
        what_changed: `Rewrote description replacing ${phrases.length} vague phrase(s) with claims sourced from ${reviews.length} customer review(s).`,
        why: 'LLMs cite concrete claims, not marketing abstractions. Reviewers describe products more specifically than marketing copy.',
        projected_impact: 'Increases citation likelihood in ChatGPT/Perplexity responses to product queries.',
      },
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    writeFileSync(join(QUEUE_DIR, `${product.handle}.json`), JSON.stringify(queueItem, null, 2));
    console.log(`    Queued rewrite (${phrases.length} phrases → ${reviews.length} reviews)`);
    queued++;
  }

  await notify({
    subject: `Specificity Audit: ${queued} product rewrites queued`,
    body: `Flagged ${flagged.length} products, queued ${queued} rewrites for approval.`,
    status: 'success',
  });

  console.log(`\nDone. ${queued} rewrite(s) queued for approval.`);
}

main().catch((err) => {
  notify({ subject: 'Specificity Audit failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Test dry-run locally**

```bash
node agents/specificity-audit/index.js --dry-run
```

Expected: Lists flagged products with their vague phrases. No queue writes.

- [ ] **Step 3: Commit**

```bash
git add agents/specificity-audit/index.js
git commit -m "feat: add specificity audit — flag vague product copy, queue rewrites"
```

---

### Task 7: Extend performance queue approve handler for product-description-rewrite

**Files:**
- Modify: `agents/dashboard/routes/performance-queue.js`

- [ ] **Step 1: Add updateProduct to imports**

At the top of `agents/dashboard/routes/performance-queue.js`, update the Shopify import to include `updateProduct`. Find:

```js
import { getBlogs, updateArticle, getProducts, createCustomCollection, upsertMetafield } from '../../../lib/shopify.js';
```

Replace with:

```js
import { getBlogs, updateArticle, getProducts, updateProduct, createCustomCollection, upsertMetafield } from '../../../lib/shopify.js';
```

- [ ] **Step 2: Add publishProductDescriptionRewrite function**

In `agents/dashboard/routes/performance-queue.js`, after the `publishPageMetaRewrite` function (around line 80), add:

```js
async function publishProductDescriptionRewrite(item) {
  if (!item.resource_id) throw new Error('No resource_id for product');
  if (!item.proposed_body_html) throw new Error('No proposed_body_html');
  await updateProduct(item.resource_id, { body_html: item.proposed_body_html });
}
```

- [ ] **Step 3: Wire the new trigger into the approve handler**

Find the approve handler `try` block (around line 118):

```js
      try {
        if (item.trigger === 'collection-gap') {
          await publishCollectionGap(item);
        } else if (item.trigger === 'page-meta-rewrite') {
          await publishPageMetaRewrite(item);
        } else {
          await publishBlogRefresh(item, ctx);
        }
      } catch (err) {
```

Replace with:

```js
      try {
        if (item.trigger === 'collection-gap') {
          await publishCollectionGap(item);
        } else if (item.trigger === 'page-meta-rewrite') {
          await publishPageMetaRewrite(item);
        } else if (item.trigger === 'product-description-rewrite') {
          await publishProductDescriptionRewrite(item);
        } else {
          await publishBlogRefresh(item, ctx);
        }
      } catch (err) {
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/routes/performance-queue.js
git commit -m "feat: performance queue handles product-description-rewrite trigger"
```

---

### Task 8: Add specificity-audit to weekly scheduler

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add the step**

After the llms-txt-generator step in `scheduler.js`:

```js
  // Step 8e: specificity audit — queue product description rewrites
  runStep('specificity-audit', `"${NODE}" agents/specificity-audit/index.js`, { indent: '    ' });
```

- [ ] **Step 2: Commit**

```bash
git add scheduler.js
git commit -m "feat: add specificity-audit to weekly scheduler"
```

---

## Phase 4: Test and Deploy

### Task 9: Test all three agents on the server

- [ ] **Step 1: Push and deploy**

```bash
git push
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 2: Test legacy rebuilder (dry run)**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/legacy-rebuilder/index.js'
```

Expected: Lists ~80 legacy posts without rebuilding.

- [ ] **Step 3: Test llms.txt generator (dry run)**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/llms-txt-generator/index.js --dry-run'
```

Expected: Generates `data/reports/llms-txt/llms.txt` on the server. Inspect:

```bash
ssh root@137.184.119.230 'cat ~/seo-claude/data/reports/llms-txt/llms.txt | head -30'
```

- [ ] **Step 4: Test specificity audit (dry run)**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/specificity-audit/index.js --dry-run'
```

Expected: Lists flagged products. No queue writes.

- [ ] **Step 5: Run llms.txt generator for real**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/llms-txt-generator/index.js'
```

Verify on Shopify: visit `https://www.realskincare.com/llms.txt` — should redirect to `/pages/llms-txt` and display the content.

- [ ] **Step 6: Run specificity audit for real**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/specificity-audit/index.js'
```

Verify: open dashboard Optimize tab, review queued product description rewrites. Approve one to verify the publish flow works end-to-end.

- [ ] **Step 7: Run legacy rebuilder on one post**

Pick one legacy post (e.g. the first one from the dry-run list) and rebuild it:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/legacy-rebuilder/index.js <slug> --apply'
```

Verify on Shopify admin that the article was updated. Verify `data/backups/legacy-rebuild/<slug>.<timestamp>.html` exists.
