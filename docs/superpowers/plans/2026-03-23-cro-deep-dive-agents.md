# CRO Deep Dive Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three category-expert deep-dive agents (content-formatting, seo-discovery, trust-conversion) that read actual page HTML and data before producing specific action plans, triggered by "Deep Dive" buttons on each CRO brief action item.

**Architecture:** Each action item in the CRO brief gets a `<!-- category:X page:Y -->` HTML comment tag embedded in the heading. The dashboard parses these tags and renders a "Deep Dive" button that spawns the appropriate agent with `--handle` and `--item` arguments. Each agent fetches the article HTML, gathers data (local snapshots, GSC API, Ahrefs REST API), and calls Claude to synthesize a specific action plan which is saved and emailed.

**Tech Stack:** Node.js ES modules, Anthropic SDK (`@anthropic-ai/sdk`), Shopify REST API (`lib/shopify.js`), Google Search Console API (`lib/gsc.js`), Ahrefs REST API v3, `lib/notify.js`

---

## File Structure

```
agents/cro-analyzer/index.js          MODIFY  — update prompt format + instructions
agents/cro-deep-dive-content/index.js CREATE  — Content & Formatting expert agent
agents/cro-deep-dive-seo/index.js     CREATE  — SEO & Discovery expert agent
agents/cro-deep-dive-trust/index.js   CREATE  — Trust & Conversion expert agent
agents/dashboard/index.js             MODIFY  — allowlist, brief parser, Deep Dive buttons, run-logs
data/reports/cro/deep-dive/           CREATED at runtime by agents
```

---

## Task 1: CRO Analyzer — Add Category + Page Tags

**Files:**
- Modify: `agents/cro-analyzer/index.js:93-106`

The CRO analyzer's output format section (line 93–106) must be updated to instruct Claude to:
1. Append `<!-- category:X page:Y -->` to each action item heading
2. Extract the page handle from GSC URLs in the snapshot data
3. Omit the tag when an item is not page-specific (e.g. checkout flow improvements)

- [ ] **Step 1: Open the file and locate the output format instructions**

```
agents/cro-analyzer/index.js, lines 88–106
```

The current heading format is:
```
### 1. [SHORT TITLE] — [HIGH/MED/LOW]
```

- [ ] **Step 2: Update the output format section of the prompt**

Replace lines 93–106 with:

```js
Output format (Markdown):
## Summary
[2-3 sentence overview of the week's performance]

## Action Items

### 1. [SHORT TITLE] <!-- category:[CATEGORY] page:[HANDLE] --> — [HIGH/MED/LOW]
**Evidence:** [specific metric + value]
**Action:** [concrete thing to do]

[repeat for each item]

## Raw Data
[paste key metrics as a compact table]

CATEGORY rules (pick one — omit the tag entirely if not page-specific):
- content-formatting: CTA placement, image gaps, heading cadence, readability, paragraph length
- seo-discovery: meta title/description, keyword ranking, internal linking, content gaps
- trust-conversion: social proof, CTA copy, above-the-fold value prop, product framing

HANDLE rules: extract from a blog URL in the GSC data.
Example: https://www.realskincare.com/blogs/news/can-you-use-coconut-oil-as-toothpaste → handle is can-you-use-coconut-oil-as-toothpaste
If the item is not tied to a specific blog post (e.g. checkout, site-wide), omit the tag entirely.
```

The edit to make in the source file — find the existing `Output format (Markdown):` block and replace just the heading format line and add the CATEGORY/HANDLE rules after the raw data section:

```js
// In agents/cro-analyzer/index.js, find:
const systemPrompt = `...

Output format (Markdown):
## Summary
[2-3 sentence overview of the week's performance]

## Action Items

### 1. [SHORT TITLE] — [HIGH/MED/LOW]
**Evidence:** [specific metric + value]
**Action:** [concrete thing to do]

[repeat for each item]

## Raw Data
[paste key metrics as a compact table]`;

// Replace the heading format and add after Raw Data:
// ### 1. [SHORT TITLE] <!-- category:[CATEGORY] page:[HANDLE] --> — [HIGH/MED/LOW]
// ... (add CATEGORY rules and HANDLE rules as shown above)
```

- [ ] **Step 3: Verify the edit is syntactically valid**

```bash
node --check agents/cro-analyzer/index.js
```

Expected: No output (no syntax errors)

- [ ] **Step 4: Run the analyzer and check the output format**

```bash
node agents/cro-analyzer/index.js
```

Open `data/reports/cro/` and find the most recent `*-cro-brief.md`. Verify at least one action item heading contains `<!-- category:... page:... -->` in the format:
```
### 1. Some Title <!-- category:content-formatting page:can-you-use-coconut-oil-as-toothpaste --> — HIGH
```

If no brief generates (no snapshot data locally), check existing brief files for the format — the analyzer only runs when snapshots are present.

- [ ] **Step 5: Commit**

```bash
git checkout -b feature/cro-deep-dive-agents
git add agents/cro-analyzer/index.js
git commit -m "feat(cro-analyzer): add category+page tags to action item headings"
```

---

## Task 2: Content & Formatting Deep-Dive Agent

**Files:**
- Create: `agents/cro-deep-dive-content/index.js`

This agent:
1. Parses `--handle` and `--item` from CLI args
2. Fetches the article HTML from Shopify
3. Runs JavaScript analysis: CTA positions, image gaps, heading cadence, paragraph lengths
4. Loads the most recent Clarity snapshot for site-wide scroll depth
5. Calls Claude to write a specific "What We Found" + "Action Plan" report
6. Saves to `data/reports/cro/deep-dive/` and emails via `notify()`

- [ ] **Step 1: Create the file with boilerplate and arg parsing**

```js
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
```

- [ ] **Step 2: Add the article fetch helper**

Append after the client setup:

```js
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
```

- [ ] **Step 3: Add the HTML analysis functions**

Append after the data loading section:

```js
// ── HTML analysis ─────────────────────────────────────────────────────────────

/** Strip all HTML tags and return plain text */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Count words in a string */
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Analyze the article HTML and return a structured findings object.
 * wordTotal: total word count
 * ctas: [{positionPct, buttonText}] — each rsc-cta-block with position as % of total words
 * imagGaps: [{startWord, gapWords}] — runs of >500 words with no image or CTA
 * headingGaps: [{heading, gapWords}] — runs of >400 words between consecutive H2/H3s
 * longParas: [{startWord, wordCount}] — paragraphs over 120 words
 * wordsBeforeFirstCta: number of words before the first CTA (or null if no CTA)
 */
function analyzeHtml(html) {
  // Split HTML into tokens: text nodes + elements we care about
  // Strategy: walk the HTML left-to-right tracking word count

  const totalText = stripTags(html);
  const wordTotal = wordCount(totalText);

  // CTA positions
  const ctas = [];
  let ctaSearchFrom = 0;
  while (true) {
    const idx = html.indexOf('rsc-cta-block', ctaSearchFrom);
    if (idx === -1) break;
    // Find button text inside this CTA
    const blockEnd = html.indexOf('</div>', idx);
    const block = html.slice(idx, blockEnd > idx ? blockEnd : idx + 500);
    const btnMatch = block.match(/href="[^"]*"[^>]*>([^<]+)</);
    const buttonText = btnMatch ? btnMatch[1].trim() : 'Shop Now';
    // Count words in HTML before this position
    const htmlBefore = html.slice(0, idx);
    const wordsBefore = wordCount(stripTags(htmlBefore));
    const positionPct = wordTotal > 0 ? Math.round((wordsBefore / wordTotal) * 100) : 0;
    ctas.push({ positionPct, buttonText, wordOffset: wordsBefore });
    ctaSearchFrom = idx + 1;
  }

  // Image positions (track word offsets of each <img>)
  const imageOffsets = [];
  let imgSearch = 0;
  while (true) {
    const idx = html.indexOf('<img', imgSearch);
    if (idx === -1) break;
    const wordsBefore = wordCount(stripTags(html.slice(0, idx)));
    imageOffsets.push(wordsBefore);
    imgSearch = idx + 1;
  }

  // CTA word offsets for gap calculation
  const visualOffsets = [...imageOffsets, ...ctas.map(c => c.wordOffset)].sort((a, b) => a - b);

  // Find gaps > 500 words between consecutive visual elements (images + CTAs)
  const imagGaps = [];
  const checkpoints = [0, ...visualOffsets, wordTotal];
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const gap = checkpoints[i + 1] - checkpoints[i];
    if (gap > 500) {
      imagGaps.push({ startWord: checkpoints[i], gapWords: gap });
    }
  }

  // Heading gaps: find H2/H3 positions
  const headingOffsets = [];
  const headingPattern = /<h[23][^>]*>/gi;
  let hMatch;
  while ((hMatch = headingPattern.exec(html)) !== null) {
    const wordsBefore = wordCount(stripTags(html.slice(0, hMatch.index)));
    headingOffsets.push(wordsBefore);
  }
  const headingGaps = [];
  const hCheckpoints = [0, ...headingOffsets, wordTotal];
  for (let i = 0; i < hCheckpoints.length - 1; i++) {
    const gap = hCheckpoints[i + 1] - hCheckpoints[i];
    if (gap > 400) headingGaps.push({ startWord: hCheckpoints[i], gapWords: gap });
  }

  // Long paragraphs (>120 words)
  const longParas = [];
  const paraPattern = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = paraPattern.exec(html)) !== null) {
    const text = stripTags(pMatch[1]);
    const wc = wordCount(text);
    if (wc > 120) {
      const wordsBefore = wordCount(stripTags(html.slice(0, pMatch.index)));
      longParas.push({ startWord: wordsBefore, wordCount: wc });
    }
  }

  // Words before first CTA
  const wordsBeforeFirstCta = ctas.length > 0 ? ctas[0].wordOffset : null;

  return { wordTotal, ctas, imagGaps, headingGaps, longParas, wordsBeforeFirstCta };
}
```

- [ ] **Step 4: Add the main function**

Append after the analysis functions:

```js
// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('CRO Deep Dive — Content & Formatting\n');
  console.log('  Handle:', handle);
  console.log('  Item:  ', item);
  console.log();

  // 1. Fetch article
  console.log('  Fetching article from Shopify...');
  const article = await fetchArticle(handle);
  const html = article.body_html || '';
  console.log('  Article:', article.title);

  // 2. Run analysis
  console.log('  Analyzing HTML...');
  const findings = analyzeHtml(html);
  console.log(`  Total words: ${findings.wordTotal}`);
  console.log(`  CTAs found:  ${findings.ctas.length}`);
  console.log(`  Image gaps:  ${findings.imagGaps.length}`);
  console.log(`  Long paras:  ${findings.longParas.length}`);

  if (findings.ctas.length === 0) {
    console.log('  ⚠  No rsc-cta-block elements found — CTA position steps will be skipped');
  }

  // 3. Load Clarity snapshot for site-wide scroll depth
  let scrollDepth = null;
  const clarityFile = mostRecentFile(CLARITY_DIR);
  if (clarityFile) {
    try {
      const snap = JSON.parse(readFileSync(clarityFile, 'utf8'));
      scrollDepth = snap?.behavior?.scrollDepth ?? snap?.scrollDepth ?? null;
    } catch { /* skip */ }
  }
  console.log(`  Scroll depth (site-wide): ${scrollDepth !== null ? scrollDepth + '%' : 'unavailable'}`);

  // 4. Build structured findings summary for Claude
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

  // 5. Call Claude to synthesize the report
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

  const reportContent = response.content[0].text;

  // 6. Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  const reportPath = join(REPORTS_DIR, `${today}-content-${handle}.md`);
  writeFileSync(reportPath, reportContent);
  console.log('\n  Report saved to:', reportPath);
  console.log('\n' + reportContent);

  // 7. Email
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
```

- [ ] **Step 5: Verify syntax**

```bash
node --check agents/cro-deep-dive-content/index.js
```

Expected: No output

- [ ] **Step 6: Run dry test**

```bash
node agents/cro-deep-dive-content/index.js --handle can-you-use-coconut-oil-as-toothpaste --item "Improve content formatting"
```

Expected output:
- Lines showing article title fetched
- CTA count, word count, gap counts
- Findings summary printed to console
- "Generating report with Claude..."
- Report content printed
- "Report saved to: data/reports/cro/deep-dive/YYYY-MM-DD-content-can-you-use-coconut-oil-as-toothpaste.md"

Check the saved report file contains real line-level recommendations (not generic advice).

- [ ] **Step 7: Commit**

```bash
git add agents/cro-deep-dive-content/index.js
git commit -m "feat: add CRO deep dive content & formatting agent"
```

---

## Task 3: SEO & Discovery Deep-Dive Agent

**Files:**
- Create: `agents/cro-deep-dive-seo/index.js`

This agent uses `lib/gsc.js` for per-page keyword data and the Ahrefs REST API for keyword difficulty + SERP competitors.

- [ ] **Step 1: Create the file**

```js
#!/usr/bin/env node
/**
 * CRO Deep Dive — SEO & Discovery
 *
 * Analyzes a blog post's title, meta description, keyword alignment,
 * internal links, and competitive SERP position.
 *
 * Usage:
 *   node agents/cro-deep-dive-seo/index.js --handle <handle> --item "<title>"
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'cro', 'deep-dive');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const handle = args[args.indexOf('--handle') + 1];
const item   = args[args.indexOf('--item') + 1] || '';

if (!handle) {
  console.error('Usage: node index.js --handle <article-handle> --item "<title>"');
  process.exit(1);
}

// ── env ───────────────────────────────────────────────────────────────────────
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
const ahrefsKey = env.AHREFS_API_KEY;

const client = new Anthropic({ apiKey });

// ── Ahrefs REST API ───────────────────────────────────────────────────────────
const AHREFS_BASE = 'https://api.ahrefs.com/v3';

async function ahrefs(endpoint, params) {
  if (!ahrefsKey) return null;
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${AHREFS_BASE}${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${ahrefsKey}` },
  });
  if (!res.ok) {
    console.warn(`  Ahrefs ${endpoint} → HTTP ${res.status} (skipping)`);
    return null;
  }
  return res.json();
}

// ── article fetch ─────────────────────────────────────────────────────────────
async function fetchArticle(handle) {
  const blogs    = await getBlogs();
  const blog     = blogs.find(b => b.handle === 'news');
  if (!blog) throw new Error('Blog "news" not found');
  const articles = await getArticles(blog.id, { limit: 250 });
  const article  = articles.find(a => a.handle === handle);
  if (!article) throw new Error(`Article not found: ${handle}`);
  return article;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : null;
}

function countInternalLinks(html) {
  const matches = html.match(/href="\/collections\/|href="\/products\//g);
  return matches ? matches.length : 0;
}
```

- [ ] **Step 2: Add the main function**

Append to the same file:

```js
// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('CRO Deep Dive — SEO & Discovery\n');
  console.log('  Handle:', handle);

  // 1. Fetch article
  console.log('  Fetching article from Shopify...');
  const article = await fetchArticle(handle);
  const html = article.body_html || '';
  const pageUrl = `https://www.realskincare.com/blogs/news/${handle}`;
  console.log('  Article:', article.title);

  // 2. Extract on-page SEO elements
  const titleTag       = article.title || '';
  const metaDesc       = article.summary_html ? stripTags(article.summary_html) : '';
  const h1             = extractH1(html);
  const internalLinks  = countInternalLinks(html);

  // 3. GSC per-page keyword data
  console.log('  Fetching GSC keywords for this page...');
  let gscKeywords = [];
  try {
    const { getPageKeywords } = await import('../../lib/gsc.js');
    gscKeywords = await getPageKeywords(pageUrl, 5, 90);
    console.log(`  GSC keywords: ${gscKeywords.length} found`);
  } catch (e) {
    console.warn('  GSC unavailable:', e.message);
  }

  // 4. Ahrefs keyword overview + SERP for top query
  let kwOverview = null;
  let serpData   = null;
  const topQuery = gscKeywords[0]?.keyword;
  if (topQuery && ahrefsKey) {
    console.log(`  Fetching Ahrefs data for top query: "${topQuery}"...`);
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    kwOverview = await ahrefs('/keywords-explorer/overview', {
      keywords: topQuery,
      country: 'us',
      date_from: thirtyDaysAgo,
      date_to: today,
    });
    serpData = await ahrefs('/serp-overview', {
      keyword: topQuery,
      country: 'us',
    });
  }

  // 5. Build findings summary
  const lines = [
    `Article: "${article.title}"`,
    `URL: ${pageUrl}`,
    '',
    '--- On-Page SEO ---',
    `Title tag: "${titleTag}" (${titleTag.length} chars)`,
    `H1: ${h1 ? '"' + h1 + '"' : 'NOT FOUND'}`,
    `Meta description: ${metaDesc ? '"' + metaDesc.slice(0, 200) + (metaDesc.length > 200 ? '...' : '') + '" (' + metaDesc.length + ' chars)' : 'MISSING'}`,
    `Internal links to collections/products: ${internalLinks}`,
    '',
    '--- GSC Performance (top 5 queries for this page, 90 days) ---',
  ];

  if (gscKeywords.length === 0) {
    lines.push('No GSC data available for this page.');
  } else {
    gscKeywords.forEach((k, i) => {
      const ctrPct = (k.ctr * 100).toFixed(1);
      lines.push(`${i + 1}. "${k.keyword}" — ${k.impressions} impressions, #${k.position?.toFixed(1)} avg position, ${ctrPct}% CTR`);
    });
  }

  lines.push('', '--- Ahrefs Keyword Data ---');
  if (!topQuery) {
    lines.push('No top query found — no Ahrefs data.');
  } else if (kwOverview) {
    const kd = kwOverview.keywords?.[0]?.difficulty ?? 'N/A';
    const vol = kwOverview.keywords?.[0]?.volume ?? 'N/A';
    lines.push(`Top query: "${topQuery}" — KD ${kd}, ${vol} monthly searches`);
  } else {
    lines.push(`Ahrefs unavailable or no data for "${topQuery}"`);
  }

  if (serpData?.positions) {
    const top5 = serpData.positions.slice(0, 5);
    lines.push(`SERP top 5 for "${topQuery}":`);
    top5.forEach((p, i) => {
      const isSite = p.url?.includes('realskincare.com');
      lines.push(`  ${i + 1}. ${p.url} ${isSite ? '← OUR PAGE' : ''}`);
    });
  }

  const findingsSummary = lines.join('\n');
  console.log('\nFindings:\n' + findingsSummary);

  // 6. Claude generates the report
  console.log('\n  Generating report with Claude...');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a senior SEO analyst. You have automated findings from a blog post analysis.

ACTION ITEM BEING ANALYZED: "${item}"

AUTOMATED FINDINGS:
${findingsSummary}

Write the report in this exact format:

## SEO & Discovery Deep Dive — ${article.title}
**Page:** ${pageUrl}
**Action Item Analyzed:** ${item}

### What We Found
[3-6 bullet points with specific numbers. Flag: keyword not in title/H1/meta, meta too long/short, low CTR vs position, few internal links, competitor patterns from SERP.]

### Action Plan
[3-5 numbered specific actions. For title rewrites, provide the actual rewritten title in quotes. For meta descriptions, provide the actual suggested copy (≤160 chars). For internal links, name which collections/products to link to. For featured snippet opportunity, suggest the exact paragraph structure.]

Base all recommendations on the data. Do not invent issues not present in the findings.`,
    }],
  });

  const reportContent = response.content[0].text;

  // 7. Save and email
  mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  const reportPath = join(REPORTS_DIR, `${today}-seo-${handle}.md`);
  writeFileSync(reportPath, reportContent);
  console.log('\n  Saved to:', reportPath);
  console.log('\n' + reportContent);

  await notify({
    subject: `CRO Deep Dive SEO: ${handle}`,
    body: reportContent,
    status: 'success',
  }).catch(() => {});

  console.log('\n  Done.');
}

main().catch(async err => {
  console.error('Error:', err.message);
  await notify({ subject: 'CRO Deep Dive SEO failed', body: err.message, status: 'error' }).catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 3: Verify syntax**

```bash
node --check agents/cro-deep-dive-seo/index.js
```

Expected: No output

- [ ] **Step 4: Run dry test**

```bash
node agents/cro-deep-dive-seo/index.js --handle best-fluoride-free-toothpaste --item "Improve SEO targeting"
```

Expected: GSC keywords printed, Ahrefs data (or "unavailable" warning), Claude report generated, file saved.

- [ ] **Step 5: Commit**

```bash
git add agents/cro-deep-dive-seo/index.js
git commit -m "feat: add CRO deep dive SEO & discovery agent"
```

---

## Task 4: Trust & Conversion Deep-Dive Agent

**Files:**
- Create: `agents/cro-deep-dive-trust/index.js`

This agent analyzes above-the-fold copy, social proof signals, CTA copy specificity, and reads Shopify product metafields for review data.

- [ ] **Step 1: Create the file**

```js
#!/usr/bin/env node
/**
 * CRO Deep Dive — Trust & Conversion
 *
 * Analyzes a blog post's above-the-fold value proposition, social proof,
 * CTA copy quality, and product review availability.
 *
 * Usage:
 *   node agents/cro-deep-dive-trust/index.js --handle <handle> --item "<title>"
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, getProducts, getCustomCollections, getMetafields } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'cro', 'deep-dive');

const args = process.argv.slice(2);
const handle = args[args.indexOf('--handle') + 1];
const item   = args[args.indexOf('--item') + 1] || '';

if (!handle) {
  console.error('Usage: node index.js --handle <article-handle> --item "<title>"');
  process.exit(1);
}

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

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
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
```

- [ ] **Step 2: Add analysis helpers**

Append to the same file:

```js
/** Extract first N words of plain text from HTML */
function firstNWords(html, n) {
  const text = stripTags(html);
  return text.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}

/** Find all linked product/collection handles from href attributes */
function extractLinkedHandles(html) {
  const products    = [];
  const collections = [];
  const pPattern = /href="\/products\/([^"/?]+)/g;
  const cPattern = /href="\/collections\/([^"/?]+)/g;
  let m;
  while ((m = pPattern.exec(html)) !== null) products.push(m[1]);
  while ((m = cPattern.exec(html)) !== null) collections.push(m[1]);
  return { products: [...new Set(products)], collections: [...new Set(collections)] };
}

/** Check CTA button copy — returns array of {buttonText, isGeneric} */
function analyzeCtas(html) {
  const results = [];
  const blockPattern = /rsc-cta-block[\s\S]*?<\/div>/g;
  let m;
  while ((m = blockPattern.exec(html)) !== null) {
    const block = m[0];
    // Extract the <a> button text
    const btnMatch = block.match(/>([^<]{3,})<\/a>/);
    const buttonText = btnMatch ? btnMatch[1].trim() : '';
    // Generic if it's just "Shop Now →" or "Shop Now" with no product noun
    const isGeneric = /^shop now[\s→]*$/i.test(buttonText);
    if (buttonText) results.push({ buttonText, isGeneric });
  }
  return results;
}

/** Count specific claims vs vague sentences in HTML text */
function analyzeClaimSpecificity(html) {
  const text = stripTags(html);
  // Split into sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const vagueTerms = /\b(effective|natural|clean|gentle|safe|pure|quality|healthy|great|amazing|perfect|wonderful|powerful|best|top|premium)\b/i;
  const specificTerms = /\d+%|\d+ mg|\d+ oz|lauric acid|caprylic|capric|coconut oil|baking soda|zinc|magnesium|activated charcoal|fluoride|SLS|parabens|aluminum|clinical|study|research|tested/i;

  let vague = 0, specific = 0;
  sentences.forEach(s => {
    if (specificTerms.test(s)) specific++;
    else if (vagueTerms.test(s)) vague++;
  });
  return { total: sentences.length, specific, vague };
}

/** Scan for social proof signals */
function findSocialProof(html) {
  const text = stripTags(html).toLowerCase();
  const signals = [];
  if (/\d+[\s,]*reviews?/.test(text)) signals.push('review count mentioned');
  if (/\d+(\.\d+)?\s*stars?|\★/.test(text)) signals.push('star rating mentioned');
  if (/testimonial|customer said|says:|"[^"]{10,}"/.test(text)) signals.push('testimonial/quote present');
  if (/certified|certification|usda|organic|fda|non-gmo|cruelty.free/.test(text)) signals.push('certification mentioned');
  return signals;
}

/** Try to get review metafield from a Shopify resource */
async function getReviewData(resource, resourceId) {
  try {
    const metafields = await getMetafields(resource, resourceId);
    // Common review app namespaces
    const reviewMF = metafields.find(m =>
      (m.namespace === 'judgeme' && m.key === 'product_widget') ||
      (m.namespace === 'yotpo'   && m.key === 'main_widget')    ||
      (m.namespace === 'okendo'  && m.key === 'reviews_widget') ||
      m.key.includes('rating') || m.key.includes('review')
    );
    if (reviewMF) return { found: true, namespace: reviewMF.namespace, key: reviewMF.key, value: reviewMF.value };
    return { found: false };
  } catch {
    return { found: false };
  }
}
```

- [ ] **Step 3: Add the main function**

Append to the same file:

```js
async function main() {
  console.log('CRO Deep Dive — Trust & Conversion\n');
  console.log('  Handle:', handle);

  // 1. Fetch article
  console.log('  Fetching article...');
  const article = await fetchArticle(handle);
  const html = article.body_html || '';
  const pageUrl = `https://www.realskincare.com/blogs/news/${handle}`;
  console.log('  Article:', article.title);

  // 2. Analyze trust signals
  const aboveTheFold = firstNWords(html, 200);
  const ctas         = analyzeCtas(html);
  const socialProof  = findSocialProof(html);
  const claims       = analyzeClaimSpecificity(html);
  const linked       = extractLinkedHandles(html);

  console.log(`  CTAs: ${ctas.length}, generic: ${ctas.filter(c => c.isGeneric).length}`);
  console.log(`  Social proof signals: ${socialProof.length}`);
  console.log(`  Claim specificity: ${claims.specific} specific, ${claims.vague} vague`);
  console.log(`  Linked products: ${linked.products.length}, collections: ${linked.collections.length}`);

  // 3. GSC CTR for this page
  let gscPerf = null;
  try {
    const { getPagePerformance } = await import('../../lib/gsc.js');
    gscPerf = await getPagePerformance(pageUrl, 90);
    console.log(`  GSC CTR: ${gscPerf.ctr ? (gscPerf.ctr * 100).toFixed(1) + '%' : 'N/A'}`);
  } catch (e) {
    console.warn('  GSC unavailable:', e.message);
  }

  // 4. Fetch review metafields for linked products/collections
  const reviewResults = [];
  for (const prodHandle of linked.products.slice(0, 3)) {
    try {
      const prods = await getProducts({ handle: prodHandle });
      if (prods[0]) {
        const rv = await getReviewData('products', prods[0].id);
        reviewResults.push({ type: 'product', handle: prodHandle, id: prods[0].id, ...rv });
      }
    } catch { /* skip */ }
  }
  for (const colHandle of linked.collections.slice(0, 3)) {
    try {
      const cols = await getCustomCollections({ handle: colHandle });
      if (cols[0]) {
        const rv = await getReviewData('custom_collections', cols[0].id);
        reviewResults.push({ type: 'collection', handle: colHandle, id: cols[0].id, ...rv });
      }
    } catch { /* skip */ }
  }

  // 5. Build findings summary
  const lines = [
    `Article: "${article.title}"`,
    `URL: ${pageUrl}`,
    '',
    '--- Above the Fold (first 200 words) ---',
    aboveTheFold,
    '',
    '--- CTA Copy Analysis ---',
  ];
  if (ctas.length === 0) {
    lines.push('No rsc-cta-block CTAs found.');
  } else {
    ctas.forEach((c, i) => {
      lines.push(`CTA ${i + 1}: "${c.buttonText}" — ${c.isGeneric ? 'GENERIC (no product noun)' : 'specific'}`);
    });
  }

  lines.push('', '--- Social Proof ---');
  if (socialProof.length === 0) {
    lines.push('No social proof signals found in article text.');
  } else {
    socialProof.forEach(s => lines.push('• ' + s));
  }

  lines.push('', '--- Claim Specificity ---');
  lines.push(`Specific claims: ${claims.specific} sentences`);
  lines.push(`Vague-only sentences: ${claims.vague} sentences`);
  lines.push(`Total sentences analyzed: ${claims.total}`);

  lines.push('', '--- GSC Performance ---');
  if (gscPerf) {
    lines.push(`Clicks: ${gscPerf.clicks}, Impressions: ${gscPerf.impressions}, CTR: ${gscPerf.ctr ? (gscPerf.ctr * 100).toFixed(1) + '%' : 'N/A'}, Position: ${gscPerf.position?.toFixed(1) ?? 'N/A'}`);
  } else {
    lines.push('GSC data unavailable.');
  }

  lines.push('', '--- Product/Collection Review Data ---');
  if (reviewResults.length === 0) {
    lines.push('No linked products/collections found or review data unavailable.');
  } else {
    reviewResults.forEach(r => {
      if (r.found) {
        lines.push(`${r.type} "${r.handle}": review metafield found (${r.namespace}.${r.key})`);
      } else {
        lines.push(`${r.type} "${r.handle}": no review metafield found`);
      }
    });
  }

  const findingsSummary = lines.join('\n');
  console.log('\nFindings:\n' + findingsSummary);

  // 6. Claude generates the report
  console.log('\n  Generating report with Claude...');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a senior CRO analyst specializing in trust signals and conversion copy.

ACTION ITEM BEING ANALYZED: "${item}"

AUTOMATED FINDINGS:
${findingsSummary}

Write the report in this exact format:

## Trust & Conversion Deep Dive — ${article.title}
**Page:** ${pageUrl}
**Action Item Analyzed:** ${item}

### What We Found
[3-6 specific bullet points. Flag: generic CTA copy, missing social proof, vague-only copy, weak above-the-fold value prop. Use specific counts from findings.]

### Action Plan
[3-5 numbered specific actions. For CTA copy: provide the exact replacement copy. For social proof: say exactly where to add it and what to say (use review data if available). For above-the-fold: suggest the specific benefit claim to add. Be concrete.]

Base recommendations only on what the findings show.`,
    }],
  });

  const reportContent = response.content[0].text;

  mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  const reportPath = join(REPORTS_DIR, `${today}-trust-${handle}.md`);
  writeFileSync(reportPath, reportContent);
  console.log('\n  Saved to:', reportPath);
  console.log('\n' + reportContent);

  await notify({
    subject: `CRO Deep Dive Trust: ${handle}`,
    body: reportContent,
    status: 'success',
  }).catch(() => {});

  console.log('\n  Done.');
}

main().catch(async err => {
  console.error('Error:', err.message);
  await notify({ subject: 'CRO Deep Dive Trust failed', body: err.message, status: 'error' }).catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 4: Verify syntax**

```bash
node --check agents/cro-deep-dive-trust/index.js
```

Expected: No output

- [ ] **Step 5: Run dry test**

```bash
node agents/cro-deep-dive-trust/index.js --handle can-you-use-coconut-oil-as-toothpaste --item "Improve trust signals"
```

Expected: CTA counts, social proof findings, claim specificity counts, Claude report printed, file saved to `data/reports/cro/deep-dive/`.

- [ ] **Step 6: Commit**

```bash
git add agents/cro-deep-dive-trust/index.js
git commit -m "feat: add CRO deep dive trust & conversion agent"
```

---

## Task 5: Dashboard Integration

**Files:**
- Modify: `agents/dashboard/index.js`
  - Lines 80–94: `RUN_AGENT_ALLOWLIST` — add 3 new agents
  - Lines 1822–1861: brief item parser and rendering — extract category tag, render Deep Dive buttons
  - Line 947–948: tab-cro HTML — add 3 run-log pre elements

### Sub-task 5a: Add agents to allowlist

- [ ] **Step 1: Add three entries to RUN_AGENT_ALLOWLIST**

In `agents/dashboard/index.js` at line 87–93, after `'agents/cro-analyzer/index.js',` add:

```js
  'agents/cro-deep-dive-content/index.js',
  'agents/cro-deep-dive-seo/index.js',
  'agents/cro-deep-dive-trust/index.js',
```

The block should now read:
```js
const RUN_AGENT_ALLOWLIST = new Set([
  'agents/rank-tracker/index.js',
  'agents/content-gap/index.js',
  'agents/gsc-query-miner/index.js',
  'agents/sitemap-indexer/index.js',
  'agents/insight-aggregator/index.js',
  'agents/meta-ab-tracker/index.js',
  'agents/cro-analyzer/index.js',
  'agents/cro-deep-dive-content/index.js',
  'agents/cro-deep-dive-seo/index.js',
  'agents/cro-deep-dive-trust/index.js',
  'agents/competitor-intelligence/index.js',
  'agents/ads-optimizer/index.js',
  'scripts/create-meta-test.js',
  'scripts/ads-weekly-recap.js',
  'agents/campaign-creator/index.js',
  'agents/campaign-analyzer/index.js',
]);
```

### Sub-task 5b: Update brief parser and rendering

- [ ] **Step 2: Replace the brief parser block (lines 1821–1861)**

Find this block in the dashboard (starting at `// Parse action items from markdown`):

```js
    // Parse action items from markdown (lines starting with ### N.)
    const items = [];
    const lines = brief.content.split('\\n');
    let current = null;
    for (const line of lines) {
      if (/^### \d+\./.test(line)) {
        if (current) items.push(current);
        const titleMatch = line.match(/^### \d+\.\s+(.+?)\s+—\s+(HIGH|MED|LOW)/i);
        current = { title: titleMatch?.[1] || line.replace(/^### \d+\.\s*/, ''), priority: titleMatch?.[2] || '', body: [] };
      } else if (current && line.trim() && !/^##/.test(line)) {
        current.body.push(line.trim());
      }
    }
    if (current) items.push(current);

    const prioColor = p => p === 'HIGH' ? '#dc2626' : p === 'MED' ? '#d97706' : '#6b7280';

    // Map item title keywords → agent script + label
    const CRO_RESOLVERS = [
      { keyword: 'Add Prominent CTAs',   script: 'agents/cro-cta-injector/index.js', label: 'Inject CTAs' },
    ];

    briefHtml = '<div class="card" style="background:#fffbeb;border-color:#fde68a">' +
      '<div class="card-header"><h2 style="color:#92400e">AI CRO Brief</h2>' +
      '<span style="font-size:11px;color:#92400e">Generated ' + esc(brief.date) + ' · Next run: Every Monday</span></div>' +
      '<div class="card-body">' +
      (items.length ? '<div class="brief-grid">' +
        items.map(item => {
          const resolver = CRO_RESOLVERS.find(r => item.title.includes(r.keyword));
          const actions = resolver
            ? '<div class="brief-item-actions">' +
              '<button class="btn-cro-resolve" onclick="runAgent(\'' + resolver.script + '\', [\'--apply\'])">' + resolver.label + '</button>' +
              '<button class="btn-cro-preview" onclick="runAgent(\'' + resolver.script + '\', [])">Preview</button>' +
              '</div>'
            : '<div class="brief-item-actions"><span class="badge-manual">Manual</span></div>';
          return '<div class="brief-item">' +
            '<div class="brief-item-title" style="color:' + prioColor(item.priority) + '">' +
            (item.priority ? item.priority + ' — ' : '') + esc(item.title) + '</div>' +
            '<div class="brief-item-body">' + esc(item.body.join(' ')) + '</div>' +
            actions +
            '</div>';
        }).join('') + '</div>'
      : '<pre style="font-size:11px;white-space:pre-wrap;color:#78350f">' + esc(brief.content) + '</pre>') +
      '</div></div>';
```

Replace it with:

```js
    // Parse action items from markdown (lines starting with ### N.)
    // Heading format: ### N. Title <!-- category:X page:Y --> — HIGH/MED/LOW
    const items = [];
    const lines = brief.content.split('\\n');
    let current = null;
    for (const line of lines) {
      if (/^### \d+\./.test(line)) {
        if (current) items.push(current);
        // Extract category and page handle from HTML comment tag
        const tagMatch = line.match(/<!--[ ]*category:(\S+)[ ]+page:(\S+)[ ]*-->/);
        const category = tagMatch ? tagMatch[1] : null;
        const page     = tagMatch ? tagMatch[2] : null;
        // Strip comment and priority suffix to get clean title
        // Use [ ] not \s — \s is processed by Node.js in this template literal
        const rawTitle = line
          .replace(/<!--.*?-->/g, '')
          .replace(/[ ]*—[ ]*(HIGH|MED|LOW)[ ]*$/i, '')
          .replace(/^### \d+\.[ ]*/, '')
          .trim();
        const priorityMatch = line.match(/—[ ]*(HIGH|MED|LOW)/i);
        const priority = priorityMatch ? priorityMatch[1].toUpperCase() : '';
        current = { title: rawTitle, priority, category, page, body: [] };
      } else if (current && line.trim() && !/^##/.test(line)) {
        current.body.push(line.trim());
      }
    }
    if (current) items.push(current);

    const prioColor = p => p === 'HIGH' ? '#dc2626' : p === 'MED' ? '#d97706' : '#6b7280';

    const DEEP_DIVE_AGENTS = {
      'content-formatting': 'agents/cro-deep-dive-content/index.js',
      'seo-discovery':      'agents/cro-deep-dive-seo/index.js',
      'trust-conversion':   'agents/cro-deep-dive-trust/index.js',
    };

    // Map item title keywords → agent script + label (existing CTA injector)
    const CRO_RESOLVERS = [
      { keyword: 'Add Prominent CTAs', script: 'agents/cro-cta-injector/index.js', label: 'Inject CTAs' },
    ];

    briefHtml = '<div class="card" style="background:#fffbeb;border-color:#fde68a">' +
      '<div class="card-header"><h2 style="color:#92400e">AI CRO Brief</h2>' +
      '<span style="font-size:11px;color:#92400e">Generated ' + esc(brief.date) + ' · Next run: Every Monday</span></div>' +
      '<div class="card-body">' +
      (items.length ? '<div class="brief-grid">' +
        items.map(function(item) {
          var deepDiveAgent = item.category ? DEEP_DIVE_AGENTS[item.category] : null;
          var resolver = CRO_RESOLVERS.find(function(r) { return item.title.includes(r.keyword); });
          var actions;
          if (deepDiveAgent && item.page) {
            actions = '<div class="brief-item-actions">' +
              '<button class="btn-cro-resolve" onclick="runAgent(' + JSON.stringify(deepDiveAgent) + ', [\'--handle\', ' + JSON.stringify(item.page) + ', \'--item\', ' + JSON.stringify(item.title) + '])">Deep Dive</button>' +
              '</div>';
          } else if (resolver) {
            actions = '<div class="brief-item-actions">' +
              '<button class="btn-cro-resolve" onclick="runAgent(\'' + resolver.script + '\', [\'--apply\'])">' + resolver.label + '</button>' +
              '<button class="btn-cro-preview" onclick="runAgent(\'' + resolver.script + '\', [])">Preview</button>' +
              '</div>';
          } else {
            actions = '<div class="brief-item-actions"><span class="badge-manual">Manual</span></div>';
          }
          return '<div class="brief-item">' +
            '<div class="brief-item-title" style="color:' + prioColor(item.priority) + '">' +
            (item.priority ? item.priority + ' — ' : '') + esc(item.title) + '</div>' +
            '<div class="brief-item-body">' + esc(item.body.join(' ')) + '</div>' +
            actions +
            '</div>';
        }).join('') + '</div>'
      : '<pre style="font-size:11px;white-space:pre-wrap;color:#78350f">' + esc(brief.content) + '</pre>') +
      '</div></div>';
```

**Critical escape sequence check:** The regex `replace(/[ ]*—[ ]*(HIGH|MED|LOW)[ ]*$/i, '')` uses `[ ]` (character class with literal space) instead of `\s`. This is required because `\s` inside the Node.js template literal HTML string would be processed by Node.js as the letter `s`, breaking the regex.

### Sub-task 5c: Add run-log elements

- [ ] **Step 3: Add three run-log pre elements inside tab-cro**

Find line 947–948:
```html
  <pre id="run-log-agents-cro-cta-injector-index-js" class="run-log" style="display:none"></pre>
</div><!-- /tab-cro -->
```

Insert three new pre elements after the existing `cro-cta-injector` pre and before the closing `</div>`:

```html
  <pre id="run-log-agents-cro-cta-injector-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-deep-dive-content-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-deep-dive-seo-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-deep-dive-trust-index-js" class="run-log" style="display:none"></pre>
</div><!-- /tab-cro -->
```

- [ ] **Step 4: Verify dashboard syntax**

```bash
node --check agents/dashboard/index.js
```

Expected: No output

- [ ] **Step 5: Start dashboard and verify rendering**

```bash
node agents/dashboard/index.js
```

Open `http://localhost:3000` (or the configured port) and navigate to the CRO tab.

**Check 1:** The CRO brief renders (if a brief with category tags exists, "Deep Dive" buttons should appear in blue; items without tags show "Manual" badge).

**Check 2:** To test without a real brief, temporarily add a test brief file at `data/reports/cro/2026-03-23-cro-brief.md` with content:
```markdown
## Summary
Test brief.

## Action Items

### 1. Reposition CTAs for better visibility <!-- category:content-formatting page:can-you-use-coconut-oil-as-toothpaste --> — HIGH
**Evidence:** scroll depth 42%, CTA at 65%
**Action:** Move CTA up.
```

Reload the dashboard — the item should show a blue "Deep Dive" button. Clicking it should start streaming output in the `run-log-agents-cro-deep-dive-content-index-js` pre element.

**Check 3:** Open browser DevTools console — no JavaScript errors should appear.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(dashboard): add Deep Dive buttons for CRO brief action items"
```

---

## Task 6: Final Integration Test

- [ ] **Step 1: Run the full pipeline end-to-end**

If snapshot data is available:
```bash
node agents/cro-analyzer/index.js
```

Open the generated brief and verify at least one heading contains `<!-- category:... page:... -->`.

- [ ] **Step 2: Test each agent from CLI**

```bash
node agents/cro-deep-dive-content/index.js --handle can-you-use-coconut-oil-as-toothpaste --item "Reposition CTAs"
node agents/cro-deep-dive-seo/index.js     --handle best-fluoride-free-toothpaste          --item "Improve keyword targeting"
node agents/cro-deep-dive-trust/index.js   --handle can-you-use-coconut-oil-as-toothpaste  --item "Add social proof"
```

Verify: each produces a saved report in `data/reports/cro/deep-dive/` with real content.

- [ ] **Step 3: Test dashboard Deep Dive button flow**

Load the freshly generated brief in the dashboard. Verify Deep Dive buttons appear. Click one and verify output streams to the page.

- [ ] **Step 4: Final commit and push**

```bash
git push origin feature/cro-deep-dive-agents
```
