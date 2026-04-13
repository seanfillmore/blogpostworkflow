/**
 * Answer-First Rewriter Agent
 *
 * Audits the opening of every published blog post. Flags any post whose
 * first body paragraph (after CTAs, transparency notes, and editorial
 * bylines) does not directly answer the question implied by the title
 * within the first 60 words.
 *
 * Why: LLM search engines (ChatGPT Search, Perplexity, AI Overviews,
 * claude.ai) extract the first clear, factual answer they find on the
 * page. A meandering "You finally made the switch..." intro gets
 * skipped; "The best aluminum-free deodorant uses coconut oil and
 * baking soda to..." gets cited.
 *
 * Two-stage check:
 *   1. Heuristic — fast, free, no API call. Flags obviously bad intros
 *      (anecdotal openers, no keyword in first 60 words, second-person
 *      "you" stories, no factual claim).
 *   2. Claude evaluation + rewrite — only on flagged posts. Generates
 *      a 50-80 word answer-first replacement paragraph that preserves
 *      brand voice and any internal links from the original intro.
 *
 * Output: data/reports/answer-first/answer-first-report.md
 *         data/reports/answer-first/rewrites/<slug>.md   (per-post rewrites)
 *
 * Usage:
 *   node agents/answer-first-rewriter/index.js              # audit all posts
 *   node agents/answer-first-rewriter/index.js <slug>       # audit one post
 *   node agents/answer-first-rewriter/index.js --limit 10   # audit N posts
 *   node agents/answer-first-rewriter/index.js --no-rewrite # heuristic only, skip Claude
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getArticle, updateArticle } from '../../lib/shopify.js';
import { checkAnswerFirst, extractFirstBodyParagraph } from '../../lib/answer-first.js';
import { getContentPath, getPostMeta, listAllSlugs, POSTS_DIR } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'answer-first');
const REWRITES_DIR = join(REPORTS_DIR, 'rewrites');

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}
const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── product ingredients (shared with blog-post-writer) ────────────────────────

const ingredients = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

function flattenProduct(product) {
  if (!product) return null;
  const base = product.base_ingredients || product.ingredients || [];
  const variationOils = (product.variations || []).flatMap((v) => v.essential_oils || []);
  const all = [...new Set([...base, ...variationOils])];
  return { name: product.name, format: product.format, ingredients: all };
}

function detectProductIngredients(keyword) {
  const kw = (keyword || '').toLowerCase();
  if (kw.includes('deodorant')) return flattenProduct(ingredients.deodorant);
  if (kw.includes('toothpaste') || kw.includes('tooth paste') || kw.includes('oral')) return flattenProduct(ingredients.toothpaste);
  if (kw.includes('lotion') || kw.includes('moisturizer') || kw.includes('moisturiser')) return flattenProduct(ingredients.lotion);
  if (kw.includes('cream') || kw.includes('body butter')) return flattenProduct(ingredients.cream);
  if (kw.includes('soap') && kw.includes('bar')) return flattenProduct(ingredients.bar_soap);
  if (kw.includes('soap')) return flattenProduct(ingredients.liquid_soap);
  if (kw.includes('lip balm') || kw.includes('lip')) return flattenProduct(ingredients.lip_balm);
  return null;
}

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const noRewrite = args.includes('--no-rewrite');
const apply = args.includes('--apply');
const dryRun = args.includes('--dry-run');
// Slug = first non-flag arg, ignoring positions that are flag values
const flagValueIdxs = new Set();
if (limitIdx !== -1) flagValueIdxs.add(limitIdx + 1);
const slugArg = args.find((a, i) => !a.startsWith('--') && !flagValueIdxs.has(i));

// ── post loading ──────────────────────────────────────────────────────────────

function loadPosts() {
  const all = listAllSlugs()
    .map((slug) => {
      try {
        const meta = getPostMeta(slug);
        if (!meta) return null;
        const htmlPath = getContentPath(slug);
        if (!existsSync(htmlPath)) return null;
        const html = readFileSync(htmlPath, 'utf8');
        return { slug, meta, html };
      } catch { return null; }
    })
    .filter(Boolean);

  // Dedupe by shopify_article_id — when both a brief-slug copy and a
  // shopify-handle-slug copy exist for the same article, prefer the one
  // most recently synced from Shopify (legacy_synced_at present).
  const byArticleId = new Map();
  for (const p of all) {
    const aid = p.meta.shopify_article_id;
    if (!aid) {
      byArticleId.set(`__noid__${p.slug}`, p);
      continue;
    }
    const existing = byArticleId.get(aid);
    if (!existing) { byArticleId.set(aid, p); continue; }
    const pIsSynced = !!p.meta.legacy_synced_at;
    const eIsSynced = !!existing.meta.legacy_synced_at;
    if (pIsSynced && !eIsSynced) byArticleId.set(aid, p);
  }
  const deduped = [...byArticleId.values()];

  if (slugArg) return deduped.filter((p) => p.slug === slugArg);
  if (limit) return deduped.slice(0, limit);
  return deduped;
}

function firstNWords(text, n) {
  return text.split(/\s+/).slice(0, n).join(' ');
}
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Claude rewrite ────────────────────────────────────────────────────────────

async function generateRewrite(post, intro, reasons) {
  const product = detectProductIngredients(post.meta.target_keyword);
  const ingredientBlock = product
    ? `\n═══════════════════════════════════\nOUR PRODUCT INGREDIENTS — CRITICAL\n═══════════════════════════════════\nThis post is about ${product.name}${product.format ? ` (${product.format})` : ''}. The Real Skin Care product contains ONLY these ingredients:\n${product.ingredients.join(', ')}\n\nIngredient rules:\n- When the rewrite mentions specific ingredients, ONLY use ingredients from the list above. Do NOT name ingredients we don't actually use (no shea butter, no arrowroot, no magnesium hydroxide, no probiotics, etc. unless they appear above).\n- It is fine to refer generically to "plant oils" or "natural ingredients" if you don't want to name specific ones.\n- Do NOT present ingredients we don't use as desirable features or "what to look for".\n`
    : '';

  const prompt = `You are rewriting the opening paragraph of a blog post for Real Skin Care (realskincare.com), a natural skincare and personal care brand. The goal is to make the opening BOTH cite-worthy for AI search engines (ChatGPT, Perplexity, AI Overviews, claude.ai) AND warm and human enough that real readers want to keep reading.${ingredientBlock}

═══════════════════════════════════
BRAND VOICE — NON-NEGOTIABLE
═══════════════════════════════════
Helpful, warm, conversational. Write like a trusted friend explaining something over coffee — not a clinician writing a report. 8th grade reading level.

Voice rules:
- Use short sentences. Break long ones in two.
- Choose the plain word over the clinical one. "Bacteria that cause odor" not "odor-causing microflora". "Soothes skin" not "ameliorates dermal irritation". "Soaks in" not "penetrates the stratum corneum".
- Speak directly to the reader: "you", "your", "here's what to look for".
- Never use jargon without immediately explaining it in plain language. Better yet, just don't use it.
- Vary sentence length — mix short punchy sentences with slightly longer ones.
- It's fine to start a sentence with "And", "But", or "So".
- Do NOT use em-dashes (—) or en-dashes (–). Use a period, comma, or "and" instead. This is a hard rule.
- Avoid words like "stratum corneum", "transepidermal water loss", "humectants", "occlusives", "emollients", "active mechanism", "compound", "formulation". These sound like a chemistry textbook. Say what they DO instead.

═══════════════════════════════════
ANSWER-FIRST RULES
═══════════════════════════════════
1. The very first sentence must directly answer the question implied by the title — in plain language a friend would use. No anecdotes, no "You finally...", no rhetorical questions, no "If you've ever..." openers.
2. Include the target keyword naturally in the first sentence if it fits. Otherwise within the first 30 words. Don't force it.
3. Be specific where it matters — name the actual ingredients (coconut oil, baking soda, jojoba oil), say what they DO in plain words ("kills the bacteria that cause odor", not "exhibits antimicrobial properties").
4. 50-80 words total. No longer.
5. Do NOT mention competitor brand names.
6. Do NOT include a sales pitch or CTA in the intro — the intro sets up the guide, it does not sell.

═══════════════════════════════════
THIS POST
═══════════════════════════════════
TITLE: ${post.meta.title}
TARGET KEYWORD: ${post.meta.target_keyword}
META DESCRIPTION: ${post.meta.meta_description || '(none)'}

CURRENT FIRST PARAGRAPH (what you're replacing):
${intro.text}

WHY IT FAILS:
${reasons.map((r) => `- ${r}`).join('\n')}

═══════════════════════════════════
GOOD vs BAD EXAMPLE
═══════════════════════════════════
BAD (too clinical — what NOT to write):
"The best aluminum free deodorant uses botanicals like baking soda and magnesium hydroxide to neutralize odor-causing bacteria without blocking sweat glands. Unlike antiperspirants containing aluminum compounds, these formulas work with your body's natural processes."

GOOD (warm + answer-first — what TO write):
"The best aluminum-free deodorant kills the bacteria that cause odor without plugging up your sweat glands. The ones that actually work use a few simple ingredients — coconut oil, baking soda, and a clean base oil like jojoba — to keep you fresh all day. Here's how to pick one that won't let you down on day three."

Now write the rewrite for THIS post. Output ONLY the new paragraph wrapped in a single <p> tag. No explanation, no code fence, no preamble.`;

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') {
    throw new Error('Rewrite truncated at max_tokens');
  }
  const text = (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text;
}

// ── report ────────────────────────────────────────────────────────────────────

function buildReport(results) {
  const lines = [];
  const total = results.length;
  const failed = results.filter((r) => !r.check.passes).length;
  const noIntro = results.filter((r) => !r.intro).length;

  lines.push(`# Answer-First Audit — Real Skin Care`);
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Posts audited:** ${total}`);
  lines.push(`**Failing the answer-first check:** ${failed} (${Math.round((failed / total) * 100)}%)`);
  lines.push(`**No intro paragraph found:** ${noIntro}`);
  lines.push('');
  lines.push('## Why this matters');
  lines.push('');
  lines.push('LLM search engines (ChatGPT Search, Perplexity, AI Overviews, claude.ai) extract the first clear factual answer they find on a page. Posts that open with anecdotes, rhetorical questions, or "You finally made the switch..." style hooks tend to get skipped in favor of competitors who lead with the answer. Each rewrite below provides a 50-80 word answer-first opener you can paste in to replace the current first paragraph.');
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  lines.push('| Post | Target keyword | Reasons |');
  lines.push('|------|---------------|---------|');
  for (const r of results.filter((x) => !x.check.passes)) {
    lines.push(`| [${r.post.meta.title}](rewrites/${r.post.slug}.md) | ${r.post.meta.target_keyword} | ${r.check.reasons.join('; ')} |`);
  }
  lines.push('');
  lines.push('## Passing');
  lines.push('');
  lines.push('| Post | First 20 words |');
  lines.push('|------|----------------|');
  for (const r of results.filter((x) => x.check.passes)) {
    const preview = r.intro ? firstNWords(r.intro.text, 20) + '…' : '—';
    lines.push(`| ${r.post.meta.title} | ${preview} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildRewriteReport(r) {
  const lines = [];
  lines.push(`# ${r.post.meta.title}`);
  lines.push('');
  lines.push(`**Slug:** \`${r.post.slug}\``);
  lines.push(`**Target keyword:** ${r.post.meta.target_keyword}`);
  lines.push(`**Failure reasons:**`);
  for (const reason of r.check.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Current first paragraph');
  lines.push('');
  lines.push('```');
  lines.push(r.intro?.text || '(no intro found)');
  lines.push('```');
  lines.push('');
  if (r.rewrite) {
    lines.push('## Suggested rewrite');
    lines.push('');
    lines.push('```html');
    lines.push(r.rewrite);
    lines.push('```');
    lines.push('');
    lines.push(`**Word count:** ${wordCount(r.rewrite.replace(/<[^>]+>/g, ''))}`);
  }
  return lines.join('\n');
}

// ── apply: push rewrite into live Shopify article ────────────────────────────

const BACKUPS_DIR = join(ROOT, 'data', 'backups', 'posts');

/**
 * Replace the first <p> in body_html whose text matches `oldText` with
 * `newPHtml`. Returns null if no match found (so we never silently corrupt
 * the article).
 */
function replaceParagraph(bodyHtml, oldText, newPHtml) {
  const $ = cheerio.load(bodyHtml, { decodeEntities: false });
  const target = oldText.trim();
  let replaced = false;
  $('p').each((_, el) => {
    if (replaced) return;
    if ($(el).text().trim() === target) {
      $(el).replaceWith(newPHtml);
      replaced = true;
      return false;
    }
  });
  if (!replaced) return null;
  // cheerio.load wraps in <html><head><body>; extract body inner HTML
  return $('body').html();
}

async function applyRewriteToShopify(post, intro, rewriteHtml) {
  const { shopify_blog_id: blogId, shopify_article_id: articleId } = post.meta;
  if (!blogId || !articleId) {
    return { ok: false, reason: 'missing shopify_blog_id or shopify_article_id in local meta' };
  }
  // Fetch the LIVE article body — local HTML may be stale
  const live = await getArticle(blogId, articleId);
  const liveBody = live.body_html || '';
  if (!liveBody) return { ok: false, reason: 'live body_html is empty' };

  const newBody = replaceParagraph(liveBody, intro.text, rewriteHtml);
  if (!newBody) {
    return { ok: false, reason: 'could not find original first paragraph in live body_html (post may have been edited)' };
  }

  // Backup live body before write
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(BACKUPS_DIR, `${post.slug}.${stamp}.html`);
  writeFileSync(backupPath, liveBody);

  if (dryRun) {
    return { ok: true, dryRun: true, backupPath, before: intro.text, after: rewriteHtml };
  }

  await updateArticle(blogId, articleId, { body_html: newBody });
  return { ok: true, backupPath };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nAnswer-First Rewriter\n');
  const posts = loadPosts();
  if (posts.length === 0) {
    console.log('No posts found.');
    process.exit(0);
  }
  console.log(`  Auditing ${posts.length} post(s)\n`);

  const results = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    process.stdout.write(`  [${i + 1}/${posts.length}] ${post.slug.slice(0, 55).padEnd(56)} `);
    const result = checkAnswerFirst(post.html, { title: post.meta.title, keyword: post.meta.target_keyword });
    const intro = result.intro;
    const check = { passes: result.passes, reasons: result.reasons };
    let rewrite = null;
    if (!check.passes && !noRewrite) {
      try {
        rewrite = await generateRewrite(post, intro, check.reasons);
      } catch (e) {
        console.log(`✗ rewrite error: ${e.message}`);
        results.push({ post, intro, check, rewrite: null });
        continue;
      }
    }
    results.push({ post, intro, check, rewrite });
    console.log(check.passes ? '✓ pass' : `✗ ${check.reasons.length} issue(s)${rewrite ? ' + rewrite' : ''}`);
  }

  // Write reports
  mkdirSync(REWRITES_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'answer-first-report.md');
  writeFileSync(reportPath, buildReport(results));
  console.log(`\n  Report:   ${reportPath}`);

  for (const r of results.filter((x) => !x.check.passes)) {
    const p = join(REWRITES_DIR, `${r.post.slug}.md`);
    writeFileSync(p, buildRewriteReport(r));
  }
  console.log(`  Rewrites: ${REWRITES_DIR}\\<slug>.md`);

  const failed = results.filter((r) => !r.check.passes).length;
  console.log(`\n  ${failed}/${results.length} posts need an answer-first rewrite.`);

  // Apply mode: push rewrites to Shopify
  if (apply) {
    console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Applying ${failed} rewrite(s) to Shopify...\n`);
    const applyTargets = results.filter((r) => !r.check.passes && r.rewrite);
    let success = 0, skipped = 0;
    for (let i = 0; i < applyTargets.length; i++) {
      const r = applyTargets[i];
      process.stdout.write(`  [${i + 1}/${applyTargets.length}] ${r.post.slug.slice(0, 55).padEnd(56)} `);
      try {
        const res = await applyRewriteToShopify(r.post, r.intro, r.rewrite);
        if (!res.ok) {
          console.log(`✗ skipped: ${res.reason}`);
          skipped++;
          continue;
        }
        if (res.dryRun) console.log(`✓ dry-run ok (would write, backup: ${basename(res.backupPath)})`);
        else            console.log(`✓ applied (backup: ${basename(res.backupPath)})`);
        success++;
      } catch (e) {
        console.log(`✗ error: ${e.message}`);
        skipped++;
      }
    }
    console.log(`\n  ${dryRun ? 'Dry run complete' : 'Applied'}: ${success}  Skipped: ${skipped}`);
    if (!dryRun && success > 0) {
      console.log(`  Backups: ${BACKUPS_DIR}`);
    }
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  console.error(err.stack);
  process.exit(1);
});
