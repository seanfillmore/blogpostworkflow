/**
 * Content Refresher Agent
 *
 * Identifies published posts that are stagnating in positions 21–50 and rewrites
 * weak sections to improve rankings. Uses GSC data to find candidates, fetches
 * live content from Shopify, and uses Claude to produce a refreshed version.
 *
 * Strategy:
 *   1. Query GSC for blog pages at positions 21–50 with meaningful impressions
 *   2. For each page, fetch the live HTML from Shopify
 *   3. Claude analyzes what's weak (thin sections, missing keywords, stale info)
 *   4. Claude produces a refreshed HTML with improvements applied
 *   5. Saves refreshed content to data/posts/<slug>-refreshed.html
 *   6. With --apply, republishes to Shopify (as draft for review)
 *
 * Output:
 *   data/posts/<slug>-refreshed.html       — refreshed HTML for each post
 *   data/reports/content-refresh-report.md — summary of changes made
 *
 * Usage:
 *   node agents/content-refresher/index.js                   # dry run, auto-select targets
 *   node agents/content-refresher/index.js --apply            # push refreshed drafts to Shopify
 *   node agents/content-refresher/index.js --slug <slug>      # refresh one specific post
 *   node agents/content-refresher/index.js --count 5          # limit to 5 posts (default: 3)
 *   node agents/content-refresher/index.js --min-impr 50      # lower impression threshold
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getBlogs, getArticles, getArticle, updateArticle } from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'content-refresher');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── feedback loader ────────────────────────────────────────────────────────────

function loadAgentFeedback(agentName) {
  let combined = '';
  try {
    const feedbackPath = join(ROOT, 'data', 'context', 'feedback.md');
    const content = readFileSync(feedbackPath, 'utf8');
    const marker = `## ${agentName}`;
    const start = content.indexOf(marker);
    if (start !== -1) {
      const rest = content.slice(start + marker.length);
      const nextSection = rest.search(/\n## [a-z]/);
      const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
      combined += section.trim();
    }
  } catch { /* ignore */ }

  // Append writer standing rules — these are auto-detected editor patterns
  // that the writer avoids. The refresher must also avoid them so refreshes
  // don't reintroduce the same mistakes. See docs/signal-manifest.md.
  try {
    const rulesPath = join(ROOT, 'data', 'context', 'writer-standing-rules.md');
    const rules = readFileSync(rulesPath, 'utf8').trim();
    if (rules) combined += (combined ? '\n\n' : '') + rules;
  } catch { /* ignore */ }
  return combined;
}

/**
 * Load the post-performance verdict for a specific slug, if one exists.
 * Returns { verdict, reason, milestone, impressions, clicks, projection } or
 * null. The refresher uses this to target the rewrite at the actual cause
 * of the flop instead of running a generic refresh. See docs/signal-manifest.md.
 */
function loadPerformanceVerdict(slug) {
  try {
    const latestPath = join(ROOT, 'data', 'reports', 'post-performance', 'latest.json');
    const pp = JSON.parse(readFileSync(latestPath, 'utf8'));
    const match = (pp.action_required || []).find((r) => r.slug === slug);
    if (match) return match;
  } catch { /* ignore */ }
  // Also try the per-post review on the post JSON itself.
  try {
    const meta = JSON.parse(readFileSync(join(ROOT, 'data', 'posts', `${slug}.json`), 'utf8'));
    const review = meta.performance_review || {};
    // Pick the most recent non-ON_TRACK review
    const order = ['90d', '60d', '30d'];
    for (const key of order) {
      const r = review[key];
      if (r && r.verdict && r.verdict !== 'ON_TRACK') {
        return { ...r, milestone: parseInt(key, 10) };
      }
    }
  } catch { /* ignore */ }
  return null;
}

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

// ── helpers ───────────────────────────────────────────────────────────────────

function stripCodeFences(text) {
  return text.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const apply = args.includes('--apply');
const slugArg = getArg('--slug');
const count = parseInt(getArg('--count') ?? '3', 10);
const minImpressions = parseFloat(getArg('--min-impr') ?? '50');
const FEEDBACK = getArg('--feedback');

// ── article helpers ───────────────────────────────────────────────────────────

async function buildArticleIndex() {
  const blogs = await getBlogs();
  const byHandle = new Map();
  const byUrl = new Map();

  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      const url = `${config.url}/blogs/${blog.handle}/${a.handle}`;
      const entry = { ...a, blogId: blog.id, blogHandle: blog.handle, canonicalUrl: url };
      byHandle.set(a.handle, entry);
      byUrl.set(url, entry);
    }
  }
  return { byHandle, byUrl };
}

// ── claude refresh ────────────────────────────────────────────────────────────

async function refreshContent(article, keyword, position, impressions, relatedKeywords, slug = null) {
  const bodyText = article.body_html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);

  const relatedStr = relatedKeywords.length > 0
    ? relatedKeywords.map((k) => `"${k.keyword}" (pos #${Math.round(k.position)}, ${k.impressions} impr)`).join(', ')
    : 'none available';

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `You are a senior SEO content editor for ${config.name} (${config.url}), a natural skincare and personal care brand.

This blog post currently ranks at position #${Math.round(position)} for "${keyword}" with ${impressions} impressions/90 days. It needs a content refresh to improve to page 1.

ARTICLE TITLE: ${article.title}
TARGET KEYWORD: "${keyword}"
CURRENT POSITION: #${Math.round(position)}

RELATED KEYWORDS ALSO RANKING (add these naturally): ${relatedStr}

CURRENT CONTENT:
${bodyText}

---

Your task: produce a refreshed version of this HTML that:

1. **Strengthens weak sections** — identify H2 sections with thin content (<100 words) and expand them with specific, useful information
2. **Adds missing semantic keywords** — naturally weave in the related keywords listed above
3. **Updates any stale information** — replace "2024" or "2025" with "2026" where appropriate; update statistics if they feel outdated
4. **Improves the introduction** — the first 100 words should hook the reader and clearly include the target keyword
5. **Expands the FAQ section** (if present) — add 2–3 new Q&A pairs targeting the related keywords
6. **Improves readability** — rewrite overly clinical or academic sentences to an 8th grade reading level. Use short sentences, plain words, and direct address ("you", "your"). Replace jargon with plain English: "sore mouth" not "oral tissue irritation", "cleans your teeth" not "facilitates plaque removal". Break long paragraphs into 2–4 sentence chunks. The tone should feel like a knowledgeable friend explaining something clearly, not a textbook.
7. **Keeps the brand voice** — warm, practical, trustworthy; not salesy or over-optimized
8. **Adds or preserves CTA section blocks** — the post must include exactly three styled CTA sections using the design pattern below

CTA DESIGN PATTERN (use this exactly — do not deviate from the inline styles):

TOP CTA (very first element in the post, before intro paragraph):
<section style="border:1px solid #eee;border-radius:12px;padding:16px;margin:0 0 20px;background:#fafafa;text-align:center;">
  <h2 style="margin:0 0 8px;">[Short benefit headline]</h2>
  <p style="margin:0 0 12px;">[One sentence with linked product name]</p>
  <a href="[PRODUCT_URL]" style="display:inline-block;padding:12px 18px;border-radius:8px;background-color:#AEDEAC;color:#000;text-decoration:none;font-weight:600;">[Shop CTA]</a>
</section>

MID CTA (after 2–3 H2 sections, roughly mid-article):
<section style="border:1px dashed #ddd;border-radius:12px;padding:16px;margin:24px 0;text-align:center;">
  <h3 style="margin:0 0 8px;">[Question or desire statement]</h3>
  <p style="margin:0 0 12px;">[Brief product mention with link]</p>
  <a href="[PRODUCT_URL]" style="display:inline-block;padding:12px 18px;border-radius:8px;background-color:#AEDEAC;color:#000;text-decoration:none;font-weight:600;">Add to Cart</a>
</section>

BOTTOM CTA (absolute last element, after FAQs):
<section style="border:1px solid #eee;border-radius:12px;padding:16px;margin:24px 0;background:#f6fff6;text-align:center;">
  <h2 style="margin:0 0 8px;">[Action headline]</h2>
  <p style="margin:0 0 12px;">[Final pitch with collection or product link]</p>
  <a href="[COLLECTION_OR_PRODUCT_URL]" style="display:inline-block;padding:12px 18px;border-radius:8px;background-color:#AEDEAC;color:#000;text-decoration:none;font-weight:600;">Shop Now</a>
</section>

If the existing content already has these section CTAs, preserve and improve them. If not, add all three. Use the site's actual product and collection URLs — do not invent URLs.

IMPORTANT:
- Return ONLY the refreshed HTML body content (everything that would go in the Shopify article body_html field)
- Preserve all existing internal links and external links — do not remove any <a> tags
- Preserve all image tags
- Do not add new blog internal links (the internal linker handles that separately); you MAY add product/collection CTA links
- Do not change the H1 title
- No markdown, no explanation — just the HTML${(() => {
  const fb = loadAgentFeedback('content-refresher');
  return fb ? `\n\n---\n\nSTANDING FEEDBACK (from insight-aggregator — follow these in addition to the above):\n${fb}` : '';
})()}${(() => {
  if (!slug) return '';
  const verdict = loadPerformanceVerdict(slug);
  if (!verdict) return '';
  return `\n\n---\n\nPOST-PERFORMANCE VERDICT (why this post is being refreshed):\nAt the ${verdict.milestone || 'latest'}-day review this post was flagged ${verdict.verdict}. ${verdict.reason || ''}\n\nTarget your rewrite directly at this cause. Do not do a generic refresh. If the verdict says the projected traffic wasn't hit, figure out why — weak intro, missing topical coverage, title mismatch, thin sections — and fix that specific problem. If the verdict says BLOCKED (zero impressions), the issue is probably intent mismatch or indexing; focus on making the opening paragraph unambiguously match the target keyword and add a clearer content structure.`;
})()}${FEEDBACK ? `\n\n---\n\nFOUNDER FEEDBACK FROM PRIOR REFRESH:\nThe founder reviewed a previous version of this refresh and gave the following feedback. Apply it precisely — this is authoritative and overrides general strategy.\n\n${FEEDBACK}` : ''}`,
    }],
  });

  return stripCodeFences(message.content[0].text.trim());
}

// ── diff summary ──────────────────────────────────────────────────────────────

async function summarizeChanges(originalHtml, refreshedHtml, keyword) {
  const originalText = originalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const refreshedText = refreshedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Compare these two versions of a blog post targeting "${keyword}" and summarize what changed in 3–5 bullet points. Focus on content improvements (new sections, expanded coverage, updated data, added keywords). Be specific.

BEFORE (${originalText.split(' ').length} words):
${originalText.slice(0, 3000)}

AFTER (${refreshedText.split(' ').length} words):
${refreshedText.slice(0, 3000)}

Return only the bullet points, no preamble.`,
    }],
  });

  return message.content[0].text.trim();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nContent Refresher — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will push drafts to Shopify)' : 'DRY RUN (use --apply to publish)'}\n`);

  // Build article index
  process.stdout.write('  Indexing Shopify articles... ');
  const { byHandle, byUrl } = await buildArticleIndex();
  console.log(`${byUrl.size} articles`);

  // Select targets
  let targets = [];

  if (slugArg) {
    // Single-post mode
    const article = byHandle.get(slugArg);
    if (!article) {
      console.error(`Article not found in Shopify: ${slugArg}`);
      process.exit(1);
    }
    const gscData = await gsc.getPagePerformance(article.canonicalUrl, 90);
    const pageKws = await gsc.getPageKeywords(article.canonicalUrl, 5, 90);
    const topKw = pageKws[0];
    targets = [{
      article,
      keyword: topKw?.keyword || slugArg.replace(/-/g, ' '),
      position: topKw?.position ?? gscData.position ?? 30,
      impressions: gscData.impressions ?? 0,
      relatedKeywords: pageKws.slice(1),
    }];
  } else {
    // Auto-select from GSC — pages 21–50 with meaningful impressions
    process.stdout.write('  Fetching refresh candidates from GSC (positions 21–50)... ');
    const gscPages = await gsc.getQuickWinPages(200, 90);
    const candidates = gscPages
      .filter((p) => p.position >= 21 && p.position <= 50)
      .filter((p) => p.impressions >= minImpressions)
      .filter((p) => p.url.includes('/blogs/'));
    console.log(`${candidates.length} candidates`);

    for (const candidate of candidates.slice(0, count)) {
      const handle = candidate.url.split('/').filter(Boolean).pop();
      const article = byHandle.get(handle);
      if (!article) continue;

      const relatedKeywords = await gsc.getPageKeywords(candidate.url, 10, 90);

      targets.push({
        article,
        keyword: candidate.keyword,
        position: candidate.position,
        impressions: candidate.impressions,
        relatedKeywords: relatedKeywords.filter((k) => k.keyword !== candidate.keyword).slice(0, 5),
      });
    }
  }

  if (targets.length === 0) {
    console.log('  No refresh candidates found. Try --min-impr 25 or --slug <slug>.');
    process.exit(0);
  }

  console.log(`\n  Refreshing ${targets.length} post(s):\n`);
  targets.forEach((t, i) => {
    console.log(`  ${i + 1}. "${t.article.title}"`);
    console.log(`     Keyword: "${t.keyword}" | Position: #${Math.round(t.position)} | Impressions: ${t.impressions}`);
  });
  console.log('');

  const results = [];
  mkdirSync(POSTS_DIR, { recursive: true });

  for (let i = 0; i < targets.length; i++) {
    const { article, keyword, position, impressions, relatedKeywords } = targets[i];
    const slug = article.handle;

    console.log(`\n  [${i + 1}/${targets.length}] Refreshing "${article.title}"...`);
    process.stdout.write('    Generating refreshed content... ');

    try {
      // Fetch full article HTML (body_html) from Shopify
      const fullArticle = await getArticle(article.blogId, article.id);
      const originalHtml = fullArticle.body_html || '';

      const refreshedHtml = await refreshContent(fullArticle, keyword, position, impressions, relatedKeywords, slug);
      console.log(`done (${refreshedHtml.split(' ').length} words)`);

      process.stdout.write('    Summarizing changes... ');
      const changeSummary = await summarizeChanges(originalHtml, refreshedHtml, keyword);
      console.log('done');

      // Save refreshed HTML + minimal meta for editor
      const outputPath = join(POSTS_DIR, `${slug}-refreshed.html`);
      writeFileSync(outputPath, refreshedHtml);
      const metaPath = join(POSTS_DIR, `${slug}-refreshed.json`);
      writeFileSync(metaPath, JSON.stringify({ title: article.title, target_keyword: keyword }, null, 2));
      console.log(`    Saved: ${outputPath}`);

      // Run editor review before pushing to Shopify
      process.stdout.write('    Running editor review... ');
      try {
        execSync(`node agents/editor/index.js data/posts/${slug}-refreshed.html --auto-fix`, { cwd: ROOT, stdio: 'pipe' });
        console.log(`done → data/reports/editor/${slug}-refreshed-editor-report.md`);
      } catch (editorErr) {
        const msg = editorErr.stderr?.toString().trim().slice(0, 120) ?? editorErr.message;
        console.log(`editor warning (non-fatal): ${msg}`);
      }

      // Re-read from disk in case auto-fix modified the file
      const finalHtml = readFileSync(outputPath, 'utf8');

      let applied = false;
      if (apply) {
        process.stdout.write('    Publishing draft to Shopify... ');
        try {
          await updateArticle(article.blogId, article.id, {
            body_html: finalHtml,
            published: false, // save as draft for review
          });
          applied = true;
          console.log('done');
        } catch (e) {
          console.error(`failed: ${e.message}`);
        }
      }

      results.push({
        slug,
        title: article.title,
        url: article.canonicalUrl,
        keyword,
        position,
        impressions,
        changeSummary,
        outputPath,
        applied,
      });
    } catch (e) {
      console.error(`    ✗ Failed: ${e.message}`);
    }
  }

  // ── Build report ──────────────────────────────────────────────────────────

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# Content Refresh Report — ${config.name}`);
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Mode:** ${apply ? 'Applied (pushed as drafts to Shopify)' : 'Dry run'}`);
  lines.push(`**Posts refreshed:** ${results.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of results) {
    const status = apply ? (r.applied ? '✅ Published as draft' : '⚠️ Save failed') : '💡 Saved locally';
    lines.push(`## ${status} — "${r.title}"`);
    lines.push(`**Keyword:** "${r.keyword}" | **Position:** #${Math.round(r.position)} | **Impressions:** ${r.impressions}/90 days`);
    lines.push(`**URL:** [${r.url}](${r.url})`);
    lines.push(`**Refreshed file:** \`${r.outputPath.replace(ROOT + '/', '')}\``);
    lines.push('');
    lines.push('**Changes made:**');
    lines.push(r.changeSummary);
    lines.push('');
    if (apply && r.applied) {
      lines.push(`> Editor report: \`data/reports/editor/${r.slug}-refreshed-editor-report.md\`  `);
      lines.push('> Review editor report, then publish draft in Shopify when ready.');
    } else if (!apply) {
      lines.push('```bash');
      lines.push(`node agents/content-refresher/index.js --slug ${r.slug} --apply`);
      lines.push('```');
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'content-refresh-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  console.log(`\n  Report saved: ${reportPath}`);
  console.log(`  Posts refreshed: ${results.length}`);
  if (!apply && results.length > 0) {
    console.log(`\n  Next step: review refreshed files in data/posts/*-refreshed.html`);
    console.log(`  Then run with --apply to push to Shopify as drafts`);
  }
}

main()
  .then(() => notifyLatestReport('Content Refresher completed', join(ROOT, 'data', 'reports', 'content-refresher')))
  .catch((err) => {
    notify({ subject: 'Content Refresher failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
