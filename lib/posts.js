/**
 * Shared post path resolution module.
 *
 * Every agent that reads or writes post files should import from here
 * instead of constructing paths from slugs. This prevents the class of bugs
 * where one agent introduces a suffix or naming convention that others miss.
 *
 * Layout:
 *   data/posts/{slug}/
 *     content.html            — post body
 *     meta.json               — metadata (Shopify IDs, keywords, etc.)
 *     content-refreshed.html  — draft from content-refresher
 *     editor-report.md        — latest editor report
 *     internal-links.md       — internal linking report
 *     answer-first.md         — answer-first rewrite suggestion
 *     image.webp              — hero image
 *     backups/                — timestamped backups of content.html
 */

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const POSTS_DIR = join(ROOT, 'data', 'posts');

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getPostDir(slug) {
  return join(POSTS_DIR, slug);
}

export function getContentPath(slug) {
  return join(POSTS_DIR, slug, 'content.html');
}

export function getMetaPath(slug) {
  return join(POSTS_DIR, slug, 'meta.json');
}

export function getRefreshedPath(slug) {
  return join(POSTS_DIR, slug, 'content-refreshed.html');
}

export function getEditorReportPath(slug) {
  return join(POSTS_DIR, slug, 'editor-report.md');
}

export function getInternalLinksPath(slug) {
  return join(POSTS_DIR, slug, 'internal-links.md');
}

export function getAnswerFirstPath(slug) {
  return join(POSTS_DIR, slug, 'answer-first.md');
}

export function getImagePath(slug) {
  return join(POSTS_DIR, slug, 'image.webp');
}

export function getBackupsDir(slug) {
  return join(POSTS_DIR, slug, 'backups');
}

// ── Higher-level helpers ─────────────────────────────────────────────────────

/**
 * List all post slugs (directory names that contain meta.json).
 */
export function listAllSlugs() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter(name => {
      const dir = join(POSTS_DIR, name);
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'meta.json'));
      } catch { return false; }
    })
    .sort();
}

/**
 * Read and parse a post's meta.json. Returns the object or null on error.
 */
export function getPostMeta(slug) {
  try {
    return JSON.parse(readFileSync(getMetaPath(slug), 'utf8'));
  } catch { return null; }
}

/**
 * Ensure the post directory and backups subdirectory exist.
 */
export function ensurePostDir(slug) {
  mkdirSync(getBackupsDir(slug), { recursive: true });
}
