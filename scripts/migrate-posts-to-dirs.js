/**
 * Migration script: flat post files → directory-per-post layout.
 *
 * Moves:
 *   data/posts/{slug}.json                          → data/posts/{slug}/meta.json
 *   data/posts/{slug}.html                          → data/posts/{slug}/content.html
 *   data/posts/{slug}-refreshed.html                → data/posts/{slug}/content-refreshed.html
 *   data/posts/{slug}-refreshed.json                → (deleted — redundant)
 *   data/posts/{slug}.backup-*.html                 → data/posts/{slug}/backups/
 *   data/reports/editor/{slug}-editor-report.md     → data/posts/{slug}/editor-report.md
 *   data/reports/editor/{slug}-refreshed-editor-report.md → data/posts/{slug}/editor-report.md
 *   data/reports/internal-linker/{slug}-internal-links.md → data/posts/{slug}/internal-links.md
 *   data/reports/answer-first/rewrites/{slug}.md    → data/posts/{slug}/answer-first.md
 *   data/images/{slug}.webp                         → data/posts/{slug}/image.webp
 *
 * Idempotent: safe to re-run. Skips already-migrated posts.
 *
 * Usage:
 *   node scripts/migrate-posts-to-dirs.js            # dry run
 *   node scripts/migrate-posts-to-dirs.js --apply    # write changes
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const EDITOR_REPORTS_DIR = join(ROOT, 'data', 'reports', 'editor');
const INTERNAL_LINKS_DIR = join(ROOT, 'data', 'reports', 'internal-linker');
const ANSWER_FIRST_DIR = join(ROOT, 'data', 'reports', 'answer-first', 'rewrites');
const IMAGES_DIR = join(ROOT, 'data', 'images');

const apply = process.argv.includes('--apply');

// ── helpers ──────────────────────────────────────────────────────────────────

function move(src, dest, label) {
  if (!existsSync(src)) return false;
  if (existsSync(dest)) {
    console.log(`  SKIP ${label} (dest exists)`);
    return false;
  }
  console.log(`  MOVE ${label}`);
  if (apply) renameSync(src, dest);
  return true;
}

function remove(src, label) {
  if (!existsSync(src)) return;
  console.log(`  DEL  ${label}`);
  if (apply) unlinkSync(src);
}

// ── discover slugs from flat .json files ─────────────────────────────────────

const allFiles = existsSync(POSTS_DIR) ? readdirSync(POSTS_DIR) : [];
const jsonFiles = allFiles.filter(f => f.endsWith('.json') && !f.includes('/'));

// Build slug list: skip -refreshed.json files and already-migrated directories
const slugs = [];
for (const f of jsonFiles) {
  // Skip if this is inside a subdirectory (already migrated)
  const fullPath = join(POSTS_DIR, f);
  try { if (statSync(fullPath).isDirectory()) continue; } catch { continue; }

  const slug = basename(f, '.json');
  if (slug.endsWith('-refreshed')) continue; // handled with parent slug
  slugs.push(slug);
}

console.log(`Found ${slugs.length} posts to migrate.\n`);

let migrated = 0, skipped = 0;
const orphans = [];

for (const slug of slugs) {
  const destDir = join(POSTS_DIR, slug);
  const backupsDir = join(destDir, 'backups');

  // Check if already migrated
  if (existsSync(join(destDir, 'meta.json'))) {
    skipped++;
    continue;
  }

  console.log(`${slug}:`);

  // Create directory structure
  if (apply) mkdirSync(backupsDir, { recursive: true });
  else console.log(`  MKDIR ${slug}/backups/`);

  // Core files
  move(join(POSTS_DIR, `${slug}.json`), join(destDir, 'meta.json'), `${slug}.json → meta.json`);
  move(join(POSTS_DIR, `${slug}.html`), join(destDir, 'content.html'), `${slug}.html → content.html`);

  // Refreshed files
  move(join(POSTS_DIR, `${slug}-refreshed.html`), join(destDir, 'content-refreshed.html'), `${slug}-refreshed.html → content-refreshed.html`);
  remove(join(POSTS_DIR, `${slug}-refreshed.json`), `${slug}-refreshed.json (redundant)`);

  // Backup files (may be named {slug}.backup-* or {slug}-refreshed.backup-*)
  for (const f of allFiles) {
    if ((f.startsWith(`${slug}.backup-`) || f.startsWith(`${slug}-refreshed.backup-`)) && f.endsWith('.html')) {
      move(join(POSTS_DIR, f), join(backupsDir, f), `${f} → backups/`);
    }
  }

  // Editor reports
  if (existsSync(EDITOR_REPORTS_DIR)) {
    // Refreshed report overwrites original (it's newer)
    const origReport = join(EDITOR_REPORTS_DIR, `${slug}-editor-report.md`);
    const refreshedReport = join(EDITOR_REPORTS_DIR, `${slug}-refreshed-editor-report.md`);
    const destReport = join(destDir, 'editor-report.md');

    if (existsSync(refreshedReport)) {
      move(refreshedReport, destReport, `${slug}-refreshed-editor-report.md → editor-report.md`);
      remove(origReport, `${slug}-editor-report.md (superseded by refreshed)`);
    } else {
      move(origReport, destReport, `${slug}-editor-report.md → editor-report.md`);
    }
  }

  // Internal links report
  if (existsSync(INTERNAL_LINKS_DIR)) {
    move(
      join(INTERNAL_LINKS_DIR, `${slug}-internal-links.md`),
      join(destDir, 'internal-links.md'),
      `internal-linker/${slug}-internal-links.md → internal-links.md`
    );
  }

  // Answer-first rewrite
  if (existsSync(ANSWER_FIRST_DIR)) {
    move(
      join(ANSWER_FIRST_DIR, `${slug}.md`),
      join(destDir, 'answer-first.md'),
      `answer-first/rewrites/${slug}.md → answer-first.md`
    );
  }

  // Hero image
  const imgSrc = join(IMAGES_DIR, `${slug}.webp`);
  if (existsSync(imgSrc)) {
    move(imgSrc, join(destDir, 'image.webp'), `images/${slug}.webp → image.webp`);
  }

  // Update image_path in meta.json
  const metaDest = join(destDir, 'meta.json');
  if (apply && existsSync(metaDest)) {
    try {
      const meta = JSON.parse(readFileSync(metaDest, 'utf8'));
      if (existsSync(join(destDir, 'image.webp'))) {
        meta.image_path = `data/posts/${slug}/image.webp`;
      } else {
        delete meta.image_path;
      }
      writeFileSync(metaDest, JSON.stringify(meta, null, 2));
    } catch { /* skip */ }
  } else if (!apply && existsSync(join(POSTS_DIR, `${slug}.json`))) {
    try {
      const meta = JSON.parse(readFileSync(join(POSTS_DIR, `${slug}.json`), 'utf8'));
      if (meta.image_path || existsSync(imgSrc)) {
        console.log(`  UPDATE meta.json image_path → data/posts/${slug}/image.webp`);
      }
    } catch { /* skip */ }
  }

  migrated++;
  console.log('');
}

// ── report orphans ───────────────────────────────────────────────────────────

const postFilesAfter = existsSync(POSTS_DIR) ? readdirSync(POSTS_DIR) : [];
for (const f of postFilesAfter) {
  const fullPath = join(POSTS_DIR, f);
  try {
    if (!statSync(fullPath).isDirectory() && !apply) {
      // In dry-run mode, check if this file would be orphaned after migration
      // (it's not a directory and not one of the files we're moving)
    }
  } catch { /* skip */ }
}

console.log(`── Summary ──`);
console.log(`  Migrated:  ${migrated}`);
console.log(`  Skipped:   ${skipped} (already migrated)`);
console.log(`  Total:     ${slugs.length}`);
if (!apply) console.log(`\nDry run — no files changed. Pass --apply to write.`);
else console.log(`\nDone.`);
