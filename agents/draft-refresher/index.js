/**
 * Draft Refresher
 *
 * Runs the "rising tier" light-refresh flow over Shopify drafts: posts
 * with a shopify_article_id but no published/scheduled state. Each post
 * goes through answer-first intro rewrite, featured-product CTA injection,
 * schema injector, and editor pre-review auto-fixes, then body_html is
 * pushed to Shopify via the editor's --push-shopify flag.
 *
 * Does NOT publish — drafts stay drafts on Shopify. Operator still has
 * final say on publication.
 *
 * Usage:
 *   node agents/draft-refresher/index.js                     # dry-run, list drafts
 *   node agents/draft-refresher/index.js --apply             # refresh all drafts
 *   node agents/draft-refresher/index.js --apply --limit 3   # refresh first N
 *   node agents/draft-refresher/index.js --apply <slug>      # refresh one post
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getPostMeta, getContentPath, ROOT } from '../../lib/posts.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const slugArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');

function isDraft(meta) {
  if (!meta?.shopify_article_id) return false;
  if (meta.shopify_status === 'published') return false;
  const ts = meta.shopify_publish_at ? Date.parse(meta.shopify_publish_at) : NaN;
  if (!Number.isNaN(ts)) return false; // scheduled or past-published
  return true;
}

function findDrafts() {
  return listAllSlugs()
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter((p) => p.meta && isDraft(p.meta) && existsSync(getContentPath(p.slug)));
}

function run(cmd, label) {
  console.log(`    > ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    console.error(`    ✗ ${label} failed`);
    return false;
  }
}

async function refreshDraft(slug) {
  console.log(`\n  Refreshing: ${slug}`);
  const contentPath = getContentPath(slug);

  // Light-refresh sequence — same pattern as rising-tier legacy-rebuilder
  run(`node agents/answer-first-rewriter/index.js ${slug} --apply`, `answer-first: ${slug}`);
  run(`node agents/featured-product-injector/index.js --handle ${slug}`, `featured-product: ${slug}`);
  run(`node agents/schema-injector/index.js --slug ${slug} --apply`, `schema: ${slug}`);

  // Editor with --in-pipeline (no re-tagging) + --push-shopify syncs any
  // pre-review auto-fixes (year refresh, H1 demotion, FAQ competitor
  // rewrite, link-text bumps) back to Shopify body_html.
  if (!run(`node agents/editor/index.js ${contentPath} --in-pipeline --push-shopify`, `editor+push: ${slug}`)) {
    console.error(`    ⛔ Editor failed — draft left as-is on Shopify`);
    return false;
  }
  return true;
}

async function main() {
  console.log(`\nDraft Refresher${apply ? ' (APPLY)' : ' (dry run)'}\n`);

  const drafts = findDrafts();
  console.log(`Found ${drafts.length} draft post(s) with content.html and a Shopify article ID.`);

  if (!apply) {
    for (const d of drafts.slice(0, 30)) {
      console.log(`  - ${d.slug} (${d.meta.title || '—'})`);
    }
    if (drafts.length > 30) console.log(`  ... and ${drafts.length - 30} more`);
    console.log('\nDry run — no changes. Pass --apply to refresh.');
    return;
  }

  let toRefresh = drafts;
  if (slugArg) toRefresh = drafts.filter((d) => d.slug === slugArg);
  else if (limit) toRefresh = drafts.slice(0, limit);

  console.log(`\nRefreshing ${toRefresh.length} draft(s)...`);

  let succeeded = 0;
  let failed = 0;
  for (const d of toRefresh) {
    try {
      if (await refreshDraft(d.slug)) succeeded++;
      else failed++;
    } catch (err) {
      console.error(`  ✗ ${d.slug}: ${err.message}`);
      failed++;
    }
  }

  await notify({
    subject: `Draft Refresher: ${succeeded} refreshed, ${failed} failed`,
    body: `Refreshed ${succeeded} draft(s); ${failed} failed. ${drafts.length - succeeded} drafts remain.`,
    status: failed > 0 ? 'warning' : 'success',
  });

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
}

main().catch((err) => {
  notify({ subject: 'Draft Refresher failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
