/**
 * Legacy Post Rebuilder
 *
 * Identifies blog posts that lack FAQ schema (a proxy for "built before the
 * current pipeline existed") and reruns them through the full content
 * pipeline: research → write → image → answer-first → featured-product →
 * schema → editor → publish as article update.
 *
 * Usage:
 *   node agents/legacy-rebuilder/index.js                    # list legacy posts (dry run)
 *   node agents/legacy-rebuilder/index.js <slug> --apply     # rebuild one post
 *   node agents/legacy-rebuilder/index.js --limit 3 --apply  # rebuild N posts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getContentPath, getPostMeta, getMetaPath } from '../../lib/posts.js';
import { getArticle, updateArticle, getBlogs } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BACKUPS_DIR = join(ROOT, 'data', 'backups', 'legacy-rebuild');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const slugArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');

function isLegacy(slug) {
  const p = getContentPath(slug);
  if (!existsSync(p)) return false;
  const html = readFileSync(p, 'utf8');
  return !html.includes('FAQPage');
}

function findLegacyPosts() {
  return listAllSlugs()
    .filter((slug) => isLegacy(slug))
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter((p) => p.meta && p.meta.shopify_article_id);
}

function run(cmd, label) {
  console.log(`  > ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    console.error(`  ✗ ${label} failed`);
    return false;
  }
}

async function rebuildPost(slug) {
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for ${slug}`);
  if (!meta.shopify_article_id || !meta.shopify_blog_id) {
    throw new Error(`Missing shopify_article_id or shopify_blog_id for ${slug}`);
  }
  const keyword = meta.target_keyword || meta.title;
  if (!keyword) throw new Error(`No target_keyword for ${slug}`);

  console.log(`\nRebuilding: ${slug}`);
  console.log(`  Keyword: ${keyword}`);
  console.log(`  Article ID: ${meta.shopify_article_id}`);

  // Backup original body_html from Shopify (live version, not local)
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const liveArticle = await getArticle(meta.shopify_blog_id, meta.shopify_article_id);
  const backupPath = join(BACKUPS_DIR, `${slug}.${stamp}.html`);
  writeFileSync(backupPath, liveArticle.body_html || '');
  console.log(`  Backup saved: ${backupPath}`);

  // Pipeline steps
  if (!run(`node agents/content-researcher/index.js "${keyword}"`, `research: ${keyword}`)) return false;
  if (!run(`node agents/blog-post-writer/index.js data/briefs/${slug}.json`, `write: ${slug}`)) return false;

  const imagePath = join(ROOT, 'data', 'images', `${slug}.webp`);
  if (!existsSync(imagePath) && !existsSync(imagePath.replace('.webp', '.png'))) {
    if (!run(`node agents/image-generator/index.js data/posts/${slug}.json`, `image: ${slug}`)) return false;
  }

  run(`node agents/answer-first-rewriter/index.js ${slug} --apply`, `answer-first: ${slug}`);
  run(`node agents/featured-product-injector/index.js --handle ${slug}`, `featured-product: ${slug}`);
  run(`node agents/schema-injector/index.js --slug ${slug} --apply`, `schema: ${slug}`);

  if (!run(`node agents/editor/index.js ${getContentPath(slug)}`, `editor: ${slug}`)) {
    console.error(`  ⛔ Editor failed — aborting rebuild, original post untouched on Shopify`);
    return false;
  }

  // Push to Shopify as an update (same article_id)
  const rebuiltHtml = readFileSync(getContentPath(slug), 'utf8');
  await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { body_html: rebuiltHtml });
  console.log(`  ✓ Published to Shopify (article_id: ${meta.shopify_article_id})`);

  // Stamp metadata
  const updatedMeta = { ...getPostMeta(slug), rebuilt_at: new Date().toISOString() };
  writeFileSync(getMetaPath(slug), JSON.stringify(updatedMeta, null, 2));

  return true;
}

async function main() {
  console.log('\nLegacy Post Rebuilder\n');

  const legacy = findLegacyPosts();
  console.log(`Found ${legacy.length} legacy post(s) missing FAQ schema.`);

  if (!apply) {
    console.log('\nDry run — no changes. Pass --apply to rebuild.');
    for (const p of legacy.slice(0, 20)) {
      console.log(`  - ${p.slug} (${p.meta.target_keyword || p.meta.title})`);
    }
    if (legacy.length > 20) console.log(`  ... and ${legacy.length - 20} more`);
    return;
  }

  // Filter by single slug or limit
  let toRebuild = legacy;
  if (slugArg) toRebuild = legacy.filter((p) => p.slug === slugArg);
  else if (limit) toRebuild = legacy.slice(0, limit);

  console.log(`\nRebuilding ${toRebuild.length} post(s)...`);

  let succeeded = 0;
  let failed = 0;
  for (const p of toRebuild) {
    try {
      const ok = await rebuildPost(p.slug);
      if (ok) succeeded++;
      else failed++;
    } catch (err) {
      console.error(`  ✗ ${p.slug}: ${err.message}`);
      failed++;
    }
  }

  await notify({
    subject: `Legacy Rebuilder: ${succeeded} rebuilt, ${failed} failed`,
    body: `Rebuilt ${succeeded} post(s), ${failed} failed. ${legacy.length - succeeded} legacy posts remain.`,
    status: failed > 0 ? 'warning' : 'success',
  });

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
}

main().catch((err) => {
  notify({ subject: 'Legacy Rebuilder failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
