#!/usr/bin/env node
/**
 * Publish-Drift Detector
 *
 * Closes the monitoring gap behind the 2026-06-13 incident: live posts silently
 * reverting to Shopify drafts (broken internal links + lost traffic), undetected
 * because change-diff-detector only diffs content, never publish status.
 *
 * Watches two sources of "should be published" — local records
 * (meta.shopify_status==='published' with a shopify_article_id) AND a persistent
 * ever-published ledger of every article ever seen live on Shopify — and compares
 * them against current live status. Anything we think is live but is a draft (or
 * gone) on Shopify is drift. The ledger closes the 2026-06-21 blind spot where 5
 * drifted posts had no local meta.json and so were never checked. Posts that are
 * the source of a Shopify redirect (deliberately retired) are excluded.
 *
 * Default: detect + alert (immediate error notification). --fix republishes the
 * drafts (the safe, root-cause fix — they were published before) and re-verifies.
 * 'missing' (deleted) drifts are reported only, never auto-recreated.
 *
 * Outputs:
 *   data/reports/publish-drift/latest.json   (digest / freshness monitor)
 *   data/reports/publish-drift/YYYY-MM-DD.md
 *
 * Usage:
 *   node agents/publish-drift/index.js            # detect + alert
 *   node agents/publish-drift/index.js --fix      # also republish drifted drafts
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { getBlogs, getArticles, updateArticle, getRedirects } from '../../lib/shopify.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import { findPublishDrift, reconcileEverPublishedLedger } from '../../lib/publish-drift.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'publish-drift');
// Persistent record of every article ever seen live-published on Shopify. This
// is what closes the gap behind the 2026-06-21 sweep: 5 live posts had reverted
// to draft but were invisible to the detector because they had no local meta.json
// (the detector only watched locally-tracked posts). Any article in this ledger
// that is now a draft — and not deliberately retired — is drift.
const LEDGER_PATH = join(REPORTS_DIR, 'ever-published.json');
const FIX = process.argv.includes('--fix');

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return {};
  try { return JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); } catch { return {}; }
}

// Posts deliberately unpublished by the cannibalization-resolver (REDIRECT/
// CONSOLIDATE/MERGE) or kill-article. These are NOT drift — excluding them keeps
// the detector from fighting an intentional consolidation. Returns a Set of
// handles/slugs.
async function loadIntentionalUnpublishes() {
  const set = new Set();
  const RETIRING = new Set(['REDIRECT', 'CONSOLIDATE', 'MERGE', 'KILL', 'DELETE']);
  const handleOf = (url) => { const m = String(url).match(/\/blogs\/[^/]+\/([^/?#]+)/); return m ? m[1] : null; };

  // A blog URL that is the SOURCE of a Shopify redirect has been deliberately
  // retired — never treat it as drift / never auto-republish it. This is the
  // safety guard that lets the ledger watch every ever-published article without
  // un-retiring posts that cannibalization/manual cleanup redirected away.
  try {
    for (const r of (await getRedirects()) || []) {
      const h = handleOf(r.path);
      if (h) set.add(h);
    }
  } catch { /* redirects unavailable — fall back to report/kill signals below */ }

  const cannPath = join(ROOT, 'data', 'reports', 'cannibalization', 'latest.json');
  if (existsSync(cannPath)) {
    try {
      const cann = JSON.parse(readFileSync(cannPath, 'utf8'));
      for (const c of (cann.conflicts || [])) {
        if (!c.resolved_action || !RETIRING.has(c.resolved_action)) continue;
        for (const u of (c.urls || [])) { const h = handleOf(u.url); if (h) set.add(h); }
      }
    } catch { /* ignore */ }
  }

  const killDir = join(ROOT, 'data', 'reports', 'kill-article');
  if (existsSync(killDir)) {
    for (const f of readdirSync(killDir)) {
      try {
        const txt = readFileSync(join(killDir, f), 'utf8');
        for (const m of txt.matchAll(/\/blogs\/[^/]+\/([a-z0-9-]+)/g)) set.add(m[1]);
        if (f.endsWith('.json')) { const j = JSON.parse(txt); for (const s of (j.killed || j.slugs || [])) set.add(typeof s === 'string' ? s : s.slug); }
      } catch { /* ignore */ }
    }
  }
  return set;
}

async function main() {
  console.log('\nPublish-Drift Detector\n');

  // Records: posts we believe are published. Two sources, unioned by article id:
  //   (1) local meta.json (shopify_status === 'published')
  //   (2) the ever-published ledger (any article seen live on a prior run)
  const recordsById = new Map();
  for (const slug of listAllSlugs()) {
    const meta = getPostMeta(slug);
    if (!meta) continue;
    if (meta.shopify_status === 'published' && meta.shopify_article_id) {
      recordsById.set(String(meta.shopify_article_id), { slug, articleId: meta.shopify_article_id, handle: meta.shopify_handle || slug });
    }
  }
  console.log(`  Posts marked published in local records: ${recordsById.size}`);

  // Live Shopify article status, keyed by String(id).
  const live = new Map();
  for (const blog of await getBlogs()) {
    for (const a of await getArticles(blog.id, 250)) {
      live.set(String(a.id), { published: !!a.published_at, handle: a.handle, blogId: blog.id, id: a.id });
    }
  }
  console.log(`  Live Shopify articles: ${live.size}`);

  // Ever-published ledger: record every article currently live-published, then
  // fold the ledger into records so drift is detected even for posts we never
  // tracked locally. Prune entries no longer present on Shopify (deleted) so the
  // ledger stays an accurate watch-list and old deletes don't re-alert forever.
  const now = new Date().toISOString();
  const { ledger, records: ledgerRecords } = reconcileEverPublishedLedger(loadLedger(), live, now, new Set(recordsById.keys()));
  for (const r of ledgerRecords) if (!recordsById.has(String(r.articleId))) recordsById.set(String(r.articleId), r);
  console.log(`  Ever-published ledger: ${Object.keys(ledger).length} (${ledgerRecords.length} watched only via ledger, no local record)`);

  const records = [...recordsById.values()];
  const intentional = await loadIntentionalUnpublishes();
  console.log(`  Intentionally retired (redirect/cannibalization/kill, excluded): ${intentional.size}`);
  const drift = findPublishDrift(records, live, { intentional });
  const drafts = drift.filter((d) => d.reason === 'draft');
  const missing = drift.filter((d) => d.reason === 'missing');
  console.log(`  Drift: ${drift.length} (${drafts.length} reverted to draft, ${missing.length} missing/deleted)`);

  let fixed = [];
  if (FIX && drafts.length) {
    console.log('\n  --fix: republishing drifted drafts...');
    for (const d of drafts) {
      const a = live.get(String(d.articleId));
      try {
        await updateArticle(a.blogId, a.id, { published: true });
        fixed.push(d.slug);
        console.log(`    republished: ${d.slug}`);
      } catch (err) {
        console.error(`    FAILED ${d.slug}: ${err.message}`);
      }
    }
  }

  // ── outputs ──
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  const generated_at = now;
  const dateStr = generated_at.slice(0, 10);
  const payload = { generated_at, checked: records.length, ledger_size: Object.keys(ledger).length, intentional_excluded: intentional.size, drift, drafts, missing, fixed };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), buildReport(payload));
  console.log(`\n  Report saved: data/reports/publish-drift/${dateStr}.md`);

  // Alert only when there's drift the user still needs to act on (errors bypass
  // the digest deferral → emailed immediately).
  const remaining = drift.filter((d) => !fixed.includes(d.slug));
  if (remaining.length) {
    await notify({
      subject: `⚠️ Publish drift: ${remaining.length} post(s) live in records but not on Shopify`,
      body: remaining.map((d) => `- ${d.slug} (${d.reason})${d.reason === 'draft' ? ' — re-run with --fix to republish' : ' — deleted on Shopify, investigate'}`).join('\n')
        + (fixed.length ? `\n\nAuto-republished this run: ${fixed.join(', ')}` : ''),
      status: 'error',
      category: 'ops',
    }).catch(() => {});
  } else if (fixed.length) {
    await notify({
      subject: `Publish drift: republished ${fixed.length} reverted post(s)`,
      body: `Restored to live: ${fixed.join(', ')}`,
      status: 'info',
      category: 'ops',
    }).catch(() => {});
  }

  console.log('\nPublish-drift check complete.');
}

function buildReport(p) {
  const L = [];
  L.push('# Publish-Drift Report');
  L.push('');
  L.push(`**Checked:** ${p.checked} posts watched (local records + ever-published ledger of ${p.ledger_size ?? '?'})`);
  L.push(`**Drift found:** ${p.drift.length} (${p.drafts.length} reverted to draft, ${p.missing.length} missing/deleted)`);
  if (p.fixed.length) L.push(`**Auto-republished (--fix):** ${p.fixed.join(', ')}`);
  L.push('');
  if (!p.drift.length) { L.push('✅ No drift — every post we consider published is live on Shopify.'); return L.join('\n'); }
  if (p.drafts.length) {
    L.push('## Reverted to draft (republish to fix)');
    for (const d of p.drafts) L.push(`- \`${d.slug}\` (article ${d.articleId})${p.fixed.includes(d.slug) ? ' — ✅ republished' : ''}`);
    L.push('');
  }
  if (p.missing.length) {
    L.push('## Missing on Shopify (deleted — investigate)');
    for (const d of p.missing) L.push(`- \`${d.slug}\` (article ${d.articleId})`);
    L.push('');
  }
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Publish-drift detector failed:', err); process.exit(1); });
}
