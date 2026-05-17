#!/usr/bin/env node
/**
 * Backfill buyer-intent modifier tags onto existing Shopify articles.
 *
 * Reads each blog article's title and adds any missing buyer-intent modifier
 * tags (sensitive skin / aluminum free / fluoride free / for women / for men /
 * for kids / pregnancy safe / travel size). Never removes existing tags.
 * Idempotent — re-running on already-backfilled articles is a no-op.
 *
 * Pairs with agents/blog-post-writer/index.js deriveTags() — the modifier set
 * here mirrors what new articles get going forward. Keep in sync if updated.
 *
 * Usage:
 *   node scripts/backfill-buyer-intent-tags.mjs            # dry-run report
 *   node scripts/backfill-buyer-intent-tags.mjs --apply    # actually update Shopify
 */

import { getBlogs, getArticles, updateArticle } from '../lib/shopify.js';

const apply = process.argv.includes('--apply');

function deriveModifierTags(title) {
  const t = title.toLowerCase();
  const hasWord = (w) => new RegExp(`\\b${w}\\b`).test(t);
  const tags = [];
  if (hasWord('sensitive')) {
    // 'sensitive teeth' and 'sensitive skin' are distinct buyer segments —
    // disambiguate by toothpaste context.
    tags.push(t.includes('tooth') ? 'sensitive teeth' : 'sensitive skin');
  }
  if (t.includes('aluminum')) tags.push('aluminum free');
  if (t.includes('fluoride')) tags.push('fluoride free');
  if (hasWord('women')) tags.push('for women');
  if (hasWord('men')) tags.push('for men');
  if (hasWord('kids') || hasWord('children')) tags.push('for kids');
  if (hasWord('pregnancy') || hasWord('pregnant')) tags.push('pregnancy safe');
  if (hasWord('travel')) tags.push('travel size');
  return tags;
}

function parseTags(tagString) {
  return (tagString || '').split(',').map((t) => t.trim()).filter(Boolean);
}

async function main() {
  console.log(`\nBackfill buyer-intent tags (${apply ? 'APPLY' : 'DRY-RUN'})\n`);

  const blogs = await getBlogs();
  let processed = 0;
  let modified = 0;

  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const article of articles) {
      processed++;
      const existingTags = parseTags(article.tags);
      const existingLower = new Set(existingTags.map((t) => t.toLowerCase()));
      const wantedModifiers = deriveModifierTags(article.title);
      const additions = wantedModifiers.filter((t) => !existingLower.has(t.toLowerCase()));
      if (additions.length === 0) continue;

      modified++;
      const newTags = [...existingTags, ...additions];
      console.log(`  ${article.title}`);
      console.log(`    + ${additions.join(', ')}`);

      if (apply) {
        await updateArticle(blog.id, article.id, { tags: newTags.join(', ') });
      }
    }
  }

  console.log(`\n${apply ? 'Applied' : 'Would apply'}: ${modified} article(s) updated of ${processed} processed.`);
  if (!apply && modified > 0) {
    console.log('Re-run with --apply to write changes.');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
