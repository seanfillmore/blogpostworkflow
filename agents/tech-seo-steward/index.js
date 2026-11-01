#!/usr/bin/env node
/**
 * Technical SEO Steward — finishes what the weekly DataForSEO crawl finds.
 *
 * Runs Sundays from scheduler.js, right after `site-crawler` and
 * `technical-seo create-redirects` (which still auto-applies its own
 * HIGH-confidence redirects). Everything the crawl used to leave in a review
 * queue nobody read is decided and applied here:
 *
 *   1. DEAD LINKS. Every 404 that something on the site still links to gets a
 *      301. A model picks the destination BY NUMBER from a closed list of live
 *      pages (it cannot invent a URL), and the target is fetched and must
 *      answer 200 before the redirect is created. `scripts/fix-redirect-links.mjs`
 *      runs next in the scheduler and repoints the inbound links themselves.
 *      Scheduled and draft articles are never redirected: they 404 today and go
 *      live on their publish date.
 *   2. SCHEME-LESS LINKS. `href="www.example.com"` resolves relative to the page
 *      and 404s. Repaired in article, page and product bodies, the store
 *      policies, and the local content.html mirrors.
 *   3. SITEMAP HYGIENE. A sitemap URL that carries noindex, and a /pages/ URL
 *      nothing links to that drew zero search impressions in 90 days, get
 *      Shopify's `seo.hidden`, which removes them from the sitemap. Hidden
 *      pages still load, so email and ad links keep working.
 *   4. META DESCRIPTIONS over 160 characters get a new `description_tag`,
 *      written by the model behind the health-claim and length gates. Pages
 *      under a CTR experiment (holdout, treatment, or an open A/B test) and
 *      articles inside the 28-day edit window are left alone.
 *
 * Long titles are handled by `scripts/remediate-long-titles.mjs --mint --auto`,
 * the step after this one.
 *
 * Usage:
 *   node agents/tech-seo-steward/index.js            # dry run: decide, write nothing
 *   node agents/tech-seo-steward/index.js --apply    # what cron runs
 *   --only dead-links,schemeless,sitemap,meta        # run a subset
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { LLM_MODELS } from '../../config/llm-models.js';
import {
  getBlogs, getArticles, updateArticle, getPages, updatePage, getProducts, updateProduct,
  getCustomCollections, getSmartCollections, getAllRedirects, createRedirect,
  getMetafields, upsertMetafield, shopifyGraphQL,
} from '../../lib/shopify.js';
import { getPagePerformance } from '../../lib/gsc.js';
import { notify } from '../../lib/notify.js';
import { ctrProtectedHandles } from '../../lib/ctr-protected.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { mayEditLivePost, recordMaterialEdit } from '../../lib/post-edit-gate.js';
import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';
import { SEO_COPY_COMPLIANCE_RULE, EDITORIAL_SURFACE, COMMERCIAL_SURFACE } from '../../lib/seo-copy-health-gate.js';
import { SEO_COPY_LENGTH_RULE } from '../../lib/seo-copy-length.js';
import { stripEmDashes, isEchoedDescription } from '../../lib/serp-copy.js';
import {
  selectDeadPaths, buildChoiceList, buildResolverPrompt, parseChoice, urlPath,
  fixSchemelessHrefs, resourceForPath, parseRenderedPage, decodeEntities, shouldHideOrphan,
  descriptionProblems,
} from '../../lib/tech-seo-steward.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const ORIGIN = 'https://www.realskincare.com';
const UA = 'Mozilla/5.0 (compatible; RSC-tech-seo-steward/1.0)';
const CRAWL_PATH = join(ROOT, 'data', 'technical_seo', 'crawl-results.json');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'tech-seo-steward');

// Per-run caps. Dead links are uncapped in practice (single digits a week);
// descriptions are paced so a backlog of ~170 drains over ~3 months rather
// than rewriting every SERP snippet on the site in one Sunday.
const MAX_REDIRECTS = 25;
const MAX_DESCRIPTIONS = 15;
const CRAWL_MAX_AGE_DAYS = 3;
const FETCH_GAP_MS = 900; // Cloudflare rate-limits a fast crawl (CLAUDE.md, Ahrefs section)

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i === -1 ? null : new Set(String(args[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean));
})();
const runs = (step) => !ONLY || ONLY.has(step);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  try {
    const env = {};
    for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

async function fetchPage(url, { redirect = 'follow' } = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { redirect, headers: { 'user-agent': UA } });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      return { status: r.status, html: r.status === 200 ? await r.text() : '' };
    } catch { await sleep(3000 * (i + 1)); }
  }
  return { status: null, html: '' };
}

async function ask(client, prompt, maxTokens = 400) {
  const res = await client.messages.create({
    model: LLM_MODELS.standard,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('model reply truncated at max_tokens');
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// ── Inventory ───────────────────────────────────────────────────────────────

async function loadInventory() {
  const now = Date.now();
  const isLive = (p) => p && Date.parse(p) <= now;
  const inv = { articles: [], products: [], collections: [], pages: [], pendingPaths: new Set(), livePaths: new Set(), byPath: new Map() };
  const add = (kind, item) => {
    inv[kind].push(item);
    inv.livePaths.add(item.path);
    inv.byPath.set(item.path, item);
  };
  for (const b of await getBlogs()) {
    for (const a of await getArticles(b.id, { limit: 250 })) {
      const path = `/blogs/${b.handle}/${a.handle}`;
      const item = { resource: 'articles', id: a.id, blogId: b.id, handle: a.handle, path, title: a.title, body: a.body_html || '' };
      if (isLive(a.published_at)) add('articles', item);
      else inv.pendingPaths.add(path);
    }
  }
  for (const p of await getProducts({ limit: 250 })) {
    if (p.status !== 'active' || !p.published_at) continue;
    add('products', { resource: 'products', id: p.id, handle: p.handle, path: `/products/${p.handle}`, title: p.title, body: p.body_html || '' });
  }
  for (const c of [...await getCustomCollections({ limit: 250 }), ...await getSmartCollections({ limit: 250 })]) {
    if (!isLive(c.published_at)) continue;
    add('collections', { resource: 'collections', id: c.id, handle: c.handle, path: `/collections/${c.handle}`, title: c.title });
  }
  for (const pg of await getPages({ limit: 250 })) {
    if (!isLive(pg.published_at)) continue;
    add('pages', { resource: 'pages', id: pg.id, handle: pg.handle, path: `/pages/${pg.handle}`, title: pg.title, body: pg.body_html || '' });
  }
  // Hubs and the catalogue are live even though they are not resources.
  for (const p of ['/', '/blogs/news', '/collections/all']) inv.livePaths.add(p);
  return inv;
}

function loadCrawl() {
  if (!existsSync(CRAWL_PATH)) return { crawl: null, why: 'no crawl-results.json' };
  try {
    const crawl = JSON.parse(readFileSync(CRAWL_PATH, 'utf8'));
    const ageDays = (Date.now() - Date.parse(crawl.crawled_at)) / 86400000;
    if (!(ageDays <= CRAWL_MAX_AGE_DAYS)) return { crawl: null, why: `crawl is ${ageDays.toFixed(1)} days old (max ${CRAWL_MAX_AGE_DAYS})` };
    return { crawl, why: null };
  } catch (e) { return { crawl: null, why: `crawl unreadable: ${e.message}` }; }
}

// ── 1. Dead links ───────────────────────────────────────────────────────────

function anchorsFor(path, inventory) {
  const anchors = new Set(); const sources = [];
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<a\\b[^>]*href=["'](?:https?://[^/"']+)?${esc}/?["'][^>]*>([\\s\\S]*?)</a>`, 'gi');
  for (const kind of ['articles', 'pages', 'products']) {
    for (const it of inventory[kind]) {
      if (!it.body || !it.body.includes(path)) continue;
      let m; let hit = false;
      while ((m = re.exec(it.body))) {
        const t = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
        if (t) anchors.add(t);
        hit = true;
      }
      if (hit) sources.push(it.path);
    }
  }
  return { anchors: [...anchors], sources };
}

async function resolveDeadLinks({ crawl, inventory, client, report }) {
  const redirects = await getAllRedirects();
  const { targets, skipped } = selectDeadPaths(crawl.issues?.error_404 || [], {
    redirectPaths: new Set(redirects.map((r) => r.path)),
    livePaths: inventory.livePaths,
    pendingPaths: inventory.pendingPaths,
  });
  report.dead_links = { considered: targets.length, skipped, created: [], failed: [] };
  for (const t of targets.slice(0, MAX_REDIRECTS)) {
    const choices = buildChoiceList(t.type, inventory);
    const ctx = anchorsFor(t.path, inventory);
    let pick = null;
    try {
      pick = parseChoice(await ask(client, buildResolverPrompt({ path: t.path, ...ctx }, choices)), choices);
    } catch (e) {
      report.dead_links.failed.push({ path: t.path, why: e.message });
      continue;
    }
    if (!pick) { report.dead_links.failed.push({ path: t.path, why: 'model reply was not a valid choice' }); continue; }
    const check = await fetchPage(ORIGIN + pick.path);
    await sleep(FETCH_GAP_MS);
    if (check.status !== 200) { report.dead_links.failed.push({ path: t.path, why: `chosen target ${pick.path} answered ${check.status}` }); continue; }
    if (APPLY) {
      try { await createRedirect(t.path, pick.path); }
      catch (e) { report.dead_links.failed.push({ path: t.path, why: `createRedirect: ${e.message}` }); continue; }
    }
    report.dead_links.created.push({ from: t.path, to: pick.path, why: pick.why, inlinks: t.inlinks });
    console.log(`  ${APPLY ? 'REDIRECT' : 'would redirect'} ${t.path} → ${pick.path}  (${pick.why})`);
  }
  if (targets.length > MAX_REDIRECTS) report.dead_links.deferred = targets.length - MAX_REDIRECTS;
}

// ── 2. Scheme-less links ────────────────────────────────────────────────────

async function repairSchemeless({ inventory, report }) {
  const fixed = [];
  for (const kind of ['articles', 'pages', 'products']) {
    for (const it of inventory[kind]) {
      const { html, fixed: f } = fixSchemelessHrefs(it.body);
      if (!f.length) continue;
      if (kind === 'articles') {
        const gate = mayEditLivePost(it.handle, 'repair');
        if (!gate.allowed) { fixed.push({ path: it.path, held: gate.reason }); continue; }
      }
      if (APPLY) {
        if (kind === 'articles') await updateArticle(it.blogId, it.id, { body_html: html });
        else if (kind === 'pages') await updatePage(it.id, { body_html: html });
        else await updateProduct(it.id, { body_html: html });
        it.body = html;
      }
      fixed.push({ path: it.path, hrefs: f });
    }
  }
  // Store policies (privacy, refund, …) are not pages; they go through GraphQL.
  try {
    const q = await shopifyGraphQL('{ shop { shopPolicies { type body } } }');
    for (const pol of q?.shop?.shopPolicies || []) {
      const { html, fixed: f } = fixSchemelessHrefs(pol.body);
      if (!f.length) continue;
      if (APPLY) {
        const r = await shopifyGraphQL(
          'mutation($p: ShopPolicyInput!){ shopPolicyUpdate(shopPolicy:$p){ userErrors{ message } } }',
          { p: { type: pol.type, body: html } },
        );
        const errs = r?.shopPolicyUpdate?.userErrors || [];
        if (errs.length) { fixed.push({ path: `policy:${pol.type}`, error: errs.map((e) => e.message).join('; ') }); continue; }
      }
      fixed.push({ path: `policy:${pol.type}`, hrefs: f });
    }
  } catch (e) { fixed.push({ path: 'policies', error: e.message }); }

  // Mirrors: scheduler.js's link-repair step republishes content.html, so a
  // live fix with a stale mirror would be undone. The transform is a pure
  // repair of an unambiguous defect and idempotent, so it is applied to every
  // local mirror rather than only the ones matched to an article id.
  const postsDir = join(ROOT, 'data', 'posts');
  let mirrors = 0;
  if (existsSync(postsDir)) {
    for (const slug of readdirSync(postsDir)) {
      const p = join(postsDir, slug, 'content.html');
      if (!existsSync(p)) continue;
      const { html, fixed: f } = fixSchemelessHrefs(readFileSync(p, 'utf8'));
      if (!f.length) continue;
      if (APPLY) writeFileSync(p, html);
      mirrors++;
    }
  }
  report.schemeless = { fixed, mirrors };
  for (const f of fixed) console.log(`  ${APPLY ? 'FIXED' : 'would fix'} scheme-less link on ${f.path}: ${(f.hrefs || []).join(', ') || f.held || f.error}`);
}

// ── 3 + 4. Sitemap pass: hygiene and meta descriptions ──────────────────────

async function sitemapUrls() {
  const idx = (await fetchPage(`${ORIGIN}/sitemap.xml`)).html;
  const subs = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeEntities(m[1]));
  const urls = [];
  for (const s of subs) {
    const x = (await fetchPage(s)).html;
    urls.push(...[...x.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map((m) => decodeEntities(m[1])));
    await sleep(FETCH_GAP_MS);
  }
  return [...new Set(urls)];
}

async function resolveResourceId(path, inventory) {
  const known = inventory.byPath.get(path);
  if (known) return known;
  const r = resourceForPath(path);
  if (!r) return null;
  // Not in the live inventory (e.g. a noindexed product the inventory skipped):
  // look it up directly.
  if (r.resource === 'products') {
    const p = (await getProducts({ handle: r.handle, limit: 1 }))?.[0];
    return p ? { resource: 'products', id: p.id, handle: p.handle, path } : null;
  }
  return null;
}

async function isHidden(res) {
  try {
    const mf = await getMetafields(res.resource, res.id);
    return mf.some((m) => m.namespace === 'seo' && m.key === 'hidden' && String(m.value) === '1');
  } catch { return false; }
}

async function sitemapPass({ crawl, inventory, client, report }) {
  const urls = await sitemapUrls();
  console.log(`  sitemap: ${urls.length} URLs`);
  const pages = [];
  for (const u of urls) {
    const r = await fetchPage(u);
    pages.push({ url: u, path: urlPath(u), status: r.status, ...parseRenderedPage(r.html), text: r.html });
    await sleep(FETCH_GAP_MS);
  }
  report.sitemap = { urls: urls.length, non200: pages.filter((p) => p.status !== 200).map((p) => ({ url: p.url, status: p.status })) };

  // 3a. noindex in sitemap → seo.hidden
  const hidden = [];
  if (runs('sitemap')) {
    for (const p of pages.filter((x) => x.status === 200 && x.noindex)) {
      const res = await resolveResourceId(p.path, inventory);
      if (!res) { hidden.push({ path: p.path, why: 'noindex', error: 'resource not found' }); continue; }
      // Shopify regenerates the sitemap on its own schedule, so a page hidden
      // last week can still be listed. Already hidden is not a new fix.
      if (await isHidden(res)) continue;
      if (APPLY) await upsertMetafield(res.resource, res.id, 'seo', 'hidden', 1, 'number_integer');
      hidden.push({ path: p.path, why: 'noindex but listed in sitemap' });
    }
    // 3b. orphan /pages/ with zero search demand → seo.hidden
    const inSitemap = new Set(pages.map((p) => p.path));
    for (const row of crawl?.issues?.orphan || []) {
      const path = urlPath(row.url);
      const r = resourceForPath(path);
      if (!r || !inSitemap.has(path)) continue;
      let impressions90d = null;
      try { impressions90d = (await getPagePerformance(ORIGIN + path, 90)).impressions; } catch { impressions90d = null; }
      if (!shouldHideOrphan({ resource: r.resource, inlinks: row['no._of_all_inlinks'] ?? 0, impressions90d })) continue;
      const res = inventory.byPath.get(path);
      if (!res || await isHidden(res)) continue;
      if (APPLY) await upsertMetafield(res.resource, res.id, 'seo', 'hidden', 1, 'number_integer');
      hidden.push({ path, why: 'orphan page, 0 search impressions in 90 days' });
    }
    for (const h of hidden) console.log(`  ${APPLY ? 'HID' : 'would hide'} ${h.path} from sitemap — ${h.error || h.why}`);
  }
  report.hidden = hidden;

  // 4. meta descriptions over the limit
  if (runs('meta')) await rewriteDescriptions({ pages, inventory, client, report });
}

function plainText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function rewriteDescriptions({ pages, inventory, client, report }) {
  const protectedHandles = ctrProtectedHandles(ROOT);
  const out = { rewritten: [], held: [], failed: [], deferred: 0 };
  const over = pages.filter((p) => p.status === 200 && !p.noindex && p.metaDescription && [...p.metaDescription].length > 160);
  let done = 0;
  for (const p of over) {
    const res = inventory.byPath.get(p.path);
    if (!res) continue;
    if (protectedHandles.has(res.handle)) { out.held.push({ path: p.path, why: 'CTR experiment page' }); continue; }
    if (res.resource === 'articles') {
      const gate = mayEditLivePost(res.handle, 'serp');
      if (!gate.allowed) { out.held.push({ path: p.path, why: gate.reason }); continue; }
    }
    if (done >= MAX_DESCRIPTIONS) { out.deferred++; continue; }

    const source = `${res.title}\n${p.metaDescription}\n${plainText(res.body || p.text).slice(0, 2500)}`;
    const surface = res.resource === 'articles' ? EDITORIAL_SURFACE : COMMERCIAL_SURFACE;
    const prompt = (constraint) => [
      `Write the meta description (the search-result snippet) for this ${res.resource.slice(0, -1)} on realskincare.com.`,
      'Lead with what the searcher gets, keep the main topic words from the title, end with a reason to click. Plain sentences, no em dashes, no quotes, no emoji.',
      'Use only facts in the page below; never add a number that is not in it.',
      `Target 130 to 155 characters.`,
      SEO_COPY_LENGTH_RULE,
      SEO_COPY_COMPLIANCE_RULE,
      '',
      `Title: ${res.title}`,
      `Current description (too long, ${[...p.metaDescription].length} characters): ${p.metaDescription}`,
      `Page text: ${plainText(res.body || p.text).slice(0, 2500)}`,
      constraint ? `\n${constraint}` : '',
      '\nReply with ONLY the description.',
    ].join('\n');
    try {
      const gated = await gateGeneratedCopy(
        (constraint) => ask(client, prompt(constraint), 300),
        { extract: (t) => ({ meta: stripEmDashes(String(t || '').replace(/^["']|["']$/g, '').trim(), { kind: 'meta' }) }), required: ['meta'], lengths: { meta: 'description' }, surface },
      );
      const text = stripEmDashes(String(gated.proposed || '').replace(/^["']|["']$/g, '').trim(), { kind: 'meta' });
      const problems = !gated.ok
        ? ['health gate: ' + (gated.violations || []).map((b) => b.match).join(', ')]
        : isEchoedDescription(text, p.metaDescription) ? ['model returned the current description'] : descriptionProblems(text, source);
      if (problems.length) { out.failed.push({ path: p.path, why: problems.join('; ') }); continue; }
      if (APPLY) {
        await upsertMetafield(res.resource, res.id, 'global', 'description_tag', text);
        if (res.resource === 'articles') recordMaterialEdit(res.handle, 'serp', 'tech-seo-steward');
      }
      done++;
      out.rewritten.push({ path: p.path, before: p.metaDescription, after: text });
      console.log(`  ${APPLY ? 'META' : 'would set meta'} ${p.path}\n      ${text}`);
    } catch (e) { out.failed.push({ path: p.path, why: e.message }); }
  }
  report.descriptions = { over: over.length, ...out };
}

// ── Report ──────────────────────────────────────────────────────────────────

function digestBody(r) {
  const L = [];
  if (r.crawl_note) L.push(`Crawl: ${r.crawl_note}`);
  const d = r.dead_links;
  if (d) {
    L.push(`Dead links: ${d.created.length} redirected${d.failed.length ? `, ${d.failed.length} unresolved` : ''}${d.deferred ? `, ${d.deferred} deferred to next run` : ''}`);
    for (const c of d.created) L.push(`  ${c.from} → ${c.to} (${c.inlinks} inbound; ${c.why})`);
    for (const f of d.failed) L.push(`  unresolved ${f.path}: ${f.why}`);
  }
  if (r.schemeless?.fixed?.length) {
    L.push(`Scheme-less links repaired: ${r.schemeless.fixed.length} (mirrors ${r.schemeless.mirrors})`);
    for (const f of r.schemeless.fixed) L.push(`  ${f.path}: ${(f.hrefs || []).join(', ') || f.held || f.error}`);
  }
  if (r.hidden?.length) {
    L.push(`Hidden from sitemap: ${r.hidden.length}`);
    for (const h of r.hidden) L.push(`  ${h.path} (${h.error || h.why})`);
  }
  if (r.sitemap?.non200?.length) {
    L.push(`Sitemap URLs not answering 200: ${r.sitemap.non200.length}`);
    for (const n of r.sitemap.non200) L.push(`  ${n.url} → ${n.status}`);
  }
  const m = r.descriptions;
  if (m) {
    L.push(`Meta descriptions over 160: ${m.over}; rewritten ${m.rewritten.length}, held ${m.held.length}, failed ${m.failed.length}, left for next run ${m.deferred}`);
    for (const w of m.rewritten) L.push(`  ${w.path}: ${w.after}`);
    for (const f of m.failed) L.push(`  not rewritten ${f.path}: ${f.why}`);
  }
  return L.join('\n') || 'Nothing to fix.';
}

async function main() {
  console.log(`\nTechnical SEO Steward — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  const env = loadEnv();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const report = { generated_at: new Date().toISOString(), applied: APPLY };

  const inventory = await loadInventory();
  console.log(`  inventory: ${inventory.articles.length} live articles (${inventory.pendingPaths.size} scheduled/draft), ${inventory.products.length} products, ${inventory.collections.length} collections, ${inventory.pages.length} pages`);
  const { crawl, why } = loadCrawl();
  if (!crawl) report.crawl_note = `dead-link and orphan steps skipped: ${why}`;

  if (crawl && runs('dead-links')) await resolveDeadLinks({ crawl, inventory, client, report });
  if (runs('schemeless')) await repairSchemeless({ inventory, report });
  if (runs('sitemap') || runs('meta')) await sitemapPass({ crawl, inventory, client, report });

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  const body = digestBody(report);
  console.log(`\n${body}\n`);
  const n = (report.dead_links?.created.length || 0) + (report.schemeless?.fixed.length || 0) + (report.hidden?.length || 0) + (report.descriptions?.rewritten.length || 0);
  await notify({
    subject: `Tech SEO Steward${APPLY ? '' : ' (dry run)'}: ${n} fix(es) applied`,
    body,
    status: 'success',
    category: 'technical-seo',
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (e) => {
    console.error(e);
    await notify({ subject: 'Tech SEO Steward failed', body: String(e?.stack || e), status: 'error', category: 'technical-seo' });
    process.exitCode = 1;
  });
}
