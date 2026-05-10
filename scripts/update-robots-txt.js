/**
 * Creates or updates templates/robots.txt.liquid in the live Shopify theme
 * to block AI training crawlers while leaving search-time citation bots
 * (Google-Extended, ClaudeBot, PerplexityBot, OAI-SearchBot, ChatGPT-User)
 * allowed.
 *
 * Backs up the current asset to data/backups/robots.txt.liquid.<timestamp>
 * before writing. If the asset does not exist (Shopify default), the backup
 * records that fact so a future revert is possible.
 *
 * Usage: node scripts/update-robots-txt.js
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
import { getAccessToken } from '../lib/shopify.js';

const STORE = env.SHOPIFY_STORE;
const API = `https://${STORE}/admin/api/2025-01`;
const HEADERS = async () => ({ 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' });

const ROBOTS_LIQUID = `# robots.txt — managed by scripts/update-robots-txt.js
# Renders Shopify's default rules, then appends explicit blocks for AI
# training crawlers. Search-time / citation crawlers are intentionally
# left allowed (Google-Extended, ClaudeBot, PerplexityBot, OAI-SearchBot,
# ChatGPT-User).

{% for group in robots.default_groups -%}
{{- group.user_agent }}
{%- for rule in group.rules -%}
  {{ rule }}
{%- endfor -%}
{%- if group.sitemap != blank %}
{{ group.sitemap }}
{%- endif %}

{% endfor -%}

# AI training crawlers — blocked. We allow search-time bots (Google-Extended,
# ClaudeBot, PerplexityBot, OAI-SearchBot, ChatGPT-User) so the brand can be
# cited in AI Overviews, ChatGPT Search, Perplexity, and claude.ai.
User-agent: GPTBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: meta-externalagent
Disallow: /
`;

async function getMainTheme() {
  const r = await fetch(`${API}/themes.json`, { headers: await HEADERS() });
  const j = await r.json();
  return j.themes.find((t) => t.role === 'main');
}

async function getAsset(themeId, key) {
  const url = `${API}/themes/${themeId}/assets.json?asset%5Bkey%5D=${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: await HEADERS() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`getAsset ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.asset;
}

async function putAsset(themeId, key, value) {
  const r = await fetch(`${API}/themes/${themeId}/assets.json`, {
    method: 'PUT',
    headers: await HEADERS(),
    body: JSON.stringify({ asset: { key, value } }),
  });
  if (!r.ok) throw new Error(`putAsset ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const theme = await getMainTheme();
  if (!theme) throw new Error('No main theme found');
  console.log(`Theme: ${theme.name} (${theme.id})`);

  const key = 'templates/robots.txt.liquid';
  const existing = await getAsset(theme.id, key);

  // Backup
  const backupDir = join(ROOT, 'data', 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `robots.txt.liquid.${stamp}`);
  if (existing && existing.value) {
    writeFileSync(backupPath, existing.value);
    console.log(`Backed up existing template → ${backupPath}`);
  } else {
    writeFileSync(backupPath, '# (no template existed — Shopify default was in use)\n');
    console.log(`No existing template. Marker backup → ${backupPath}`);
  }

  console.log('Writing new template...');
  await putAsset(theme.id, key, ROBOTS_LIQUID);
  console.log('✓ Template written.');

  // Verify by re-fetching live robots.txt
  console.log('\nVerifying live robots.txt (5s delay for cache)...');
  await new Promise((r) => setTimeout(r, 5000));
  const live = await fetch('https://www.realskincare.com/robots.txt');
  const text = await live.text();
  const checks = [
    { name: 'GPTBot blocked',     re: /User-agent:\s*GPTBot[\s\S]*?Disallow:\s*\// },
    { name: 'CCBot blocked',       re: /User-agent:\s*CCBot[\s\S]*?Disallow:\s*\// },
    { name: 'Bytespider blocked',  re: /User-agent:\s*Bytespider[\s\S]*?Disallow:\s*\// },
  ];
  for (const c of checks) console.log(`  ${c.re.test(text) ? '✓' : '✗'} ${c.name}`);
  const stillBlocked = ['Google-Extended', 'ClaudeBot', 'PerplexityBot'];
  for (const bot of stillBlocked) {
    const re = new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Disallow:\\s*/$`, 'm');
    console.log(`  ${re.test(text) ? '✗ STILL BLOCKED:' : '✓ allowed:'} ${bot}`);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
