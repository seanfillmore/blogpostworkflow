/**
 * FAQ Rewriter
 *
 * Scans a post's FAQ Q&As for competitor brand names and rewrites only
 * the offending Q&As — keeping the useful framing intact while removing
 * competitor name-drops per brand guidelines. Non-offending Q&As are
 * untouched.
 *
 * Called by the editor as a pre-review auto-fix when competitor names
 * are detected in the FAQ, so the editorial review never sees the
 * violation and doesn't block the post.
 *
 * Usage:
 *   node agents/faq-rewriter/index.js <slug>
 *   node agents/faq-rewriter/index.js <slug> --push-shopify
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPostMeta, getMetaPath, getContentPath, ROOT } from '../../lib/posts.js';
import { updateArticle } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const citationConfig = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));
const COMPETITORS = citationConfig.competitors || [];

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

function competitorAliases() {
  const aliases = [];
  for (const c of COMPETITORS) {
    if (c.name) aliases.push(c.name);
    for (const a of (c.aliases || [])) aliases.push(a);
  }
  return [...new Set(aliases)].filter(Boolean);
}

function findCompetitorsInText(text, aliases) {
  const lower = text.toLowerCase();
  const found = [];
  for (const a of aliases) {
    const safe = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${safe}\\b`, 'i');
    if (re.test(lower)) found.push(a);
  }
  return [...new Set(found)];
}

/**
 * Extract FAQ Q&A blocks from the HTML. Returns an array of
 * { raw, q, a, start, end } where start/end are absolute offsets in the
 * source string — so callers can do targeted replacements without
 * re-rendering the whole document.
 *
 * Handles two common patterns seen in our posts:
 *   1. <p><strong>Question?</strong><br>Answer</p>  (inline FAQ style)
 *   2. <h2|h3>Question?</h2|h3><p>Answer</p>        (schema-injector style)
 */
function extractFaqBlocks(html) {
  const blocks = [];
  const patterns = [
    /<p[^>]*>\s*<strong[^>]*>\s*([^<]*\?[^<]*?)\s*<\/strong>\s*(?:<br\s*\/?>\s*)?([\s\S]*?)<\/p>/gi,
    /<(h[23])[^>]*>\s*([^<]*\?[^<]*?)\s*<\/\1>\s*<p[^>]*>([\s\S]*?)<\/p>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      // Regex with two capture groups (Q, A) for the strong pattern, or three
      // (heading-tag, Q, A) for the heading pattern. Grab Q/A from the end.
      const a = m[m.length - 1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const q = m[m.length - 2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      blocks.push({ raw: m[0], q, a, start: m.index, end: m.index + m[0].length });
    }
  }
  // Sort by start offset to make diff reasoning easier
  return blocks.sort((x, y) => x.start - y.start);
}

async function rewriteQa(q, a, brandsToRemove, postKeyword) {
  const prompt = `You are rewriting one FAQ (question + answer) for ${config.name}'s blog to remove competitor brand name-drops. The post topic is: "${postKeyword}".

Rules:
- Remove all mentions of these competitor brand names from BOTH the question and answer: ${brandsToRemove.join(', ')}
- Do NOT replace the competitor with another competitor brand name.
- Reframe competitor-specific framing to general-category framing. E.g. "How does our soap compare to Dr. Squatch?" → "How does natural bar soap compare to heavily marketed men's soap brands?"
- Keep the spirit and usefulness. If the answer compared a competitor to our product, rewrite as general-category comparison.
- It is OK to mention ${config.name} by name if the original did.
- Keep it 2–4 short sentences. Match the original tone (conversational, 8th-grade reading level, short sentences, no em-dashes).
- Output in this EXACT format, nothing else:

QUESTION: <new question, ending with a question mark>
ANSWER: <new answer, 2-4 short sentences>

ORIGINAL QUESTION: ${q}

ORIGINAL ANSWER:
${a}`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('FAQ rewrite truncated at max_tokens');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const qMatch = text.match(/QUESTION:\s*([\s\S]*?)(?=\n\s*ANSWER:|$)/i);
  const aMatch = text.match(/ANSWER:\s*([\s\S]*)$/i);
  if (!qMatch || !aMatch) throw new Error('Rewrite output did not match expected QUESTION:/ANSWER: format');
  return { q: qMatch[1].trim(), a: aMatch[1].trim() };
}

/**
 * Core function — exported for editor pre-review auto-fix. Given HTML,
 * returns the updated HTML (or the input unchanged if no violations) plus
 * a list of changes made. Does NOT write to disk.
 */
export async function fixCompetitorsInFaqs(html, postKeyword = '') {
  const aliases = competitorAliases();
  const blocks = extractFaqBlocks(html);
  const changes = [];
  let updated = html;
  const offsetShift = []; // (start, delta) so later replacements account for earlier length changes

  for (const b of blocks) {
    const text = `${b.q}\n${b.a}`;
    const found = findCompetitorsInText(text, aliases);
    if (found.length === 0) continue;

    try {
      const { q: newQ, a: newA } = await rewriteQa(b.q, b.a, found, postKeyword);
      // Verify the rewrite actually removed the competitor names (otherwise skip)
      const stillHas = findCompetitorsInText(`${newQ}\n${newA}`, aliases);
      if (stillHas.length > 0) {
        changes.push({ q: b.q, status: 'skipped', reason: `LLM still left competitor names: ${stillHas.join(', ')}` });
        continue;
      }

      // Build the replacement block with new Q and A swapped into the
      // matched raw HTML. Keeps the wrapping tags (<p><strong>, <h2>, etc)
      // intact so formatting is preserved.
      const escapedQ = b.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedA = b.a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let rewrittenRaw = b.raw
        .replace(new RegExp(escapedQ), newQ)
        .replace(new RegExp(escapedA), newA);
      if (rewrittenRaw === b.raw) {
        changes.push({ q: b.q, status: 'skipped', reason: 'could not locate original text for in-place replace' });
        continue;
      }

      // Compute current offsets accounting for earlier edits
      let shift = 0;
      for (const s of offsetShift) if (s.start < b.start) shift += s.delta;
      const actualStart = b.start + shift;
      const actualEnd = b.end + shift;
      updated = updated.slice(0, actualStart) + rewrittenRaw + updated.slice(actualEnd);
      offsetShift.push({ start: b.start, delta: rewrittenRaw.length - b.raw.length });

      changes.push({ q: b.q, status: 'rewritten', removed: found });
    } catch (e) {
      changes.push({ q: b.q, status: 'failed', error: e.message });
    }
  }

  return { html: updated, changes };
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const push = args.includes('--push-shopify');
  if (!slug) {
    console.error('Usage: node agents/faq-rewriter/index.js <slug> [--push-shopify]');
    process.exit(1);
  }

  console.log('\nFAQ Rewriter\n');
  console.log(`  Post: ${slug}`);

  const contentPath = getContentPath(slug);
  if (!existsSync(contentPath)) { console.error(`No content at ${contentPath}`); process.exit(1); }
  const meta = getPostMeta(slug);
  if (!meta) { console.error(`No metadata for ${slug}`); process.exit(1); }

  const html = readFileSync(contentPath, 'utf8');
  const { html: updated, changes } = await fixCompetitorsInFaqs(html, meta.target_keyword || meta.title || slug);

  console.log(`  ${changes.length} violating Q&A(s) found`);
  for (const c of changes) {
    const label = c.status === 'rewritten' ? '✓' : c.status === 'failed' ? '✗' : '↷';
    console.log(`    ${label} ${c.q.slice(0, 70)}${c.q.length > 70 ? '…' : ''}`);
    if (c.removed) console.log(`      removed: ${c.removed.join(', ')}`);
    if (c.reason) console.log(`      reason: ${c.reason}`);
    if (c.error) console.log(`      error: ${c.error}`);
  }

  const wroteChanges = changes.some((c) => c.status === 'rewritten');
  if (!wroteChanges) {
    console.log('\nNo rewrites applied.');
    return;
  }

  // Backup then write
  const backup = contentPath.replace('.html', `.backup-${Date.now()}.html`);
  copyFileSync(contentPath, backup);
  writeFileSync(contentPath, updated);
  console.log(`\n  Wrote ${contentPath}`);
  console.log(`  Backup: ${basename(backup)}`);

  if (push && meta.shopify_blog_id && meta.shopify_article_id) {
    await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { body_html: updated });
    console.log(`  ✓ Pushed body_html to Shopify (article_id: ${meta.shopify_article_id})`);
  }
}

// Only run main() when invoked directly, not when imported as a module.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('agents/faq-rewriter/index.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
