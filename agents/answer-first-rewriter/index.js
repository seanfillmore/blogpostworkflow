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
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
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
// Slug = first non-flag arg, ignoring positions that are flag values
const flagValueIdxs = new Set();
if (limitIdx !== -1) flagValueIdxs.add(limitIdx + 1);
const slugArg = args.find((a, i) => !a.startsWith('--') && !flagValueIdxs.has(i));

// ── post loading ──────────────────────────────────────────────────────────────

function loadPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  const all = readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('.backup-'))
    .map((f) => {
      const slug = basename(f, '.json');
      try {
        const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
        const htmlPath = join(POSTS_DIR, `${slug}.html`);
        if (!existsSync(htmlPath)) return null;
        const html = readFileSync(htmlPath, 'utf8');
        return { slug, meta, html };
      } catch { return null; }
    })
    .filter(Boolean);

  if (slugArg) return all.filter((p) => p.slug === slugArg);
  if (limit) return all.slice(0, limit);
  return all;
}

// ── intro extraction ──────────────────────────────────────────────────────────

/**
 * Pull the first "real" body paragraph — skipping promotional CTA sections,
 * transparency/disclosure notes, editorial bylines, and "Updated [date]" lines.
 * Returns { text, html } or null if no paragraph found before the first <h2>.
 */
function extractFirstBodyParagraph(html) {
  const $ = cheerio.load(html);
  // Drop CTA <section> blocks (Real Skin Care wraps them in styled <section>)
  $('section').remove();
  // Walk top-level <p> elements until we hit something that looks like real
  // body copy or run into an <h2> (which means there was no intro).
  const skip = (text) => {
    const t = text.trim();
    if (!t) return true;
    if (t.length < 40) return true;
    if (/^Updated [A-Z]/.test(t)) return true;
    if (/^Transparency note/i.test(t)) return true;
    if (/Editorial Team/i.test(t) && t.length < 250) return true;
    if (/^By the/i.test(t)) return true;
    return false;
  };

  let found = null;
  $('p').each((_, el) => {
    const text = $(el).text();
    if (skip(text)) return;
    found = { text: text.trim(), html: $.html(el) };
    return false;
  });
  return found;
}

function firstNWords(text, n) {
  return text.split(/\s+/).slice(0, n).join(' ');
}
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── heuristic ─────────────────────────────────────────────────────────────────

/**
 * Returns { passes: bool, reasons: [...] } where reasons describe failures.
 * Pass criteria (all must be true):
 *   - Keyword (or core noun phrase from title) appears in first 60 words
 *   - First sentence is not a second-person hook ("You X..." anecdote)
 *   - Contains a definitional or factual marker (is/are/works by/uses/contains)
 *   - Doesn't open with a rhetorical question
 */
function heuristicCheck(intro, title, keyword) {
  const reasons = [];
  if (!intro) {
    return { passes: false, reasons: ['No intro paragraph found before first <h2>'] };
  }
  const first60 = firstNWords(intro.text, 60).toLowerCase();
  const firstSentence = intro.text.split(/(?<=[.!?])\s+/)[0] || '';

  // Keyword presence
  const kw = (keyword || '').toLowerCase().trim();
  const titleCore = (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const kwTokens = kw.split(/\s+/).filter((t) => t.length > 3);
  const kwHit = kw && first60.includes(kw);
  // Loose match: ≥60% of keyword tokens in first 60 words
  const tokenHits = kwTokens.filter((t) => first60.includes(t)).length;
  const looseHit = kwTokens.length > 0 && tokenHits / kwTokens.length >= 0.6;
  if (!kwHit && !looseHit) reasons.push(`Target keyword "${keyword}" not in first 60 words`);

  // Anecdotal/second-person opener
  if (/^(you |your |imagine |picture |let'?s )/i.test(firstSentence)) {
    reasons.push('Opens with second-person/anecdotal hook (e.g. "You finally...")');
  }

  // Rhetorical question opener
  if (firstSentence.trim().endsWith('?')) {
    reasons.push('Opens with a rhetorical question instead of a direct answer');
  }

  // Factual marker
  const factualPattern = /\b(is|are|works by|uses|contains|means|refers to|happens when|occurs|defined as)\b/i;
  if (!factualPattern.test(intro.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '))) {
    reasons.push('First two sentences contain no definitional or factual statement');
  }

  return { passes: reasons.length === 0, reasons };
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
    const intro = extractFirstBodyParagraph(post.html);
    const check = heuristicCheck(intro, post.meta.title, post.meta.target_keyword);
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
}

main().catch((err) => {
  console.error('\nError:', err.message);
  console.error(err.stack);
  process.exit(1);
});
