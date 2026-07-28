/**
 * Build theme/assets/rsc-rum.js from the vendored web-vitals attribution build
 * plus theme/rum/reporter.js.
 *
 * One asset, one storefront request, self-hosted — deliberately not a CDN
 * dependency, because the point of this script is to measure page speed, not
 * add a third-party blocking request to every page.
 *
 * The attribution build (4.2KB gzipped vs 2.6KB for the plain one) is worth the
 * extra 1.6KB: it reports which element was the LCP and which element caused
 * the largest layout shift. Without that, a field CLS regression is a number
 * with no cause attached — exactly the dead end lab data left us in.
 *
 * Usage: node scripts/build-rum-asset.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'node_modules', 'web-vitals', 'dist', 'web-vitals.attribution.iife.js');
const REPORTER = join(ROOT, 'theme', 'rum', 'reporter.js');
const OUT = join(ROOT, 'theme', 'assets', 'rsc-rum.js');

const version = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'web-vitals', 'package.json'), 'utf8'),
).version;

const vendor = readFileSync(VENDOR, 'utf8');
const reporter = readFileSync(REPORTER, 'utf8');

// The IIFE build assigns to `webVitals` as a bare global inside its own scope;
// asserting it lands on window keeps the reporter's feature check honest.
if (!/webVitals/.test(vendor)) {
  throw new Error('vendored web-vitals build does not expose webVitals — check the dist path');
}

const banner = `/* GENERATED FILE — do not edit.
 * Built by scripts/build-rum-asset.mjs from:
 *   - web-vitals ${version} (attribution IIFE build, Google, Apache-2.0)
 *   - theme/rum/reporter.js
 * Regenerate after changing either, then upload with scripts/upload-rum-theme.mjs.
 */
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${banner}${vendor}\n${reporter}`);

const bytes = Buffer.byteLength(readFileSync(OUT));
console.log(`Wrote ${OUT} (${(bytes / 1024).toFixed(1)} KB uncompressed, web-vitals ${version})`);
