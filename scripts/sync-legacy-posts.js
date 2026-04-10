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
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles } from '../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const CANONICAL_ROOT = (CONFIG.url || '').replace(/\/$/, '');

const force = process.argv.includes('--force');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  mkdirSync(POSTS_DIR, { recursive: true });
  const blogs = await getBlogs();
  console.log(`Found ${blogs.length} blog(s).`);

  let total = 0, written = 0, skipped = 0;
  for (const blog of blogs) {
    // Paginate via since_id
    let sinceId = 0;
    while (true) {
      const articles = await getArticles(blog.id, { limit: 250, since_id: sinceId });
      if (!articles.length) break;
      for (const a of articles) {
        total++;
        const slug = a.handle || slugify(a.title);
        const jsonPath = join(POSTS_DIR, `${slug}.json`);
        const htmlPath = join(POSTS_DIR, `${slug}.html`);

        if (!force && existsSync(jsonPath) && existsSync(htmlPath)) {
          skipped++;
          continue;
        }

        const meta = {
          slug,
          title: a.title,
          meta_description: a.summary_html?.replace(/<[^>]+>/g, '').trim() || '',
          target_keyword: '',  // unknown for legacy posts; rewriter will fall back to title
          tags: (a.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
          shopify_blog_id: blog.id,
          shopify_blog_handle: blog.handle,
          shopify_article_id: a.id,
          shopify_handle: a.handle,
          shopify_publish_at: a.published_at,
          // Canonical public URL — needed by indexing-checker and other agents
          // that query GSC URL Inspection.
          shopify_url: `${CANONICAL_ROOT}/blogs/${blog.handle}/${a.handle}`,
          // Legacy posts come from Shopify's published article list, so they
          // ARE published. Without this flag, indexing-checker and every other
          // downstream agent skips them because they look unpublished.
          shopify_status: 'published',
          published_at: a.published_at,
          legacy_synced_at: new Date().toISOString(),
          legacy_source: 'sync-legacy-posts.js',
        };

        writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
        writeFileSync(htmlPath, a.body_html || '');
        written++;
      }
      sinceId = articles[articles.length - 1].id;
      if (articles.length < 250) break;
    }
  }
  console.log(`\nTotal articles in Shopify: ${total}`);
  console.log(`Written:  ${written}`);
  console.log(`Skipped:  ${skipped} (already have local files)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
