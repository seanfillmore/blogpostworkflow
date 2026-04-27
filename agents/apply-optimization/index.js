// agents/apply-optimization/index.js
/**
 * Apply Optimization Agent
 *
 * Reads a brief, applies all approved changes to Shopify,
 * updates statuses, and sends a Resend notification.
 *
 * Usage: node agents/apply-optimization/index.js <slug>
 *
 * stdout protocol: writes "DONE {applied:N,failed:N}" as the last line.
 * The dashboard /apply/:slug SSE endpoint reads this to emit the done event.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProduct, updateCustomCollection, upsertMetafield } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';
import { loadIndex, lookupByKeyword, lookupByUrl } from '../../lib/keyword-index/consumer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BRIEFS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'briefs');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const STORE   = env.SHOPIFY_STORE  || process.env.SHOPIFY_STORE;
const SECRET  = env.SHOPIFY_SECRET || process.env.SHOPIFY_SECRET;
const API_VER = '2025-01';

// ── Exported pure functions (tested) ──────────────────────────────────────────

export function filterApprovedChanges(brief) {
  return (brief.proposed_changes || []).filter(c => c.status === 'approved');
}

/**
 * Resolve an index entry for a brief. Tries URL lookup first (precise),
 * falls back to brief.target_keyword. Returns the entry or null.
 */
export function resolveIndexEntry(brief, idx, siteUrl) {
  if (!idx) return null;
  if (brief?.handle && brief?.page_type && siteUrl) {
    const pathSeg = brief.page_type === 'product' ? 'products' : 'collections';
    const url = `${siteUrl}/${pathSeg}/${brief.handle}`;
    const byUrl = lookupByUrl(idx, url);
    if (byUrl) return byUrl;
  }
  if (brief?.target_keyword) {
    return lookupByKeyword(idx, brief.target_keyword);
  }
  return null;
}

/**
 * Stamp validation metadata on each applied change and the brief root.
 * Pure — mutates the supplied objects and returns the brief.
 */
export function applyValidationMetadata(brief, indexEntry, nowIso = new Date().toISOString()) {
  const validationTag = indexEntry?.validation_source ?? null;
  const indexKeyword = indexEntry?.keyword ?? null;
  for (const change of brief.proposed_changes || []) {
    if (change.status !== 'applied') continue;
    if (validationTag) change.validation_source = validationTag;
    if (indexKeyword) change.index_keyword = indexKeyword;
    if (!change.applied_at) change.applied_at = nowIso;
  }
  if (validationTag) brief.validation_source = validationTag;
  if (indexKeyword) brief.index_keyword = indexKeyword;
  if (!brief.applied_at) brief.applied_at = nowIso;
  return brief;
}

export function parseDoneLine(line) {
  if (!line.startsWith('DONE ')) return null;
  try { return JSON.parse(line.slice(5)); } catch { return null; }
}

// ── Theme API helpers ──────────────────────────────────────────────────────────

async function shopifyRaw(method, path, body = null) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VER}${path}`, {
    method,
    headers: { 'X-Shopify-Access-Token': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Shopify ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getActiveThemeId() {
  const data = await shopifyRaw('GET', '/themes.json?role=main');
  return data.themes?.[0]?.id;
}

// ── Apply a single change ──────────────────────────────────────────────────────

async function applyChange(change, brief) {
  const { shopify_id, page_type } = brief;
  const resource = page_type === 'product' ? 'products' : 'custom_collections';

  switch (change.type) {
    case 'meta_title':
      await upsertMetafield(resource, shopify_id, 'global', 'title_tag', change.proposed);
      break;
    case 'meta_description':
      await upsertMetafield(resource, shopify_id, 'global', 'description_tag', change.proposed);
      break;
    case 'body_html':
      if (page_type === 'product') await updateProduct(shopify_id, { body_html: change.proposed });
      else await updateCustomCollection(shopify_id, { body_html: change.proposed });
      break;
    case 'theme_section': {
      const themeId = await getActiveThemeId();
      await shopifyRaw('PUT', `/themes/${themeId}/assets.json`, {
        asset: { key: change.section_key, value: JSON.stringify(change.proposed_content, null, 2) },
      });
      break;
    }
    default:
      throw new Error(`Unknown change type: ${change.type}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const slug = process.argv[2];
  if (!slug) { console.error('Usage: node agents/apply-optimization/index.js <slug>'); process.exit(1); }

  const briefPath = join(BRIEFS_DIR, `${slug}.json`);
  if (!existsSync(briefPath)) throw new Error(`Brief not found: ${briefPath}`);

  const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  const approved = filterApprovedChanges(brief);

  if (!approved.length) {
    console.log('No approved changes to apply.');
    console.log('DONE {"applied":0,"failed":0}');
    return;
  }

  // Look up keyword-index validation tag for the affected page (URL-first,
  // then keyword fallback). Used to stamp every applied change so the
  // change-log + outcome-attribution stack can group lift by validation tier.
  const idx = loadIndex(ROOT);
  let siteUrl = null;
  try {
    const cfgPath = join(ROOT, 'config', 'site.json');
    if (existsSync(cfgPath)) siteUrl = JSON.parse(readFileSync(cfgPath, 'utf8'))?.url ?? null;
  } catch { /* best-effort */ }
  const indexEntry = resolveIndexEntry(brief, idx, siteUrl);
  const validationTag = indexEntry?.validation_source ?? null;

  console.log(`Applying ${approved.length} approved changes for: ${slug}`);
  if (validationTag === 'amazon') console.log('  ★ Amazon-validated page');
  else if (validationTag === 'gsc_ga4') console.log('  ✓ GSC+GA4-validated page');

  let applied = 0, failed = 0;

  for (const change of approved) {
    console.log(`  Applying ${change.id} (${change.type})...`);
    try {
      await applyChange(change, brief);
      change.status = 'applied';
      applied++;
      console.log(`  ✓ ${change.id} applied`);
    } catch (err) {
      console.log(`  ✗ ${change.id} failed: ${err.message}`);
      failed++;
    }
  }

  if (!brief.proposed_changes.some(c => c.status === 'approved')) brief.status = 'applied';
  applyValidationMetadata(brief, indexEntry);
  writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  const tagPrefix = validationTag === 'amazon' ? '★ ' : validationTag === 'gsc_ga4' ? '✓ ' : '';
  await notify({
    subject: `Optimization applied: ${tagPrefix}${slug} — ${applied} applied, ${failed} failed`,
    body: `Slug: ${slug}\nApplied: ${applied}\nFailed: ${failed}${validationTag ? `\nValidation: ${validationTag}` : ''}`,
    status: failed > 0 ? 'error' : 'success',
  });

  console.log(`\nDone: ${applied} applied, ${failed} failed`);
  console.log(`DONE {"applied":${applied},"failed":${failed}}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
