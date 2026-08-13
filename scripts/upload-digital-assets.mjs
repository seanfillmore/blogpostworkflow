#!/usr/bin/env node
/**
 * Upload the built digital-asset PDFs to the Shopify CDN and print their URLs.
 *
 *   node scripts/build-digital-assets.mjs --all      # build first
 *   node scripts/upload-digital-assets.mjs [--apply]
 *
 * `lib/shopify.js` already has `uploadImageToShopifyCDN`, but it is image-only:
 * it passes contentType IMAGE and polls `... on MediaImage`. A PDF comes back as
 * a GenericFile and would never resolve, so this uses the FILE path instead.
 *
 * Filenames are versioned rather than reused. Shopify does not overwrite a file
 * of the same name — it creates a second one with a suffix — so reusing the name
 * would leave you guessing which URL is live. A new name makes the swap explicit,
 * and the old file keeps working for anyone holding a link from a past email.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopifyGraphQL } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const ASSETS = [
  { slug: 'routine-tracker', remote: '90-Day-Calm-Skin-Routine-and-Tracker-v3.pdf', alt: 'The 90-Day Calm-Skin Routine & Tracker' },
  { slug: 'field-guide', remote: 'Coconut-Skincare-Field-Guide-v3.pdf', alt: 'The Coconut Skincare Field Guide' },
];

async function stageUpload(filename, fileSize) {
  const d = await shopifyGraphQL(
    `mutation ($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    { input: [{ filename, mimeType: 'application/pdf', resource: 'FILE', fileSize: String(fileSize), httpMethod: 'POST' }] }
  );
  const errs = d.stagedUploadsCreate.userErrors;
  if (errs.length) throw new Error(`stagedUploadsCreate: ${errs.map((e) => e.message).join(', ')}`);
  return d.stagedUploadsCreate.stagedTargets[0];
}

async function putToStaged(target, buffer, filename) {
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`staged upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function createFile(resourceUrl, alt, filename) {
  const d = await shopifyGraphQL(
    `mutation ($files: [FileCreateInput!]!) {
      fileCreate(files: $files) { files { id fileStatus } userErrors { field message } }
    }`,
    { files: [{ originalSource: resourceUrl, alt, contentType: 'FILE', filename }] }
  );
  const errs = d.fileCreate.userErrors;
  if (errs.length) throw new Error(`fileCreate: ${errs.map((e) => e.message).join(', ')}`);
  return d.fileCreate.files[0].id;
}

async function waitForUrl(id, attempts = 20, delayMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    const d = await shopifyGraphQL(
      `query ($id: ID!) { node(id: $id) { ... on GenericFile { fileStatus url } } }`,
      { id }
    );
    const n = d.node;
    if (n?.fileStatus === 'READY' && n.url) return n.url;
    if (n?.fileStatus === 'FAILED') throw new Error(`file processing FAILED for ${id}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`file not READY after ${attempts} attempts: ${id}`);
}

async function main() {
  const out = {};
  for (const a of ASSETS) {
    const path = join(ROOT, 'data', 'digital-assets', `${a.slug}.pdf`);
    if (!existsSync(path)) throw new Error(`missing ${path} — run build-digital-assets.mjs first`);
    const buf = readFileSync(path);
    console.log(`${a.slug}: ${(buf.length / 1024 / 1024).toFixed(1)} MB → ${a.remote}`);
    if (!APPLY) { console.log('  (dry run)'); continue; }

    const target = await stageUpload(a.remote, buf.length);
    await putToStaged(target, buf, a.remote);
    const id = await createFile(target.resourceUrl, a.alt, a.remote);
    const url = await waitForUrl(id);
    console.log(`  ✓ ${url}`);
    out[a.slug] = url;
  }
  if (APPLY) {
    console.log('\nURLs:');
    for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v}`);
    console.log('\nNext: repoint the Klaviyo delivery template at these, then send yourself a test.');
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
