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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getPostMeta, getMetaPath, getContentPath, getEditorReportPath, ROOT } from '../../lib/posts.js';
import { updateArticle } from '../../lib/shopify.js';
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

/**
 * Returns true if the editor report for this slug has an OVERALL QUALITY
 * verdict that is NOT "Needs Work" — i.e. the post passed the editorial
 * gate. Mirrors the dashboard's findBlockedPosts logic.
 */
function editorPassed(slug) {
  const reportPath = getEditorReportPath(slug);
  if (!existsSync(reportPath)) return false;
  const report = readFileSync(reportPath, 'utf8');
  const overallMatch = report.match(/##[^\n]*OVERALL QUALITY[^\n]*\n[\s\S]*?VERDICT[:*\s]+([^\n]+)/i);
  if (!overallMatch) return false;
  return !/needs work/i.test(overallMatch[1]);
}

async function publishDraft(slug, meta) {
  await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { published: true });
  const updated = { ...meta, shopify_status: 'published', published_at: new Date().toISOString() };
  delete updated.shopify_publish_at;
  writeFileSync(getMetaPath(slug), JSON.stringify(updated, null, 2));
  console.log(`    ✓ Published to Shopify`);
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
    return { refreshed: true, published: false };
  }

  // Auto-publish if the editor's OVERALL QUALITY verdict passed. If it
  // returned Needs Work, leave as draft — the daily legacy-rebuilder will
  // pick it up and route to tier-appropriate action. No half-finished flows.
  if (!editorPassed(slug)) {
    console.log(`    Editor did not pass — left as draft for next rebuilder cycle`);
    return { refreshed: true, published: false };
  }
  try {
    const meta = getPostMeta(slug);
    await publishDraft(slug, meta);
    return { refreshed: true, published: true };
  } catch (e) {
    console.error(`    ✗ Publish failed: ${e.message}`);
    return { refreshed: true, published: false };
  }
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

  let refreshed = 0;
  let published = 0;
  let failed = 0;
  for (const d of toRefresh) {
    try {
      const result = await refreshDraft(d.slug);
      if (result.refreshed) refreshed++;
      if (result.published) published++;
      if (!result.refreshed) failed++;
    } catch (err) {
      console.error(`  ✗ ${d.slug}: ${err.message}`);
      failed++;
    }
  }

  await notify({
    subject: `Draft Refresher: ${published} published, ${refreshed - published} kept as draft, ${failed} failed`,
    body: `Refreshed ${refreshed} draft(s); ${published} passed the editor and were auto-published, ${refreshed - published} kept as draft, ${failed} failed.`,
    status: failed > 0 ? 'warning' : 'success',
  });

  console.log(`\nDone. ${refreshed} refreshed, ${published} auto-published, ${failed} failed.`);
}

main().catch((err) => {
  notify({ subject: 'Draft Refresher failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
