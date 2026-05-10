#!/usr/bin/env node
/**
 * Delete orphan files from Shopify Files via fileDelete mutation.
 *
 * Orphans (no longer referenced by any theme template) are passed by filename;
 * we resolve each to its file gid via the files() query, then issue fileDelete.
 *
 * Usage:
 *   node scripts/delete-orphan-shopify-files.mjs <filename> [<filename> ...]
 *   node scripts/delete-orphan-shopify-files.mjs --dry-run <filename> ...
 */

import { readFileSync } from 'fs';

function loadEnv() {
  const lines = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();

const STORE   = env.SHOPIFY_STORE;
const SECRET  = env.SHOPIFY_SECRET;
const API_VER = '2025-01';
if (!STORE || !SECRET) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_SECRET in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filenames = args.filter(a => a !== '--dry-run');
if (!filenames.length) {
  console.error('Usage: node scripts/delete-orphan-shopify-files.mjs [--dry-run] <filename> [<filename> ...]');
  process.exit(1);
}

const GQL_URL = `https://${STORE}/admin/api/${API_VER}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join(', '));
  return json.data;
}

async function findFileIdByFilename(filename) {
  // Shopify's files() query supports a "filename:" search prefix.
  const data = await gql(
    `query find($q: String!) {
      files(first: 5, query: $q) {
        nodes {
          id
          ... on MediaImage { image { url } }
        }
      }
    }`,
    { q: `filename:${filename}` }
  );
  const nodes = data.files.nodes;
  if (!nodes.length) return null;
  if (nodes.length > 1) {
    // Tighten match by suffix on the URL
    const exact = nodes.find(n => (n.image?.url || '').includes(filename));
    if (exact) return exact.id;
  }
  return nodes[0].id;
}

async function deleteFiles(ids) {
  const data = await gql(
    `mutation del($ids: [ID!]!) {
      fileDelete(fileIds: $ids) {
        deletedFileIds
        userErrors { field message }
      }
    }`,
    { ids }
  );
  return data.fileDelete;
}

const targets = [];
for (const f of filenames) {
  const id = await findFileIdByFilename(f);
  if (!id) {
    console.log(`  ! ${f} — not found on Shopify Files (already deleted?)`);
    continue;
  }
  console.log(`  ${f} -> ${id}`);
  targets.push({ filename: f, id });
}

if (!targets.length) {
  console.log('Nothing to delete.');
  process.exit(0);
}

if (dryRun) {
  console.log(`\nDry-run: would delete ${targets.length} file(s).`);
  process.exit(0);
}

const result = await deleteFiles(targets.map(t => t.id));
if (result.userErrors.length) {
  console.error('\nUser errors:');
  for (const e of result.userErrors) console.error(`  ${e.field}: ${e.message}`);
}
console.log(`\nDeleted ${result.deletedFileIds.length}/${targets.length} files.`);
for (const id of result.deletedFileIds) {
  const t = targets.find(x => x.id === id);
  console.log(`  ✓ ${t?.filename || id}`);
}
