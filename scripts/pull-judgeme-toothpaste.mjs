// Pulls all Judge.me reviews for a Shopify product handle and writes them to
// data/brand/_research/judgeme-<handle>.md as research material for the PDP
// foundation content (Plan 2 / Plan 6).
//
// Usage: node scripts/pull-judgeme-toothpaste.mjs [handle]
// Default handle: coconut-oil-toothpaste

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolveExternalId, fetchProductReviews } from '../lib/judgeme.js';

function loadEnv() {
  const lines = readFileSync('.env', 'utf8').split('\n');
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
const SHOP = env.SHOPIFY_STORE;  // .myshopify.com form per lib/judgeme.js docstring
const HANDLE = process.argv[2] || 'coconut-oil-toothpaste';

if (!env.JUDGEME_API_TOKEN) {
  console.error('Missing JUDGEME_API_TOKEN in .env');
  process.exit(1);
}
if (!SHOP) {
  console.error('Missing SHOPIFY_STORE in .env');
  process.exit(1);
}

console.log(`Resolving external ID for ${HANDLE}...`);
const externalId = await resolveExternalId(HANDLE, SHOP, env.JUDGEME_API_TOKEN);
if (!externalId) {
  console.error(`Could not resolve external ID for ${HANDLE}`);
  process.exit(1);
}
console.log(`External ID: ${externalId}`);

console.log(`Fetching reviews...`);
const reviews = await fetchProductReviews(externalId, SHOP, env.JUDGEME_API_TOKEN);
console.log(`Fetched ${reviews.length} reviews for ${HANDLE}`);

const outDir = 'data/brand/_research';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const md = [
  `# Judge.me reviews — ${HANDLE}`,
  ``,
  `Pulled: ${new Date().toISOString()}`,
  `Total: ${reviews.length}`,
  ``,
  `---`,
  ``,
  ...reviews.map((r, i) => [
    `## Review ${i + 1} — ${r.rating}★ — ${r.reviewer?.name || 'Anonymous'}`,
    `Date: ${r.created_at || 'unknown'}`,
    `Title: ${r.title || '(no title)'}`,
    ``,
    r.body || '(no body)',
    ``,
  ].join('\n')),
].join('\n');

const outPath = `${outDir}/judgeme-${HANDLE}.md`;
writeFileSync(outPath, md);
console.log(`Saved to ${outPath}`);
