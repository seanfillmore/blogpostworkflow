#!/usr/bin/env node
/**
 * Create Meta A/B Test
 *
 * Generates a Variant B title tag for a published post, writes a test file,
 * and applies Variant B via Shopify's global.title_tag metafield.
 *
 * Usage:
 *   node scripts/create-meta-ab.js <slug>
 *   node scripts/create-meta-ab.js <slug> --dry-run
 *
 * Requires: ANTHROPIC_API_KEY in .env
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { getMetaPath } from '../lib/posts.js';
import { upsertMetafield } from '../lib/shopify.js';

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

const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!slug) {
  console.error('Usage: node scripts/create-meta-ab.js <slug> [--dry-run]');
  process.exit(1);
}

const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
const GSC_DIR        = join(ROOT, 'data', 'snapshots', 'gsc');

// ── load post metadata ─────────────────────────────────────────────────────

const metaPath = getMetaPath(slug);
if (!existsSync(metaPath)) { console.error(`Post not found: ${metaPath}`); process.exit(1); }
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

if (!meta.shopify_article_id || !meta.shopify_blog_id) {
  console.error('Post is missing shopify_article_id or shopify_blog_id. Re-publish it first.');
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
  let path = null;
  try { path = meta.shopify_url ? new URL(meta.shopify_url).pathname : null; } catch { /* skip */ }
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
  // Was a raw POST to /blogs/{blogId}/articles/{id}/metafields.json using
  // SHOPIFY_ACCESS_TOKEN + SHOPIFY_STORE_DOMAIN. Neither is in .env, so this bailed
  // on every run. The OAuth client mints its own token, and the type-agnostic
  // /articles/{id}/metafields.json path needs no parent blog id — blogId is kept in
  // the signature because callers pass it and it stays useful for logging.
  // upsertMetafield also updates in place; the old POST created a duplicate.
  await upsertMetafield('articles', articleId, 'global', 'title_tag', titleTag);
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

  // Apply to Shopify. The old guard here checked SHOPIFY_TOKEN/SHOPIFY_STORE and
  // returned early — and since neither variable is in .env, it returned early EVERY
  // time. The test file was written, the operator saw "Test file written", and the
  // variant never reached the storefront. lib/shopify.js mints its own OAuth token
  // from SHOPIFY_CLIENT_ID/SECRET and throws loudly at import if those are missing,
  // so a missing-credential case now fails visibly instead of skipping in a warning.
  console.log('Applying Variant B to Shopify (global.title_tag)...');
  await applyMetafield(meta.shopify_article_id, meta.shopify_blog_id, variantB);
  console.log('Done. Variant B is now live.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
