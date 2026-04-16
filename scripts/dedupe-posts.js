/**
 * Dedupe data/posts/
 *
 * Finds every post directory that shares a shopify_article_id with another
 * directory and keeps one. Canonical record = the writer-produced one (has a
 * brief_path or generated_at). The other is a sync-legacy-posts.js artifact
 * keyed to the Shopify handle and is deleted.
 *
 * Safe to re-run. Use --dry-run to preview.
 *
 * Usage:
 *   node scripts/dedupe-posts.js --dry-run
 *   node scripts/dedupe-posts.js
 */

import { readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');

const dryRun = process.argv.includes('--dry-run');

function loadMeta(slug) {
  const metaPath = join(POSTS_DIR, slug, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try { return JSON.parse(readFileSync(metaPath, 'utf8')); } catch { return null; }
}

function scoreCanonical(meta) {
  // Higher score = more likely the canonical record.
  // Writer-produced posts have a brief_path, generated_at, and/or word_count.
  // Legacy-synced records have legacy_source and no brief.
  let score = 0;
  if (meta.brief_path) score += 10;
  if (meta.generated_at) score += 5;
  if (meta.word_count) score += 3;
  if (meta.target_keyword) score += 2;
  if (meta.uploaded_at) score += 1;
  if (meta.legacy_source) score -= 5;
  return score;
}

function main() {
  const slugs = readdirSync(POSTS_DIR).filter((s) => {
    try { return existsSync(join(POSTS_DIR, s, 'meta.json')); } catch { return false; }
  });

  const byArticleId = new Map();
  for (const slug of slugs) {
    const meta = loadMeta(slug);
    if (!meta?.shopify_article_id) continue;
    if (!byArticleId.has(meta.shopify_article_id)) byArticleId.set(meta.shopify_article_id, []);
    byArticleId.get(meta.shopify_article_id).push({ slug, meta });
  }

  const duplicates = [...byArticleId.entries()].filter(([, recs]) => recs.length > 1);

  console.log(`Total post directories: ${slugs.length}`);
  console.log(`Distinct shopify_article_ids: ${byArticleId.size}`);
  console.log(`Duplicate groups: ${duplicates.length}\n`);

  if (duplicates.length === 0) {
    console.log('Nothing to dedupe.');
    return;
  }

  let affected = 0;
  for (const [articleId, recs] of duplicates) {
    const scored = recs.map((r) => ({ ...r, score: scoreCanonical(r.meta) }))
                       .sort((a, b) => b.score - a.score);
    const keep = scored[0];
    const drop = scored.slice(1);

    console.log(`article ${articleId}`);
    console.log(`  keep:   ${keep.slug} (score ${keep.score})`);
    for (const d of drop) {
      console.log(`  delete: ${d.slug} (score ${d.score})${dryRun ? ' [dry-run]' : ''}`);
      if (!dryRun) rmSync(join(POSTS_DIR, d.slug), { recursive: true, force: true });
      affected++;
    }
  }

  console.log(`\n${dryRun ? 'Would delete' : 'Deleted'}: ${affected} director${affected === 1 ? 'y' : 'ies'}`);
}

main();
