#!/usr/bin/env node
/**
 * Re-gate posts against their LIVE Shopify body so the dashboard's
 * editorVerdict / brokenLinks reflect reality instead of a stale local report.
 *
 * The dashboard reads data/posts/<slug>/editor-report.md, which drifts from live
 * Shopify — a post fixed or refreshed on the live site keeps showing its OLD
 * failure until something re-runs the editor locally. This pulls the live body,
 * writes it to content.html (backing the old one up), and re-runs the editor to
 * regenerate the report + needs_rebuild flag. It does NOT remediate or push —
 * use scripts/remediate-live-post.js for that.
 *
 * Default: only re-gate posts the dashboard currently FLAGS (editor verdict
 * "Needs Work" or broken links > 0) — cheap, clears stale false alarms. Pass
 * --all to re-gate every post that has a Shopify article (also surfaces posts
 * that PASS locally but broke live).
 *
 * Usage:
 *   node scripts/regate-live-posts.js            # flagged posts only
 *   node scripts/regate-live-posts.js --all      # every Shopify post
 *   node scripts/regate-live-posts.js --limit 25
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBlogs, getArticle } from '../lib/shopify.js';
import {
  listAllSlugs, getPostMeta, getContentPath, getEditorReportPath, getBackupsDir, ensurePostDir,
} from '../lib/posts.js';
import { isPassing, firstBlockerReason } from '../lib/editor-remediation.js';

const argAll = process.argv.includes('--all');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

function brokenCount(report) {
  const m = report.match(/broken links:\s*(\d+)/i) || report.match(/(\d+)\s+broken\/unreachable/i);
  return m ? parseInt(m[1], 10) : 0;
}

function readReport(slug) {
  const p = getEditorReportPath(slug);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Is the post currently flagged on the dashboard (stale or not)? */
function isFlagged(slug) {
  const r = readReport(slug);
  if (!r) return false;
  return !isPassing(r) || brokenCount(r) > 0;
}

async function main() {
  const blogs = await getBlogs();
  const defaultBlogId = blogs[0].id;

  const candidates = listAllSlugs()
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter(({ meta }) => meta && meta.shopify_article_id)
    .filter(({ slug }) => argAll || isFlagged(slug))
    .slice(0, LIMIT);

  console.log(`Re-gating ${candidates.length} ${argAll ? 'Shopify' : 'flagged'} post(s) against live content...\n`);

  const cleared = [];   // was flagged → now passes (stale false alarm gone)
  const confirmed = []; // was flagged → still fails (real live issue)
  const regressed = []; // passed locally → now fails live (--all only)
  const errored = [];

  for (const { slug, meta } of candidates) {
    const before = readReport(slug);
    const wasFlagged = before ? (!isPassing(before) || brokenCount(before) > 0) : false;
    const blogId = meta.shopify_blog_id || defaultBlogId;
    try {
      const live = await getArticle(blogId, meta.shopify_article_id);
      const liveBody = live.body_html || '';
      if (!liveBody) { errored.push(`${slug} (empty live body)`); continue; }

      ensurePostDir(slug);
      const contentPath = getContentPath(slug);
      if (existsSync(contentPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        copyFileSync(contentPath, join(getBackupsDir(slug), `content-regate-${stamp}.html`));
      }
      writeFileSync(contentPath, liveBody);

      execSync(`node agents/editor/index.js ${contentPath}`, { cwd: process.cwd(), stdio: 'ignore' });

      const after = readReport(slug) || '';
      const nowPass = isPassing(after) && brokenCount(after) === 0;
      if (wasFlagged && nowPass) cleared.push(slug);
      else if (wasFlagged && !nowPass) confirmed.push({ slug, reason: firstBlockerReason(after).slice(0, 90) });
      else if (!wasFlagged && !nowPass) regressed.push({ slug, reason: firstBlockerReason(after).slice(0, 90) });
      process.stdout.write(nowPass ? '.' : 'x');
    } catch (e) {
      errored.push(`${slug} (${e.message.slice(0, 60)})`);
      process.stdout.write('!');
    }
  }

  console.log('\n\n── Re-gate summary ──');
  console.log(`✓ Cleared (stale false alarm, clean live): ${cleared.length}`);
  for (const s of cleared) console.log(`    ${s}`);
  console.log(`⚠ Confirmed real live issue: ${confirmed.length}`);
  for (const c of confirmed) console.log(`    ${c.slug} — ${c.reason}`);
  if (argAll) {
    console.log(`✗ Regressed (passed locally, fails live now): ${regressed.length}`);
    for (const c of regressed) console.log(`    ${c.slug} — ${c.reason}`);
  }
  if (errored.length) {
    console.log(`! Errored: ${errored.length}`);
    for (const e of errored) console.log(`    ${e}`);
  }
}

main().catch((err) => { console.error('regate-live-posts failed:', err); process.exit(1); });
