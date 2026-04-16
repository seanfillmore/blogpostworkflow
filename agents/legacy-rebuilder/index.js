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
  // Two signals: missing FAQ schema (old posts built before the pipeline), or
  // editor-tagged needs_rebuild (posts that failed the editor this week).
  return listAllSlugs()
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter((p) => p.meta && p.meta.shopify_article_id)
    .filter((p) => isLegacy(p.slug) || p.meta.needs_rebuild);
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

/**
 * Light refresh for rising-tier posts (ranking but needs polish).
 * Never rewrites body content — just runs the surgical fix agents:
 * answer-first intro, featured-product CTA, schema injector. Then pushes
 * the (auto-fixed) body_html to Shopify via the editor's --push-shopify
 * flag so live site reflects local changes.
 */
async function lightRefresh(slug) {
  const { getContentPath: getContent } = await import('../../lib/posts.js');
  console.log(`\nLight refresh: ${slug}`);
  console.log(`  Bucket: rising — surgical fixes only, body content untouched`);

  run(`node agents/answer-first-rewriter/index.js ${slug} --apply`, `answer-first: ${slug}`);
  run(`node agents/featured-product-injector/index.js --handle ${slug}`, `featured-product: ${slug}`);
  run(`node agents/schema-injector/index.js --slug ${slug} --apply`, `schema: ${slug}`);

  // Editor runs with --in-pipeline (no re-tagging) + --push-shopify (sync
  // any pre-review auto-fixes back to Shopify's body_html).
  if (!run(`node agents/editor/index.js ${getContent(slug)} --in-pipeline --push-shopify`, `editor+push: ${slug}`)) {
    console.error(`  ⛔ Editor failed — light refresh aborted`);
    return false;
  }

  // Clear the needs_rebuild tag on success
  const { needs_rebuild: _drop, ...rest } = getPostMeta(slug) || {};
  const updated = { ...rest, refreshed_at: new Date().toISOString() };
  writeFileSync(getMetaPath(slug), JSON.stringify(updated, null, 2));

  console.log(`  ✓ Light refresh complete`);
  return true;
}

async function rebuildPost(slug) {
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for ${slug}`);
  if (!meta.shopify_article_id || !meta.shopify_blog_id) {
    throw new Error(`Missing shopify_article_id or shopify_blog_id for ${slug}`);
  }

  // Tier-aware routing. legacy-triage stamps meta.legacy_bucket:
  //   winner  → never rebuild (preserve working post; clear any stale tag)
  //   rising  → light refresh only (schema + CTAs + answer-first), never
  //             rewrite body content
  //   flop    → full pipeline rebuild (current behavior)
  //   broken  → technical issue, manual fix required, skip
  //   (unset) → treat as flop to preserve current behavior for untriaged
  //             posts. run `node agents/legacy-triage/index.js` first to
  //             classify properly.
  const bucket = meta.legacy_bucket || null;
  if (bucket === 'winner') {
    console.log(`\nSkipping: ${slug}`);
    console.log(`  Bucket: winner — preserving post that is already ranking`);
    // Clear any stale needs_rebuild tag so the post doesn't keep surfacing
    if (meta.needs_rebuild) {
      const { needs_rebuild: _drop, ...rest } = meta;
      writeFileSync(getMetaPath(slug), JSON.stringify(rest, null, 2));
      console.log('  Cleared stale needs_rebuild tag');
    }
    return true;
  }
  if (bucket === 'broken') {
    console.log(`\nSkipping: ${slug}`);
    console.log(`  Bucket: broken — ${meta.legacy_triage_reason || 'technical fix required'}`);
    return true;
  }
  if (bucket === 'rising') {
    return await lightRefresh(slug);
  }

  // Full rebuild (flop or unset)
  const keyword = meta.target_keyword || meta.title;
  if (!keyword) throw new Error(`No target_keyword for ${slug}`);

  console.log(`\nRebuilding: ${slug}`);
  console.log(`  Bucket: ${bucket || 'untriaged (default: flop)'}`);
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

  if (!run(`node agents/editor/index.js ${getContentPath(slug)} --in-pipeline`, `editor: ${slug}`)) {
    console.error(`  ⛔ Editor failed — aborting rebuild, original post untouched on Shopify`);
    return false;
  }

  // Push to Shopify as an update (same article_id)
  const rebuiltHtml = readFileSync(getContentPath(slug), 'utf8');
  await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { body_html: rebuiltHtml });
  console.log(`  ✓ Published to Shopify (article_id: ${meta.shopify_article_id})`);

  // Stamp metadata, clear rebuild tag
  const { needs_rebuild: _drop, ...rest } = getPostMeta(slug) || {};
  const updatedMeta = { ...rest, rebuilt_at: new Date().toISOString() };
  writeFileSync(getMetaPath(slug), JSON.stringify(updatedMeta, null, 2));

  return true;
}

async function main() {
  console.log('\nLegacy Post Rebuilder\n');

  const legacy = findLegacyPosts();

  // Tier breakdown — shows what action each post would receive.
  const byBucket = { winner: [], rising: [], flop: [], broken: [], untriaged: [] };
  for (const p of legacy) {
    const b = p.meta.legacy_bucket || 'untriaged';
    if (byBucket[b]) byBucket[b].push(p);
    else byBucket.untriaged.push(p);
  }

  console.log(`Found ${legacy.length} legacy post(s). Tier breakdown:`);
  console.log(`  winner    (skip):          ${byBucket.winner.length}`);
  console.log(`  rising    (light refresh): ${byBucket.rising.length}`);
  console.log(`  flop      (full rebuild):  ${byBucket.flop.length}`);
  console.log(`  broken    (skip manual):   ${byBucket.broken.length}`);
  console.log(`  untriaged (default rebuild): ${byBucket.untriaged.length}`);
  if (byBucket.untriaged.length > 0) {
    console.log('  Tip: run `node agents/legacy-triage/index.js --force` to classify untriaged posts first.');
  }

  if (!apply) {
    console.log('\nDry run — no changes. Pass --apply to run tier-appropriate actions.');
    for (const p of legacy.slice(0, 20)) {
      const b = p.meta.legacy_bucket || 'untriaged';
      console.log(`  [${b}] ${p.slug}`);
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
