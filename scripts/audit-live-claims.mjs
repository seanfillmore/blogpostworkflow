#!/usr/bin/env node
/**
 * Audit every live Klaviyo template for stale brand facts.
 *
 *   node scripts/audit-live-claims.mjs
 *
 * Checks each live template for:
 *   - an origin claim naming a place (products are made in the USA, never a city/state)
 *   - the superseded postal address
 *   - href="{% unsubscribe %}", which leaks raw markup into the footer
 *
 * Reads the current address from brand-kit.json so it cannot drift from the renderer.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = JSON.parse(readFileSync(join(ROOT, 'data/brand/brand-kit.json'), 'utf8'));

const KEY = readFileSync(join(ROOT, '.env'), 'utf8')
  .split('\n').find((l) => l.startsWith('KLAVIYO_PRIVATE_KEY='))
  ?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const ORIGIN_CLAIM = /\b(made|handmade|hand-made|mixed|blended|crafted|produced|manufactured|poured|bottled)\b[^.<]{0,60}\b(in|at)\b[^.<]{0,40}\b(Blum|Texas|TX|Cheyenne|Wyoming|WY)\b/i;
const OLD_ADDRESS = /6212 FM 933/;
const BAD_UNSUB = /href="\{%\s*unsubscribe\s*%\}"/;

async function get(path) {
  const res = await fetch(`https://a.klaviyo.com/api/${path}`, {
    headers: { Authorization: `Klaviyo-API-Key ${KEY}`, revision: '2024-10-15' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

const audit = JSON.parse(
  readFileSync(join(ROOT, 'data/reports/email-audit/2026-07-31.json'), 'utf8'),
);

const rows = [];
for (const r of audit.rows) {
  let html;
  try {
    html = (await get(`templates/${r.templateId}/`))?.data?.attributes?.html ?? '';
  } catch (e) {
    rows.push({ id: r.templateId, name: r.message, error: e.message });
    continue;
  }
  if (!html) {
    rows.push({ id: r.templateId, name: r.message, error: 'empty html' });
    continue;
  }
  const body = html.replace(KIT.postal_address, '');
  rows.push({
    id: r.templateId,
    name: r.message,
    origin: ORIGIN_CLAIM.test(body) ? body.match(ORIGIN_CLAIM)[0].trim().slice(0, 50) : '',
    oldAddress: OLD_ADDRESS.test(html),
    badUnsub: BAD_UNSUB.test(html),
    bytes: html.length,
  });
}

const bad = rows.filter((r) => r.error || r.origin || r.oldAddress || r.badUnsub);

for (const r of rows) {
  if (r.error) { console.log(`✗ ${r.id.padEnd(8)} ERROR ${r.error}`); continue; }
  const flags = [
    r.origin ? `ORIGIN:"${r.origin}"` : '',
    r.oldAddress ? 'OLD-ADDRESS' : '',
    r.badUnsub ? 'BAD-UNSUB' : '',
  ].filter(Boolean).join('  ');
  console.log(`${flags ? '✗' : '✓'} ${r.id.padEnd(8)} ${r.name.padEnd(42)} ${flags}`);
}

console.log(`\n${rows.length - bad.length}/${rows.length} clean`);
if (bad.length) console.log(`${bad.length} need attention`);
