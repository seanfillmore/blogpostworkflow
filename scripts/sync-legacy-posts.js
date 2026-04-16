/**
 * Pulls every blog article from Shopify and writes a local copy under
 * data/posts/<handle>.json + data/posts/<handle>.html for any post that
 * doesn't already have local files. This brings legacy posts written
 * before the current pipeline into the rewriter's audit set.
 *
 * Existing local files are NOT touched. Run again at any time to pick up
 * newly added posts.
 *
 * Usage:
 *   node scripts/sync-legacy-posts.js
 *   node scripts/sync-legacy-posts.js --force   # overwrite local files too
 */
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles } from '../lib/shopify.js';
import { getMetaPath, getContentPath, ensurePostDir, classifyPostType, POSTS_DIR } from '../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const force = process.argv.includes('--force');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Walk data/posts/ once up-front and build { shopify_article_id -> slug }.
// sync-legacy-posts previously only checked for a file named after the Shopify
// handle. That missed every post that the writer had saved under its
// target-keyword slug, producing 40 duplicate records. Keyed on the Shopify
// article ID is the only reliable identity check.
function buildExistingIndex() {
  const index = new Map();
  if (!existsSync(POSTS_DIR)) return index;
  for (const slug of readdirSync(POSTS_DIR)) {
    const metaPath = join(POSTS_DIR, slug, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.shopify_article_id) index.set(meta.shopify_article_id, slug);
    } catch { /* skip unreadable */ }
  }
  return index;
}

async function main() {
  mkdirSync(POSTS_DIR, { recursive: true });
  const blogs = await getBlogs();
  console.log(`Found ${blogs.length} blog(s).`);

  const existingByArticleId = buildExistingIndex();
  console.log(`Existing local records: ${existingByArticleId.size}`);

  let total = 0, written = 0, skipped = 0, skippedAlias = 0;
  for (const blog of blogs) {
    // Paginate via since_id
    let sinceId = 0;
    while (true) {
      const articles = await getArticles(blog.id, { limit: 250, since_id: sinceId });
      if (!articles.length) break;
      for (const a of articles) {
        total++;
        const slug = a.handle || slugify(a.title);
        const jsonPath = getMetaPath(slug);
        const htmlPath = getContentPath(slug);

        if (!force && existsSync(jsonPath) && existsSync(htmlPath)) {
          skipped++;
          continue;
        }

        // If another directory already has a meta.json for this Shopify article,
        // skip to avoid creating a duplicate local record.
        if (!force && existingByArticleId.has(a.id)) {
          const existingSlug = existingByArticleId.get(a.id);
          if (existingSlug !== slug) {
            console.log(`  skip ${slug}: already have local record at data/posts/${existingSlug}/ (shopify_article_id ${a.id})`);
            skippedAlias++;
            continue;
          }
        }

        // Legacy posts don't carry a brief, so we have no canonical target
        // keyword. Take the first clause of the title (before the first
        // : – — , or |) — that's the topical phrase by SEO convention. Fall
        // back to the slug-as-prose if the title has no separator and is too
        // long, or to the slug verbatim if title is empty. Empty string is
        // never written: it broke the editor's product-spec classifier
        // (kw.includes('toothpaste') failed on '' → wrong spec checked).
        const titleHead = (a.title || '').split(/[:–—,|]/)[0].trim();
        const slugAsKeyword = slug.replace(/-/g, ' ');
        const targetKeyword = titleHead || slugAsKeyword;

        // post_type: 'product' for posts that map to a SKU we sell;
        // 'topical_authority' for off-product content (DIY tutorials,
        // ingredient education). The editor uses this to skip its
        // INGREDIENT ACCURACY check on topical posts (where there's no
        // canonical product spec to validate against).
        const postType = classifyPostType(targetKeyword, slug);

        const meta = {
          slug,
          title: a.title,
          meta_description: a.summary_html?.replace(/<[^>]+>/g, '').trim() || '',
          target_keyword: targetKeyword,
          post_type: postType,
          tags: (a.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
          shopify_blog_id: blog.id,
          shopify_blog_handle: blog.handle,
          shopify_article_id: a.id,
          shopify_handle: a.handle,
          shopify_publish_at: a.published_at,
          legacy_synced_at: new Date().toISOString(),
          legacy_source: 'sync-legacy-posts.js',
        };

        ensurePostDir(slug);
        writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
        writeFileSync(htmlPath, a.body_html || '');
        existingByArticleId.set(a.id, slug);
        written++;
      }
      sinceId = articles[articles.length - 1].id;
      if (articles.length < 250) break;
    }
  }
  console.log(`\nTotal articles in Shopify: ${total}`);
  console.log(`Written:          ${written}`);
  console.log(`Skipped (local):  ${skipped}`);
  console.log(`Skipped (alias):  ${skippedAlias} (already synced under a different slug)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
