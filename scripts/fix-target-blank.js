/**
 * Fix target="_blank" links in blog post HTML files.
 *
 * Shopify strips <a> tags that have target="_blank" without rel="noopener",
 * causing CTA buttons and links to lose their href and styling.
 *
 * This script:
 * - Internal links (realskincare.com): removes target="_blank" entirely
 * - External links: adds rel="noopener" if missing
 *
 * Usage:
 *   node scripts/fix-target-blank.js            # dry run
 *   node scripts/fix-target-blank.js --apply    # write changes
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');

const apply = process.argv.includes('--apply');

const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.html'));
let filesChanged = 0, internalFixed = 0, externalFixed = 0;

for (const f of files) {
  const filePath = join(POSTS_DIR, f);
  const original = readFileSync(filePath, 'utf8');
  let html = original;

  // Fix <a> tags with target="_blank"
  html = html.replace(/<a\s([^>]*?)target="_blank"([^>]*?)>/gi, (match, before, after) => {
    const fullAttrs = before + after;
    const isInternal = fullAttrs.includes('realskincare.com');
    const hasRel = /rel="[^"]*noopener/.test(fullAttrs);

    if (isInternal) {
      // Internal links: remove target="_blank" entirely
      internalFixed++;
      return `<a ${before.trim()} ${after.trim()}>`.replace(/\s{2,}/g, ' ').replace(' >', '>');
    } else if (!hasRel) {
      // External links without rel="noopener": add it
      externalFixed++;
      return `<a ${before}target="_blank" rel="noopener"${after}>`;
    }
    return match;
  });

  if (html !== original) {
    filesChanged++;
    console.log(`FIX  ${f}`);
    if (apply) writeFileSync(filePath, html);
  }
}

console.log(`\n── Summary ──`);
console.log(`  Internal target="_blank" removed: ${internalFixed}`);
console.log(`  External rel="noopener" added:    ${externalFixed}`);
console.log(`  Files changed:                    ${filesChanged}`);
if (!apply) console.log(`\nDry run — no files changed. Pass --apply to write.`);
else console.log(`\nDone — ${filesChanged} file(s) updated.`);
