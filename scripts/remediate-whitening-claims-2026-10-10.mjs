#!/usr/bin/env node
/**
 * Remove whitening and stain-removal claims about OUR toothpaste from live blog posts.
 *
 * Operator ruling, 2026-10-10: "We have no basis to make any whitening claims."
 * Dry by default. `--apply` writes. RUN ON THE PRODUCTION SERVER (mirrors are server-only;
 * see remediate-toothpaste-safety-claims.mjs).
 *
 * Found by scanning every live surface (Shopify products, collections, pages, SEO
 * metafields, article bodies and excerpts, Amazon listings) for whiten/stain/bleach
 * wording where our product is the subject. KEPT: explanations of how whitening works as
 * a category, competitor descriptions ("David's – Whitening and fluoride-free"), and the
 * sweat-stain post (armpit stains, not teeth). The Amazon bullet carrying "lifts surface
 * stains" is fixed by scripts/amazon/remove-toothpaste-stain-claim-2026-10-10.mjs.
 *
 * Body edits use the shared `runPlan`. The one EXCERPT (`summary_html`, which the theme
 * renders on the article and the blog listing) is edited here with the same discipline:
 * literal BEFORE, skip on a third value, backup before the write, re-read and verify.
 *
 * Usage (on the server):
 *   node scripts/remediate-whitening-claims-2026-10-10.mjs
 *   node scripts/remediate-whitening-claims-2026-10-10.mjs --apply
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { runPlan } from './remediate-toothpaste-safety-claims.mjs';
import { checkSeoCopyFields, EDITORIAL_SURFACE } from '../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_ID = 48998449187;
const TD = '<td style="padding:8px;border-bottom:1px solid #eee;">';

export const ARTICLES = {
  'charcoal-toothpaste-does-it-work-is-it-safe': { blogId: BLOG_ID, articleId: 563424755882 },
  'toothpaste-without-sls-what-to-know-best-options': { blogId: BLOG_ID, articleId: 563313508522 },
  'fluoride-free-toothpaste-benefits-how-it-works-best-picks': { blogId: BLOG_ID, articleId: 563282182314 },
};

const e = (id, handle, before, after, reason) => ({ id, handle, surface: 'body', expectedOccurrences: 1, before, after, reason });

export const PLAN = [
  e('charcoal-table-whitening-evidence', 'charcoal-toothpaste-does-it-work-is-it-safe',
    `${TD}Surface stain removal supported by baking soda research</td>`,
    `${TD}None claimed: a cleaning toothpaste, not a whitening product</td>`,
    'Comparison table, Real Skin Care column, "Whitening evidence" row: credited our formula with stain removal.'),
  e('charcoal-table-antimicrobial', 'charcoal-toothpaste-does-it-work-is-it-safe',
    `${TD}Gentle abrasion + antimicrobial botanicals</td>`,
    `${TD}Gentle abrasion from baking soda</td>`,
    'Same column: "antimicrobial botanicals" is a drug property (see the 2026-10-10 oral-care sweep).'),
  e('charcoal-table-active-ingredients', 'charcoal-toothpaste-does-it-work-is-it-safe',
    `${TD}Additional active ingredients</td>`,
    `${TD}Other ingredients</td>`,
    'Row label called our botanicals "active ingredients", which is drug terminology.'),
  e('sls-whitening-abrasive', 'toothpaste-without-sls-what-to-know-best-options',
    "Baking soda itself is a gentle but effective whitening abrasive, which is one reason it's a core ingredient in our formula.",
    "Baking soda itself is a gentle abrasive, which is one reason it's a core ingredient in our formula.",
    'Tied whitening to our formula. Compliance edit on a frozen locked winner: allowed by lib/post-edit-gate.js.'),
  e('ff-benefits-whitening-routine', 'fluoride-free-toothpaste-benefits-how-it-works-best-picks',
    'If you love a warming flavor profile with your whitening routine, our ',
    'If you love a warming flavor profile, our ',
    'Recommended our cinnamon toothpaste for a "whitening routine".'),
];

/** The excerpt: a list post whose "picks" include ours, promising they "truly whiten". */
export const SUMMARY = {
  handle: 'best-fluoride-free-toothpaste-2025',
  blogId: BLOG_ID,
  articleId: 562334367914,
  before: "Searching for the best fluoride free toothpaste? We break down clean picks that truly whiten, freshen, and protect—without the ingredients you're avoiding.",
  after: "Searching for the best fluoride free toothpaste? We break down clean picks that freshen breath and clean gently, without the ingredients you're avoiding.",
};

export function decideSummary(live) {
  if (live === SUMMARY.after) return { action: 'already-applied' };
  if (live === SUMMARY.before) return { action: 'apply' };
  return { action: 'skip', why: 'excerpt matches neither BEFORE nor AFTER' };
}

export async function main({ shopify, argv = process.argv.slice(2), root = ROOT, log = console.log } = {}) {
  const gate = checkSeoCopyFields({ summary: SUMMARY.after }, { surface: EDITORIAL_SURFACE });
  if (!gate.ok) throw new Error(`ABORT — excerpt AFTER fails the gate: ${JSON.stringify(gate.blocking)}`);
  const api = shopify ?? await import('../lib/shopify.js');
  const record = await runPlan({ plan: PLAN, articles: ARTICLES, reportDir: 'whitening-claims-2026-10-10', backupTag: 'whitening-claims', shopify: api, argv, root, log });

  const apply = argv.includes('--apply');
  const live = (await api.getArticle(SUMMARY.blogId, SUMMARY.articleId))?.summary_html;
  const d = decideSummary(live);
  log(`\n== ${SUMMARY.handle} excerpt — ${d.action.toUpperCase()}${d.why ? `: ${d.why}` : ''}`);
  if (d.action === 'apply' && apply) {
    const dir = join(root, 'data', 'reports', 'whitening-claims-2026-10-10', 'backups');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SUMMARY.handle}.summary_html.${Date.now()}.html`), live);
    await api.updateArticle(SUMMARY.blogId, SUMMARY.articleId, { summary_html: SUMMARY.after });
    const reread = (await api.getArticle(SUMMARY.blogId, SUMMARY.articleId))?.summary_html;
    if (reread !== SUMMARY.after) throw new Error(`VERIFY FAILED — ${SUMMARY.handle} excerpt. Backup in ${dir}`);
    log('  ✓ excerpt written and verified');
  }
  return { record, summary: d };
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
