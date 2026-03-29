#!/usr/bin/env node
/**
 * apply-blog-sidebar.js
 *
 * One-time script to add a product sidebar and Klaviyo newsletter form
 * to the Shopify theme's article section (sections/main-article.liquid).
 *
 * Usage:
 *   node scripts/apply-blog-sidebar.js          # dry run — prints modified liquid
 *   node scripts/apply-blog-sidebar.js --apply  # backs up + uploads to live theme
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const { SHOPIFY_STORE, SHOPIFY_SECRET } = env;
if (!SHOPIFY_STORE || !SHOPIFY_SECRET) throw new Error('Missing SHOPIFY_STORE or SHOPIFY_SECRET in .env');

const API_BASE = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

async function shopifyGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_SECRET, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function shopifyPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── CSS to inject ─────────────────────────────────────────────────────────────

const SIDEBAR_CSS = `
<style>
.rsc-article-with-sidebar{display:flex;gap:40px;align-items:flex-start}
.rsc-article-body{flex:1;min-width:0}
.rsc-article-sidebar{width:280px;flex-shrink:0;position:sticky;top:20px}
.rsc-sidebar-heading{font-size:13px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:0 0 16px;color:inherit}
.rsc-sidebar-product{margin-bottom:16px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#fff}
.rsc-sidebar-product-img-link{display:block;aspect-ratio:1/1;overflow:hidden}
.rsc-sidebar-product-img{width:100%;height:100%;object-fit:cover;display:block}
.rsc-sidebar-product-info{padding:10px 12px}
.rsc-sidebar-product-title{font-size:13px;font-weight:600;margin:0 0 4px;line-height:1.3;color:#111}
.rsc-sidebar-product-price{font-size:13px;color:#374151;margin:0 0 8px}
.rsc-sidebar-product-btn{display:inline-block;background:#1e1b4b;color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none}
.rsc-sidebar-product-btn:hover{opacity:.85}
@media(max-width:768px){.rsc-article-with-sidebar{flex-direction:column}.rsc-article-sidebar{width:100%;position:static}}
</style>`;

// ── Liquid content block replacement ─────────────────────────────────────────

const OLD_CONTENT_BLOCK = `        {%- when 'content'-%}
          <div class="article-template__content page-width page-width--inner rte" itemprop="articleBody" {{ block.shopify_attributes }}>
              {{ article.content }}
          </div>`;

const NEW_CONTENT_BLOCK = `        {%- when 'content'-%}
          <div class="rsc-article-with-sidebar page-width page-width--inner" {{ block.shopify_attributes }}>
            <div class="rsc-article-body rte" itemprop="articleBody" id="rsc-article-body">
              {{ article.content }}
            </div>
            {%- assign sidebar_collection = collections['blog-sidebar'] -%}
            {%- if sidebar_collection != empty and sidebar_collection.products.size > 0 -%}
              <aside class="rsc-article-sidebar">
                <p class="rsc-sidebar-heading">Our Products</p>
                {%- for product in sidebar_collection.products limit: 6 -%}
                  <div class="rsc-sidebar-product">
                    {%- if product.featured_image -%}
                      <a href="{{ product.url }}" class="rsc-sidebar-product-img-link">
                        {{ product.featured_image | image_url: width: 280, height: 280, crop: 'center' | image_tag: alt: product.title, loading: 'lazy', class: 'rsc-sidebar-product-img' }}
                      </a>
                    {%- endif -%}
                    <div class="rsc-sidebar-product-info">
                      <p class="rsc-sidebar-product-title">{{ product.title }}</p>
                      <p class="rsc-sidebar-product-price">{{ product.price_min | money }}</p>
                      <a href="{{ product.url }}" class="rsc-sidebar-product-btn">Shop Now</a>
                    </div>
                  </div>
                {%- endfor -%}
              </aside>
            {%- endif -%}
          </div>
          <script>
            document.addEventListener('DOMContentLoaded', function() {
              var body = document.getElementById('rsc-article-body');
              if (!body) return;
              var headings = body.querySelectorAll('h2, h3');
              var target = headings.length >= 2 ? headings[1] : null;
              var wrapper = document.createElement('div');
              wrapper.style.cssText = 'margin:32px 0;';
              // Klaviyo embedded form ID — update in Klaviyo dashboard under Forms if the form changes
              wrapper.innerHTML = '<div class="klaviyo-form-Xr4S7X"></div>';
              if (target) {
                target.insertAdjacentElement('afterend', wrapper);
              } else {
                body.appendChild(wrapper);
              }
            });
          </script>`;

// ── CSS anchor ────────────────────────────────────────────────────────────────

const CSS_ANCHOR = `{{ 'section-blog-post.css' | asset_url | stylesheet_tag }}`;

// ── Idempotency marker ────────────────────────────────────────────────────────

const IDEMPOTENCY_MARKER = 'rsc-article-with-sidebar';

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBlog Sidebar & Newsletter — ${APPLY ? 'APPLY mode' : 'DRY RUN'}\n`);

  // 1. Find live theme
  const { themes } = await shopifyGet('/themes.json');
  const liveTheme = themes.find(t => t.role === 'main');
  if (!liveTheme) throw new Error('No live (main) theme found');
  console.log(`  Live theme: "${liveTheme.name}" (ID: ${liveTheme.id})`);

  // 2. Download current file
  const assetKey = 'sections/main-article.liquid';
  const { asset } = await shopifyGet(`/themes/${liveTheme.id}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`);
  const original = asset.value;
  console.log(`  Downloaded: ${assetKey} (${original.length} chars)`);

  // 3. Idempotency check
  if (original.includes(IDEMPOTENCY_MARKER)) {
    console.log('\n  Already applied — file contains rsc-article-with-sidebar. Nothing to do.');
    return;
  }

  // 4. Apply modifications — exact match required; no silent no-ops allowed
  if (!original.includes(OLD_CONTENT_BLOCK)) {
    // Looser diagnostic match
    if (!original.includes("when 'content'")) {
      throw new Error("Could not find content block in theme file. The theme may have changed — review manually.");
    }
    throw new Error("Content block found but exact text did not match. Run in dry-run mode and inspect the file before retrying.");
  }

  let modified = original.replace(OLD_CONTENT_BLOCK, NEW_CONTENT_BLOCK);

  // Guard: confirm replacement actually happened
  if (!modified.includes(IDEMPOTENCY_MARKER)) {
    throw new Error("String replacement produced no change — IDEMPOTENCY_MARKER not found after replace. Do not upload.");
  }

  if (!original.includes(CSS_ANCHOR)) {
    throw new Error(`CSS anchor not found: "${CSS_ANCHOR}". Cannot inject sidebar CSS.`);
  }
  modified = modified.replace(CSS_ANCHOR, CSS_ANCHOR + '\n' + SIDEBAR_CSS);
  if (!modified.includes('<style>') || !modified.includes('.rsc-article-with-sidebar')) {
    throw new Error('CSS injection failed — SIDEBAR_CSS not found after replace. Do not upload.');
  }

  console.log(`  Modified: ${modified.length} chars (${modified.length - original.length > 0 ? '+' : ''}${modified.length - original.length})`);

  if (!APPLY) {
    console.log('\n  === DRY RUN OUTPUT (first 200 lines) ===\n');
    console.log(modified.split('\n').slice(0, 200).join('\n'));
    console.log('\n  Run with --apply to upload to Shopify.');
    return;
  }

  // 5. Backup
  const backupDir = join(ROOT, 'backup');
  mkdirSync(backupDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const backupPath = join(backupDir, `main-article-${date}.liquid`);
  writeFileSync(backupPath, original);
  console.log(`  Backup saved: backup/main-article-${date}.liquid`);

  // 6. Upload
  await shopifyPut(`/themes/${liveTheme.id}/assets.json`, {
    asset: { key: assetKey, value: modified },
  });
  console.log(`  Uploaded: ${assetKey} ✓`);
  console.log('\n  Done. Verify on a live blog post before considering this complete.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
