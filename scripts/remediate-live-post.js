#!/usr/bin/env node
/**
 * Remediate a LIVE published post against the now-working editor gate.
 *
 * Local content.html intermediates drift from what's actually on Shopify, so we
 * pull the LIVE body, gate it, run the repair loop (link-repair + content-
 * remediator) until it passes, and push the result back — only if it ends up
 * passing AND actually changed. Backs up the local content.html first.
 *
 * Usage:
 *   node scripts/remediate-live-post.js <slug>          # remediate locally, do NOT push (review)
 *   node scripts/remediate-live-post.js <slug> --push   # remediate and publish to Shopify
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArticle, updateArticle } from '../lib/shopify.js';
import { getContentPath, getEditorReportPath, getBackupsDir, getPostMeta, ensurePostDir, ROOT } from '../lib/posts.js';
import { isPassing, parseEditorBlockers, contentBlockers, firstBlockerReason } from '../lib/editor-remediation.js';

const slug = process.argv[2];
const doPush = process.argv.includes('--push');
const MAX_ATTEMPTS = 3;
if (!slug) { console.error('Usage: node scripts/remediate-live-post.js <slug> [--push]'); process.exit(1); }

const quiet = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
// A single repair agent failing (e.g. content-remediator's integrity guard trips
// on one LLM sample) must NOT abort the whole Fix-blockers run — other agents in
// the same attempt may have already fixed the real blocker. Log and continue; the
// re-gate decides pass/fail.
const tryRepair = (cmd, label) => {
  try { quiet(cmd); return true; }
  catch (e) { console.log(`  ⚠ ${label} failed (exit ${e.status ?? '?'}) — continuing; re-gate will decide.`); return false; }
};

function gate() {
  quiet(`node agents/editor/index.js ${getContentPath(slug)}`);
  const r = readFileSync(getEditorReportPath(slug), 'utf8');
  return { pass: isPassing(r), reason: firstBlockerReason(r), blockers: contentBlockers(parseEditorBlockers(r)), raw: r };
}

const meta = getPostMeta(slug);
const { shopify_blog_id: blogId, shopify_article_id: articleId } = meta || {};
if (!blogId || !articleId) { console.error(`  ${slug}: no Shopify article IDs — skipping.`); process.exit(1); }

console.log(`\n=== ${slug} ===`);
const live = await getArticle(blogId, articleId);
const liveBody = live.body_html || '';
const contentPath = getContentPath(slug);

ensurePostDir(slug);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(contentPath, join(getBackupsDir(slug), `content-prelive-${stamp}.html`));
writeFileSync(contentPath, liveBody);
console.log(`  Pulled LIVE body (${liveBody.length} chars); local backed up.`);

let g = gate();
console.log(`  Live verdict: ${g.pass ? 'PASS' : 'FAIL — ' + g.reason.slice(0, 80)}`);

let attempts = 0;
while (!g.pass && attempts < MAX_ATTEMPTS) {
  attempts++;
  const sectionText = (g.blockers.map((b) => b.section).join(' ') + ' ' + (g.reason || '')).toLowerCase();
  let acted = false;
  if (/broken link|404|link health/.test(sectionText)) {
    console.log(`  attempt ${attempts}: link-repair`);
    if (tryRepair(`node agents/link-repair/index.js ${slug}`, 'link-repair')) acted = true;
  }
  // Uncited claims (YMYL): add verified citations first, then soften residuals.
  if (/factual|citation|uncited|unsourced|credibility|claim/.test(sectionText)) {
    console.log(`  attempt ${attempts}: citation-finder`);
    if (tryRepair(`node agents/citation-finder/index.js --slug ${slug}`, 'citation-finder')) acted = true;
  }
  // Prose-substance blockers (content-remediator skips factual/citation/overall itself).
  if (g.blockers.some((b) => !/factual|citation|uncited|unsourced|credibility|overall quality/i.test(b.section))) {
    console.log(`  attempt ${attempts}: content-remediator (${g.blockers.map((b) => b.section).join(', ')})`);
    if (tryRepair(`node agents/content-remediator/index.js --slug ${slug}`, 'content-remediator')) acted = true;
  }
  if (!acted) {
    console.log(`  attempt ${attempts}: no actionable blocker parsed — stopping.`);
    break;
  }
  g = gate();
}

const remediated = readFileSync(contentPath, 'utf8');
const changed = remediated !== liveBody;
console.log(`  After ${attempts} attempt(s): ${g.pass ? 'PASS' : 'STILL FAILING'}; changed vs live: ${changed} (${liveBody.length}→${remediated.length} chars)`);

if (g.pass && changed && doPush) {
  await updateArticle(blogId, articleId, { body_html: remediated });
  console.log(`  ✓ PUSHED remediated content to Shopify (live).`);
} else if (g.pass && changed) {
  console.log(`  (dry) would push — re-run with --push to publish.`);
} else if (g.pass && !changed) {
  console.log(`  Live already passes — nothing to change.`);
} else {
  console.log(`  ⛔ Still failing — leaving live unchanged; needs manual review.`);
}

// Exit non-zero when the post is still blocked so callers (the dashboard's
// "Fix blockers" SSE, CI) can tell pass from fail. A passing post — whether we
// pushed, would-push, or it already passed — is exit 0.
process.exitCode = g.pass ? 0 : 1;
