#!/usr/bin/env node
/**
 * CRO Deep Dive — Content & Formatting
 *
 * Analyzes a blog post's CTA placement, image density, heading cadence,
 * and readability relative to scroll depth data.
 *
 * Usage:
 *   node agents/cro-deep-dive-content/index.js --handle <handle> --item "<title>"
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const CLARITY_DIR = join(ROOT, 'data', 'snapshots', 'clarity');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'cro', 'deep-dive');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const handle = args[args.indexOf('--handle') + 1];
const item   = args[args.indexOf('--item') + 1] || '';

if (!handle) {
  console.error('Usage: node index.js --handle <article-handle> --item "<title>"');
  process.exit(1);
}

// ── env / API key ─────────────────────────────────────────────────────────────
function loadEnv() {
  try {
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
  } catch { return {}; }
}

const env = loadEnv();
const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

const client = new Anthropic({ apiKey });

// ── data loading ──────────────────────────────────────────────────────────────

function mostRecentFile(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

async function fetchArticle(handle) {
  const blogs    = await getBlogs();
  const blog     = blogs.find(b => b.handle === 'news');
  if (!blog) throw new Error('Blog "news" not found');
  const articles = await getArticles(blog.id, { limit: 250 });
  const article  = articles.find(a => a.handle === handle);
  if (!article) throw new Error(`Article not found: ${handle}`);
  return article;
}

// ── HTML analysis ─────────────────────────────────────────────────────────────

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Extract just the article body content.
 * If <article> tags are present (blog post writer output includes them), use that.
 * Otherwise strip <script> blocks and <meta> tags to remove schema/head content.
 */
function extractArticleContent(html) {
  const articleStart = html.indexOf('<article');
  const articleEnd = html.lastIndexOf('</article>');
  if (articleStart !== -1 && articleEnd > articleStart) {
    const afterTag = html.indexOf('>', articleStart);
    return html.slice(afterTag + 1, articleEnd);
  }
  // Fallback: strip script blocks (JSON-LD etc.) and meta/title tags
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]*/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
}

function analyzeHtml(rawHtml) {
  // Work on article body only — strips JSON-LD schema and meta tags from word count
  const html = extractArticleContent(rawHtml);

  const totalText = stripTags(html);
  const wordTotal = wordCount(totalText);

  // CTA positions — detect rsc-cta-block divs (from cro-cta-injector) AND
  // <section> blocks with collection/product links (from blog-post-writer)
  const ctas = [];

  // Pattern 1: rsc-cta-block
  let ctaSearchFrom = 0;
  while (true) {
    const idx = html.indexOf('rsc-cta-block', ctaSearchFrom);
    if (idx === -1) break;
    const blockEnd = html.indexOf('</div>', idx);
    const block = html.slice(idx, blockEnd > idx ? blockEnd : idx + 500);
    const btnMatch = block.match(/href="[^"]*"[^>]*>([^<]+)</);
    const buttonText = btnMatch ? btnMatch[1].trim() : 'Shop Now';
    const wordsBefore = wordCount(stripTags(html.slice(0, idx)));
    const positionPct = wordTotal > 0 ? Math.round((wordsBefore / wordTotal) * 100) : 0;
    ctas.push({ positionPct, buttonText, wordOffset: wordsBefore });
    ctaSearchFrom = idx + 1;
  }

  // Pattern 2: <section> blocks containing collection/product links
  let sectionSearch = 0;
  while (true) {
    const idx = html.indexOf('<section', sectionSearch);
    if (idx === -1) break;
    const sectionEnd = html.indexOf('</section>', idx);
    const section = html.slice(idx, sectionEnd > idx ? sectionEnd + 10 : idx + 1000);
    if (/href="[^"]*\/(collections|products)\/[^"]*"/.test(section)) {
      const linkMatch = section.match(/>([^<]{2,50})<\/a>/);
      const buttonText = linkMatch ? linkMatch[1].trim() : 'Shop Now';
      const wordsBefore = wordCount(stripTags(html.slice(0, idx)));
      const positionPct = wordTotal > 0 ? Math.round((wordsBefore / wordTotal) * 100) : 0;
      ctas.push({ positionPct, buttonText, wordOffset: wordsBefore });
    }
    sectionSearch = idx + 1;
  }

  // Sort by position and deduplicate (same word offset within 5 words = same block)
  ctas.sort((a, b) => a.wordOffset - b.wordOffset);
  const dedupedCtas = ctas.filter((c, i) => i === 0 || c.wordOffset - ctas[i - 1].wordOffset > 5);

  // Image positions
  const imageOffsets = [];
  let imgSearch = 0;
  while (true) {
    const idx = html.indexOf('<img', imgSearch);
    if (idx === -1) break;
    imageOffsets.push(wordCount(stripTags(html.slice(0, idx))));
    imgSearch = idx + 1;
  }

  // Visual gaps (images + CTAs combined)
  const visualOffsets = [...imageOffsets, ...dedupedCtas.map(c => c.wordOffset)].sort((a, b) => a - b);
  const imagGaps = [];
  const checkpoints = [0, ...visualOffsets, wordTotal];
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const gap = checkpoints[i + 1] - checkpoints[i];
    if (gap > 500) imagGaps.push({ startWord: checkpoints[i], gapWords: gap });
  }

  // Heading gaps
  const headingOffsets = [];
  const headingPattern = /<h[23][^>]*>/gi;
  let hMatch;
  while ((hMatch = headingPattern.exec(html)) !== null) {
    headingOffsets.push(wordCount(stripTags(html.slice(0, hMatch.index))));
  }
  const headingGaps = [];
  const hCheckpoints = [0, ...headingOffsets, wordTotal];
  for (let i = 0; i < hCheckpoints.length - 1; i++) {
    const gap = hCheckpoints[i + 1] - hCheckpoints[i];
    if (gap > 400) headingGaps.push({ startWord: hCheckpoints[i], gapWords: gap });
  }

  // Long paragraphs
  const longParas = [];
  const paraPattern = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = paraPattern.exec(html)) !== null) {
    const text = stripTags(pMatch[1]);
    const wc = wordCount(text);
    if (wc > 120) {
      longParas.push({ startWord: wordCount(stripTags(html.slice(0, pMatch.index))), wordCount: wc });
    }
  }

  const wordsBeforeFirstCta = dedupedCtas.length > 0 ? dedupedCtas[0].wordOffset : null;

  return { wordTotal, ctas: dedupedCtas, imagGaps, headingGaps, longParas, wordsBeforeFirstCta };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('CRO Deep Dive — Content & Formatting\n');
  console.log('  Handle:', handle);
  console.log('  Item:  ', item);
  console.log();

  console.log('  Fetching article from Shopify...');
  const article = await fetchArticle(handle);
  const html = article.body_html || '';
  console.log('  Article:', article.title);

  console.log('  Analyzing HTML...');
  const findings = analyzeHtml(html);
  console.log(`  Total words: ${findings.wordTotal}`);
  console.log(`  CTAs found:  ${findings.ctas.length}`);
  console.log(`  Image gaps:  ${findings.imagGaps.length}`);
  console.log(`  Long paras:  ${findings.longParas.length}`);

  if (findings.ctas.length === 0) {
    console.log('  ⚠  No rsc-cta-block elements found — CTA position steps will be skipped');
  }

  // Load Clarity snapshot for site-wide scroll depth
  let scrollDepth = null;
  const clarityFile = mostRecentFile(CLARITY_DIR);
  if (clarityFile) {
    try {
      const snap = JSON.parse(readFileSync(clarityFile, 'utf8'));
      scrollDepth = snap?.behavior?.scrollDepth ?? snap?.scrollDepth ?? null;
    } catch { /* skip */ }
  }
  console.log(`  Scroll depth (site-wide): ${scrollDepth !== null ? scrollDepth + '%' : 'unavailable'}`);

  // Build findings summary
  const findingLines = [
    `Article: "${article.title}"`,
    `URL: https://www.realskincare.com/blogs/news/${handle}`,
    `Total word count: ${findings.wordTotal}`,
    `Site-wide avg scroll depth (Clarity, proxy): ${scrollDepth !== null ? scrollDepth + '%' : 'not available'}`,
    '',
    '--- CTA Analysis ---',
  ];

  if (findings.ctas.length === 0) {
    findingLines.push('No rsc-cta-block CTAs found in article.');
  } else {
    findings.ctas.forEach((c, i) => {
      const flag = scrollDepth !== null && c.positionPct > scrollDepth + 10 ? ' ⚠ BELOW SCROLL DROP-OFF' : '';
      findingLines.push(`CTA ${i + 1}: position ${c.positionPct}% of content, button text: "${c.buttonText}"${flag}`);
    });
    if (findings.wordsBeforeFirstCta !== null) {
      findingLines.push(`Words before first CTA: ${findings.wordsBeforeFirstCta}`);
    }
  }

  findingLines.push('', '--- Visual Gap Analysis (images + CTAs) ---');
  if (findings.imagGaps.length === 0) {
    findingLines.push('No visual gaps > 500 words found.');
  } else {
    findings.imagGaps.forEach(g => {
      findingLines.push(`Gap of ${g.gapWords} words starting at word ${g.startWord} — no image or CTA`);
    });
  }

  findingLines.push('', '--- Heading Cadence ---');
  if (findings.headingGaps.length === 0) {
    findingLines.push('No heading gaps > 400 words found.');
  } else {
    findings.headingGaps.forEach(g => {
      findingLines.push(`Gap of ${g.gapWords} words starting at word ${g.startWord} — no H2/H3`);
    });
  }

  findingLines.push('', '--- Long Paragraphs (>120 words) ---');
  if (findings.longParas.length === 0) {
    findingLines.push('No paragraphs over 120 words found.');
  } else {
    findings.longParas.forEach(p => {
      findingLines.push(`Paragraph at word ${p.startWord}: ${p.wordCount} words`);
    });
  }

  const findingsSummary = findingLines.join('\n');
  console.log('\nFindings summary:\n' + findingsSummary);

  // Call Claude to synthesize the report
  console.log('\n  Generating report with Claude...');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a senior CRO analyst specializing in content formatting and user engagement.

You have been given structured findings from an automated analysis of a blog post. Your job is to write a concise deep-dive report with a specific action plan.

ACTION ITEM BEING ANALYZED: "${item}"

AUTOMATED FINDINGS:
${findingsSummary}

Write the report in this exact format:

## Content & Formatting Deep Dive — ${article.title}
**Page:** https://www.realskincare.com/blogs/news/${handle}
**Action Item Analyzed:** ${item}

### What We Found
[3-6 bullet points. Only include findings that represent genuine issues. Be specific — cite exact numbers from the findings above. If scroll depth data is available, use it to contextualize CTA positions.]

### Action Plan
[Numbered list of 3-5 specific actions. Each action must say exactly what to change and where. For CTA moves, say "move CTA from position X% to Y%" with the target Y being at or below the scroll depth. For image insertions, say "after paragraph N" or "at word count X". Do not recommend adding CTAs if CTAs already exist at good positions.]

Keep the report tightly focused on what the data shows. Do not include generic advice not supported by the findings.`,
    }],
  });

  if (!response.content?.[0]?.text) throw new Error('Claude returned empty content');
  const reportContent = response.content[0].text;

  // Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const reportPath = join(REPORTS_DIR, `${today}-content-${handle}.md`);
  writeFileSync(reportPath, reportContent);
  console.log('\n  Report saved to:', reportPath);
  console.log('\n' + reportContent);

  await notify({
    subject: `CRO Deep Dive Content: ${handle}`,
    body: reportContent,
    status: 'success',
  }).catch(() => {});

  console.log('\n  Done.');
}

main().catch(async err => {
  console.error('Error:', err.message);
  await notify({ subject: 'CRO Deep Dive Content failed', body: err.message, status: 'error' }).catch(() => {});
  process.exit(1);
});
