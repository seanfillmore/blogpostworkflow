#!/usr/bin/env node
/**
 * Create Meta A/B Test
 *
 * Generates a Variant B title tag for a published post, writes a test file,
 * and applies Variant B via Shopify's global.title_tag metafield.
 *
 * Usage:
 *   node scripts/create-meta-test.js <slug>
 *   node scripts/create-meta-test.js <slug> --dry-run
 *
 * Requires: ANTHROPIC_API_KEY in .env
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

const env = loadEnv();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
const SHOPIFY_TOKEN     = process.env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_STORE_DOMAIN;

const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!slug) {
  console.error('Usage: node scripts/create-meta-test.js <slug> [--dry-run]');
  process.exit(1);
}

const POSTS_DIR      = join(ROOT, 'data', 'posts');
const BRIEFS_DIR     = join(ROOT, 'data', 'briefs');
const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
const GSC_DIR        = join(ROOT, 'data', 'snapshots', 'gsc');

// ── load post metadata ─────────────────────────────────────────────────────

const metaPath = join(POSTS_DIR, `${slug}.json`);
if (!existsSync(metaPath)) { console.error(`Post not found: ${metaPath}`); process.exit(1); }
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

if (!meta.shopify_article_id) {
  console.error('Post is not published to Shopify. Publish it first.');
  process.exit(1);
}

// ── check for existing active test ────────────────────────────────────────

const testPath = join(META_TESTS_DIR, `${slug}.json`);
if (existsSync(testPath)) {
  const existing = JSON.parse(readFileSync(testPath, 'utf8'));
  if (existing.status === 'active') {
    console.error(`Active test already exists for "${slug}". Conclude it first.`);
    process.exit(1);
  }
}

// ── measure baseline CTR from GSC snapshots ───────────────────────────────

function getBaselineCTR() {
  if (!existsSync(GSC_DIR)) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86400000);
  const path  = meta.shopify_url ? new URL(meta.shopify_url).pathname : null;
  if (!path) return null;

  const snapFiles = readdirSync(GSC_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const d = new Date(f.replace('.json', '') + 'T12:00:00Z');
      return d >= start && d < end;
    });

  const ctrs = [];
  for (const f of snapFiles) {
    try {
      const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
      const pg = (snap.topPages || []).find(p => p.page.endsWith(path));
      if (pg?.ctr != null) ctrs.push(pg.ctr);
    } catch { /* skip */ }
  }
  return ctrs.length ? ctrs.reduce((a, b) => a + b, 0) / ctrs.length : null;
}

// ── generate Variant B title ──────────────────────────────────────────────

async function generateVariantB() {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const keyword = meta.target_keyword || slug.replace(/-/g, ' ');
  const prompt = `You are an SEO expert. Write an alternative title tag for a blog post.

Current title: ${meta.title}
Target keyword: ${keyword}

Requirements:
- Under 60 characters
- Include the target keyword naturally
- Different angle/phrasing from the original
- Compelling for searchers
- Do not use the exact same opening words as the original

Reply with ONLY the title tag text, no quotes, no explanation.`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text.trim();
}

// ── apply metafield to Shopify ────────────────────────────────────────────

async function applyMetafield(articleId, blogId, titleTag) {
  // Shopify metafield: global.title_tag on article
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/blogs/${blogId}/articles/${articleId}/metafields.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metafield: {
        namespace: 'global',
        key: 'title_tag',
        value: titleTag,
        type: 'single_line_text_field',
      },
    }),
  });
  if (!res.ok) throw new Error(`Shopify metafield update failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Creating A/B test for: "${meta.title}"`);

  const baselineCTR = getBaselineCTR();
  console.log(`Baseline CTR: ${baselineCTR != null ? (baselineCTR * 100).toFixed(2) + '%' : 'insufficient data'}`);

  console.log('Generating Variant B title...');
  const variantB = await generateVariantB();
  console.log(`Variant A: ${meta.title}`);
  console.log(`Variant B: ${variantB}`);

  if (dryRun) {
    console.log('[dry-run] Would write test file and apply Shopify metafield.');
    return;
  }

  // Write test file
  const startDate = new Date().toISOString().slice(0, 10);
  const concludeDate = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
  mkdirSync(META_TESTS_DIR, { recursive: true });
  const testData = {
    slug,
    startDate,
    concludeDate,
    variantA: meta.title,
    variantB,
    baselineCTR,
    status: 'active',
    currentDelta: null,
    baselineMean: baselineCTR,
    testMean: null,
    daysRemaining: 28,
  };
  writeFileSync(testPath, JSON.stringify(testData, null, 2));
  console.log(`Test file written: ${testPath}`);

  // Apply to Shopify
  if (!SHOPIFY_TOKEN || !SHOPIFY_STORE) {
    console.warn('Shopify credentials not set — skipping metafield update.');
    return;
  }
  console.log('Applying Variant B to Shopify (global.title_tag)...');
  await applyMetafield(meta.shopify_article_id, meta.shopify_blog_id, variantB);
  console.log('Done. Variant B is now live.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
