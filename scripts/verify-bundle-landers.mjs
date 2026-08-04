/**
 * Bundle lander verification.
 *
 *   node scripts/verify-bundle-landers.mjs --capture   # before any change
 *   node scripts/verify-bundle-landers.mjs --check     # after
 *
 * The four non-Reset bundles share the template being edited. Their rendered
 * pages must not change. Byte comparison is too strict — Shopify varies script
 * nonces and session tokens per request — so this compares NORMALIZED VISIBLE
 * TEXT, which is what "no visible change" actually means.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLES = [
  '99-coconut-reset-digital',
  '90-day-clean-swap',
  'head-to-toe',
  'clean-swap',
  'gift-box',
];
const DIR = 'data/reports/bundle-landers';
const BASE = 'https://www.realskincare.com/products/';

export function normalize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sectionKeys(html) {
  const m = html.match(/shopify-section-template--\d+__([a-zA-Z0-9_-]+)/g) || [];
  return [...new Set(m.map((s) => s.split('__')[1]))].sort();
}

async function fetchPage(handle) {
  const res = await fetch(BASE + handle, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${handle}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'capture';
  mkdirSync(DIR, { recursive: true });
  let failures = 0;

  for (const handle of BUNDLES) {
    const html = await fetchPage(handle);
    const file = join(DIR, `baseline-${handle}.txt`);

    if (mode === 'capture') {
      writeFileSync(file, normalize(html));
      console.log(`captured ${handle} (${sectionKeys(html).length} sections)`);
      continue;
    }

    if (handle === '99-coconut-reset-digital') {
      const text = normalize(html);
      const must = ['Total value $174', 'You save $53'];
      const mustNot = ['$208', '$87'];
      for (const s of must) {
        if (!text.includes(s)) { console.error(`FAIL ${handle}: missing "${s}"`); failures++; }
      }
      for (const s of mustNot) {
        if (text.includes(s)) { console.error(`FAIL ${handle}: still shows "${s}"`); failures++; }
      }
      console.log(`sections: ${sectionKeys(html).join(', ')}`);
      continue;
    }

    if (!existsSync(file)) { console.error(`FAIL ${handle}: no baseline captured`); failures++; continue; }
    if (readFileSync(file, 'utf8') !== normalize(html)) {
      console.error(`FAIL ${handle}: visible text changed — this bundle must be untouched`);
      failures++;
    } else {
      console.log(`ok   ${handle} unchanged`);
    }
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
