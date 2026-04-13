/**
 * One-time script to normalize image_path in all post JSON files.
 *
 * - Absolute paths pointing to existing local files → converted to relative (data/images/...)
 * - Absolute paths pointing to non-existent files (ghost paths from other machines) → cleared
 * - Already-relative paths pointing to existing files → left as-is
 * - Already-relative paths pointing to missing files → cleared
 *
 * Usage:
 *   node scripts/fix-image-paths.js            # dry run (shows changes)
 *   node scripts/fix-image-paths.js --apply    # write changes to disk
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const IMAGES_DIR = join(ROOT, 'data', 'images');

const apply = process.argv.includes('--apply');

const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
let cleared = 0, normalized = 0, alreadyGood = 0, noPath = 0;

for (const f of files) {
  const metaPath = join(POSTS_DIR, f);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const slug = meta.slug || basename(f, '.json');

  if (!meta.image_path) {
    noPath++;
    continue;
  }

  const oldPath = meta.image_path;
  const isAbsolute = /^(\/|[A-Z]:)/.test(oldPath);

  // Check if the file actually exists (resolve relative against ROOT)
  const resolved = isAbsolute ? oldPath : join(ROOT, oldPath);
  const fileExists = existsSync(resolved);

  if (fileExists) {
    // Convert absolute → relative
    const rel = relative(ROOT, resolved).replace(/\\/g, '/');
    if (oldPath !== rel) {
      console.log(`NORMALIZE  ${slug}`);
      console.log(`  ${oldPath}  →  ${rel}`);
      meta.image_path = rel;
      normalized++;
      if (apply) writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } else {
      alreadyGood++;
    }
  } else {
    // Ghost path — file doesn't exist on this machine
    console.log(`CLEAR      ${slug}`);
    console.log(`  ${oldPath}  (file not found)`);
    delete meta.image_path;
    delete meta.image_prompt;
    delete meta.image_generated_at;
    cleared++;
    if (apply) writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

console.log(`\n── Summary ──`);
console.log(`  No image_path:   ${noPath}`);
console.log(`  Already correct: ${alreadyGood}`);
console.log(`  Normalized:      ${normalized}`);
console.log(`  Cleared (ghost): ${cleared}`);
console.log(`  Total:           ${files.length}`);
if (!apply) console.log(`\nDry run — no files changed. Pass --apply to write.`);
else console.log(`\nDone — ${normalized + cleared} file(s) updated.`);
