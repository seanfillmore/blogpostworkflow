/**
 * Editor Agent
 *
 * Reviews a generated blog post HTML file and produces a structured report covering:
 *   1. Link validation — checks every <a href> returns a valid HTTP response
 *   2. Source verification — fetches external source URLs and asks Claude whether the
 *      claim made in the post is supported by the source content
 *   3. Topical relevance — Claude reviews the full post for brand voice, ingredient
 *      accuracy, and on-topic focus
 *   4. Topical map alignment — checks the post links to the right cluster pillar pages
 *      and flags any orphaned deodorant posts that should be linked
 *
 * Requires: ANTHROPIC_API_KEY in .env
 *           data/posts/<slug>.html + data/posts/<slug>.json
 *           data/sitemap-index.json, data/blog-index.json, data/topical-map.json
 *
 * Output:  data/reports/<slug>-editor-report.md
 *
 * Usage:
 *   node agents/editor/index.js data/posts/best-natural-deodorant-for-women.html
 *   node agents/editor/index.js data/posts/best-natural-deodorant-for-women.html --auto-fix
 *
 * --auto-fix applies unambiguous corrections directly to the HTML file:
 *   - Removes broken external links (replaces <a> with its text content)
 *   - Corrects stale years to the current year in visible text
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from '../../lib/retry.js';
import { getMetaPath, getEditorReportPath, getPostDir, ensurePostDir, loadUnpublishedPostIndex, ROOT } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config, ingredients;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
} catch (e) {
  console.error(`Failed to load config/site.json: ${e.message}`); process.exit(1);
}
try {
  ingredients = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
} catch (e) {
  console.error(`Failed to load config/ingredients.json: ${e.message}`); process.exit(1);
}

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

  // Editor also enforces the writer's standing rules — recurring patterns
  // auto-detected from editor reports. If the writer is told to avoid X,
  // the editor should verify X was avoided. See docs/signal-manifest.md.
  try {
    const rulesPath = join(ROOT, 'data', 'context', 'writer-standing-rules.md');
    const rules = readFileSync(rulesPath, 'utf8').trim();
    if (rules) combined += (combined ? '\n\n---\n\nWRITER STANDING RULES (enforce these on this post):\n' : '') + rules;
  } catch { /* ignore */ }
  return combined;
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

// ── data loaders ──────────────────────────────────────────────────────────────

function loadSitemap() {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'sitemap-index.json'), 'utf8')); }
  catch { return null; }
}

function loadBlogIndex() {
  try {
    const blogs = JSON.parse(readFileSync(join(ROOT, 'data', 'blog-index.json'), 'utf8'));
    return blogs.flatMap((b) => (b.articles || []).map((a) => ({
      title: a.title,
      url: `${config.url}/blogs/${b.handle}/${a.handle}`,
    })));
  } catch { return []; }
}

function loadTopicalMap() {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'topical-map.json'), 'utf8')); }
  catch { return null; }
}

// ── link extraction ───────────────────────────────────────────────────────────

function extractLinks($) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    const context = $(el).closest('p, li, td, section').text().trim().slice(0, 200);
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    links.push({ href, text, context });
  });
  return links;
}

function categoriseLinks(links) {
  const siteHost = new URL(config.url).hostname;
  const internal = { products: [], collections: [], blog: [], other: [] };
  const external = { sources: [], other: [] };

  for (const link of links) {
    try {
      const url = new URL(link.href);
      if (url.hostname === siteHost || url.hostname === `www.${siteHost}`) {
        if (url.pathname.includes('/products/')) internal.products.push(link);
        else if (url.pathname.includes('/collections/')) internal.collections.push(link);
        else if (url.pathname.includes('/blogs/')) internal.blog.push(link);
        else internal.other.push(link);
      } else {
        // External links in a Sources/References section are source links
        const inSources = link.context.toLowerCase().includes('source') ||
          link.context.toLowerCase().includes('reference') ||
          link.context.toLowerCase().includes('further reading');
        if (inSources) external.sources.push(link);
        else external.other.push(link);
      }
    } catch {
      // Relative URL — treat as internal
      internal.other.push(link);
    }
  }
  return { internal, external };
}

// ── scheduled post index (for cross-referencing "broken" internal links) ──────

/**
 * Build an index of ALL unpublished posts in the system — scheduled, draft,
 * or written — so the link checker can distinguish "link to a future post"
 * from "link to a genuinely broken URL."
 *
 * Returns Map<url, { slug, publish_at, title, status }>.
 *
 * The editor uses this to make smart decisions:
 *   - Linked post scheduled BEFORE parent post → not a blocker (will be live in time)
 *   - Linked post is a draft with no schedule → auto-remove the link (don't block
 *     the parent for a dependency that has no ship date)
 *   - Linked post scheduled AFTER parent → auto-remove the link (would 404 at publish)
 *   - Linked post not in the system at all → real 404, flag as blocker
 */
// loadUnpublishedPostIndex now lives in lib/posts.js so link-repair (and any
// other consumer) can use the same source of truth. See that file for the
// classification rules.

const unpublishedIndex = loadUnpublishedPostIndex();

// ── http link checker ─────────────────────────────────────────────────────────

async function checkUrl(href) {
  try {
    const res = await fetch(href, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Editor-Bot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    // 403/405 = bot-blocked, treat as valid
    const ok = res.ok || res.status === 403 || res.status === 405;
    if (!ok && (res.status === 404 || res.status === 410)) {
      // Check if this is a link to an unpublished post (scheduled, draft, or written).
      // Smart handling per docs/signal-manifest.md:
      //   - Linked post scheduled BEFORE parent → not a blocker (will be live in time)
      //   - Linked post is a draft/unscheduled → auto-removable (no ship date)
      //   - Linked post scheduled AFTER parent → auto-removable (would 404 at publish)
      //   - Not in the system at all → real 404 blocker
      const linked = unpublishedIndex.get(href);
      if (linked) {
        return {
          ok: true,
          status: res.status,
          unpublished: true,
          linked_slug: linked.slug,
          linked_publish_at: linked.publish_at,
          linked_status: linked.status,
          note: linked.publish_at
            ? `Unpublished — scheduled for ${new Date(linked.publish_at).toLocaleDateString()} ("${linked.title}")`
            : `Unpublished draft — no publish date set ("${linked.title}")`,
        };
      }
    }
    return { ok, status: res.status, finalUrl: res.url };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function checkAllLinks(links) {
  const unique = [...new Map(links.map((l) => [l.href, l])).values()];
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (link) => ({ ...link, check: await checkUrl(link.href) }))
    );
    results.push(...batchResults);
  }
  return results;
}

// ── source verification ───────────────────────────────────────────────────────

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Editor-Bot/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header').remove();
    return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
  } catch { return null; }
}

async function verifySource(link, pageText) {
  if (!pageText) return { verdict: 'unreachable', note: 'Could not fetch source page.' };

  const message = await withRetry(
    () => client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `A blog post links to this source with the following context:

ANCHOR TEXT: "${link.text}"
SURROUNDING CONTEXT: "${link.context}"

SOURCE PAGE CONTENT (first 3000 chars):
${pageText}

Does the source page support the claim or context in the blog post?
Reply with one of: SUPPORTED / UNSUPPORTED / UNCLEAR
Then one sentence explaining why.
Format: VERDICT: <word>\nNOTE: <explanation>`,
      }],
    }),
    { label: 'editor:source-verify' }
  );

  const raw = message.content[0].text.trim();
  const verdict = raw.match(/VERDICT:\s*(\w+)/i)?.[1]?.toUpperCase() ?? 'UNCLEAR';
  const note = raw.match(/NOTE:\s*(.+)/i)?.[1]?.trim() ?? raw;
  return { verdict, note };
}

// ── topical map alignment ─────────────────────────────────────────────────────

function findRelevantClusters(postUrl, keyword, topicalMap) {
  if (!topicalMap) return [];
  const kw = keyword.toLowerCase();
  return topicalMap.clusters.filter((c) => {
    const tagMatch = kw.includes(c.tag.replace('_', ' ')) || c.tag.replace('_', ' ').includes(kw.split(' ')[0]);
    const articleMatch = c.articles.some((a) => a.url === postUrl);
    return tagMatch || articleMatch;
  });
}

function getPillarSuggestions(clusters, linkedBlogUrls, postUrl) {
  const suggestions = [];
  for (const cluster of clusters) {
    for (const article of cluster.articles) {
      if (article.url === postUrl) continue; // don't suggest linking to itself
      if (!linkedBlogUrls.has(article.url)) {
        suggestions.push({
          cluster: cluster.tag,
          url: article.url,
          title: article.title,
          isOrphan: article.is_orphan,
          inbound: article.inbound_links,
        });
      }
    }
  }
  return suggestions;
}

// ── internal link validation ──────────────────────────────────────────────────

function validateInternalLinks(categorised, sitemap, blogArticles) {
  const sitemapUrls = new Set((sitemap?.pages || []).map((p) => p.url));
  const blogUrls = new Set(blogArticles.map((a) => a.url));

  const issues = [];

  for (const link of [...categorised.internal.products, ...categorised.internal.collections]) {
    if (!sitemapUrls.has(link.href) && !sitemapUrls.has(link.href.replace(/\/$/, ''))) {
      issues.push({ type: 'internal_not_in_sitemap', link });
    }
  }

  for (const link of categorised.internal.blog) {
    if (!blogUrls.has(link.href) && !blogUrls.has(link.href.replace(/\/$/, ''))) {
      issues.push({ type: 'blog_not_in_index', link });
    }
  }

  return issues;
}

// ── CTA check ─────────────────────────────────────────────────────────────────

function checkCTAs(html, categorised) {
  const siteHost = new URL(config.url).hostname;
  const issues = [];

  // Must have at least one product or collection CTA
  const ctaLinks = [...categorised.internal.products, ...categorised.internal.collections];
  if (ctaLinks.length === 0) {
    issues.push({ type: 'no_product_cta', message: 'No links to any product or collection page found.' });
  }

  // Flag markdown artifacts that indicate broken HTML
  if (/```/.test(html)) {
    issues.push({ type: 'markdown_artifact', message: 'Post contains ``` markdown code fences — HTML was not properly rendered.' });
  }


  return { ctaLinks, issues };
}

// ── html → editorial content (strips tags, preserves structure) ───────────────

function buildEditorialContent(html) {
  const $c = cheerio.load(html);
  $c('style, noscript').remove();
  const schemas = [];
  $c('script[type="application/ld+json"]').each((_, el) => schemas.push($c(el).html().trim()));
  $c('script').remove();

  let body = $c('body').html() || html;
  body = body
    .replace(/<h1[^>]*>/gi, '\n# ').replace(/<\/h1>/gi, '\n')
    .replace(/<h2[^>]*>/gi, '\n## ').replace(/<\/h2>/gi, '\n')
    .replace(/<h3[^>]*>/gi, '\n### ').replace(/<\/h3>/gi, '\n')
    .replace(/<h4[^>]*>/gi, '\n#### ').replace(/<\/h4>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<\/tr>/gi, '\n').replace(/<\/td>/gi, ' | ').replace(/<\/th>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (schemas.length) body += '\n\n[JSON-LD SCHEMAS]\n' + schemas.join('\n---\n');
  return body;
}

// ── deterministic checks (no tokens) ─────────────────────────────────────────

function checkH1InBody($) {
  const count = $('h1').length;
  return count > 0
    ? [`BLOCKER — H1 tag in post body (${count} found; Shopify adds H1 from article title automatically)`]
    : [];
}

function checkYearInHeadings($) {
  const current = new Date().getFullYear();
  const issues = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    for (const [, yr] of $(el).text().matchAll(/\b(20\d{2})\b/g)) {
      if (parseInt(yr) < current) {
        issues.push(`Stale year ${yr} in heading: "${$(el).text().trim()}"`);
      }
    }
  });
  return issues;
}

function extractFaqQAs($) {
  const qas = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html());
      for (const s of (Array.isArray(parsed) ? parsed : [parsed])) {
        if (s['@type'] === 'FAQPage' && Array.isArray(s.mainEntity)) {
          for (const q of s.mainEntity) {
            qas.push({ q: q.name || '', a: q.acceptedAnswer?.text || '' });
          }
        }
      }
    } catch {}
  });
  return qas;
}

// ── claude editorial review ───────────────────────────────────────────────────

async function editorialReview(editorialContent, faqQAs, deterministicIssues, meta, productIngredientsContext, ctaResult, linkHealthSummary) {
  const ctaContext = ctaResult.issues.length > 0
    ? `CTA ISSUES: ${ctaResult.issues.map((i) => i.message).join('; ')}`
    : `CTA links found: ${ctaResult.ctaLinks.map((l) => l.href).join(', ')}`;

  const linkHealthContext = linkHealthSummary
    ? (linkHealthSummary.brokenLinks.length === 0
        ? `LINK HEALTH PRE-CHECK: All ${linkHealthSummary.totalLinks} links in this post have been fetched and verified as returning HTTP 200 OK. This includes external sources, CTA links, and Related Articles. DO NOT flag "sources lack URLs", "CTAs unverified", or "Related Articles unverified" as blockers — these have all been checked at fetch time.`
        : `LINK HEALTH PRE-CHECK: ${linkHealthSummary.okLinks}/${linkHealthSummary.totalLinks} links verified as HTTP 200. ${linkHealthSummary.brokenLinks.length} broken link(s) detected — these must be flagged as blockers:\n${linkHealthSummary.brokenLinks.map((l) => `  - [${l.status}] ${l.href}`).join('\n')}\nDo NOT invent additional URL-verification blockers beyond the broken links listed here.`)
    : '';

  const deterministicNote = deterministicIssues.length > 0
    ? `CODE PRE-CHECKS FOUND ISSUES:\n${deterministicIssues.map((i) => `- ${i}`).join('\n')}`
    : 'CODE PRE-CHECKS PASSED: H1 not in body ✓  No stale years in headings ✓';

  const faqNote = faqQAs.length > 0
    ? `FAQ Q&As (for competitor check):\n${faqQAs.map((qa, i) => `Q${i + 1}: ${qa.q}\nA${i + 1}: ${qa.a}`).join('\n\n')}`
    : 'No FAQ content detected.';

  const fb = loadAgentFeedback('editor');

  const systemPrompt = `You are an editor reviewing blog posts for ${config.name}, a natural skincare brand.

Review each post on these dimensions:

1. TOPICAL RELEVANCE — Tightly focused on target keyword? Off-topic tangents?
2. BRAND VOICE & READABILITY — Conversational and warm, ~8th grade level. Flag clinical/jargon phrases without plain-language follow-up. Flag paragraphs over 4 sentences. Good signals: short sentences, "you/your", plain words.
3. INGREDIENT ACCURACY — Does the post correctly highlight OUR ingredients? Wrong product format description?
4. YEAR ACCURACY — Pre-checked by code (see note below). If stale years were found, report them here; otherwise VERDICT: Pass.
5. FACTUAL CONCERNS — Exaggerated, unsubstantiated, or potentially inaccurate claims?
6. CTA QUALITY — Natural, well-placed CTA to Real Skin Care product/collection? Flag if missing.
7. FORMATTING — Heading hierarchy clean (H2+, no H1 in body)? Orphaned sections? H1 presence pre-checked by code.
8. COMPETITOR NAMES IN FAQ — Using the FAQ Q&As provided, flag any brand names other than Real Skin Care. BLOCKER if found.
9. OVERALL QUALITY — Excellent / Good / Needs Work. Must be "Needs Work" if any BLOCKER exists.

URL VERIFICATION POLICY (critical, overrides any standing feedback):
- Link health has already been verified by a pre-check that fetches every URL in the post (external sources, CTAs, Related Articles, internal links). The results are provided in the LINK HEALTH PRE-CHECK section below.
- If LINK HEALTH PRE-CHECK says all links are verified, you MUST NOT flag blockers like "sources lack URLs", "CTA URLs unverified", or "Related Articles unverified". Those concerns have already been resolved at fetch time.
- The ONLY URL-related blockers you may raise are ones listed in the LINK HEALTH PRE-CHECK's broken link list.
- Verifying the presence of an href attribute in the HTML is not your job — trust the pre-check.

Format each section as:
## [Dimension]
VERDICT: [word/phrase]
NOTES: [2-4 sentences]${fb ? `\n\nSTANDING FEEDBACK — apply in addition to above:\n${fb}` : ''}`;

  const message = await withRetry(
    () => client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `POST TITLE: ${meta?.title ?? 'Unknown'}
TARGET KEYWORD: ${meta?.target_keyword ?? 'Unknown'}
PRODUCT INGREDIENTS: ${productIngredientsContext}
${ctaContext}

${linkHealthContext}

${deterministicNote}

${faqNote}

POST CONTENT:
${editorialContent}`,
      }],
    }),
    { label: 'editor:review' }
  );

  return message.content[0].text.trim();
}

// ── report builder ────────────────────────────────────────────────────────────

function buildReport({ slug, meta, linkResults, internalIssues, sourceVerifications,
  topicalSuggestions, editorialReview, linkedBlogUrls, ctaResult }) {

  const lines = [];
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  lines.push(`# Editor Report — ${meta?.title ?? slug}`);
  lines.push(`**Post:** data/posts/${slug}/content.html`);
  lines.push(`**Target keyword:** ${meta?.target_keyword ?? '—'}`);
  lines.push(`**Reviewed:** ${now}\n`);

  // ── 1. Link health ────────────────────────────────────────────────────────
  lines.push('---\n## 1. Link Health\n');
  const broken = linkResults.filter((r) => !r.check.ok);
  const unpublishedLinks = linkResults.filter((r) => r.check.ok && r.check.unpublished);
  const ok = linkResults.filter((r) => r.check.ok);
  lines.push(`**${ok.length} links OK** | **${broken.length} broken/unreachable**\n`);

  // Smart internal-link handling: links to unpublished posts aren't real 404s.
  // Compare their publish dates to the parent post's publish date.
  const parentPublishAt = meta?.shopify_publish_at ? new Date(meta.shopify_publish_at) : null;
  if (unpublishedLinks.length > 0) {
    const willBeLive = [];
    const noSchedule = [];
    const afterParent = [];
    for (const r of unpublishedLinks) {
      if (!r.check.linked_publish_at) {
        noSchedule.push(r);
      } else {
        const linkedDate = new Date(r.check.linked_publish_at);
        if (parentPublishAt && linkedDate <= parentPublishAt) {
          willBeLive.push(r);
        } else {
          afterParent.push(r);
        }
      }
    }
    if (willBeLive.length > 0) {
      lines.push(`> **Note:** ${willBeLive.length} link(s) point to posts scheduled to publish before this article — not a blocker:\n`);
      for (const r of willBeLive) lines.push(`> - ${r.text} — ${r.check.note}`);
      lines.push('');
    }
    if (noSchedule.length > 0) {
      lines.push(`> **Auto-removed:** ${noSchedule.length} link(s) to unscheduled draft posts were removed from the HTML (no publish date set — the internal-linker will re-add them once both posts are live):\n`);
      for (const r of noSchedule) lines.push(`> - ${r.text} — ${r.check.note}`);
      lines.push('');
    }
    if (afterParent.length > 0) {
      lines.push(`> **Auto-removed:** ${afterParent.length} link(s) to posts scheduled AFTER this one were removed (would 404 at publish time):\n`);
      for (const r of afterParent) lines.push(`> - ${r.text} — ${r.check.note}`);
      lines.push('');
    }
  }

  if (broken.length === 0) {
    lines.push('All links returned a valid HTTP response.\n');
  } else {
    lines.push('| URL | Anchor Text | Status | Error |');
    lines.push('|-----|-------------|--------|-------|');
    for (const r of broken) {
      lines.push(`| ${r.href} | ${r.text} | ${r.check.status ?? 'timeout'} | ${r.check.error ?? ''} |`);
    }
    lines.push('');
  }

  // ── 2. Internal link validation ───────────────────────────────────────────
  lines.push('---\n## 2. Internal Link Validation\n');
  if (internalIssues.length === 0) {
    lines.push('All internal product, collection, and blog links match the sitemap/blog index.\n');
  } else {
    lines.push('The following internal links could not be verified against the sitemap or blog index:\n');
    for (const issue of internalIssues) {
      const label = issue.type === 'blog_not_in_index' ? 'Blog URL not in blog index' : 'URL not in sitemap';
      lines.push(`- **${label}:** \`${issue.link.href}\` (anchor: "${issue.link.text}")`);
    }
    lines.push('');
  }

  // ── 2b. CTA and formatting ────────────────────────────────────────────────
  lines.push('---\n## 2b. CTA & Formatting Check\n');
  if (ctaResult?.issues.length === 0) {
    const ctaList = ctaResult.ctaLinks.map((l) => `[${l.text || l.href}](${l.href})`).join(', ');
    lines.push(`**Pass** — Product/collection CTA links found: ${ctaList || '(none listed)'}\n`);
  } else {
    lines.push('**Issues detected:**\n');
    for (const issue of ctaResult?.issues ?? []) {
      lines.push(`- ⚠️ ${issue.message}`);
    }
    lines.push('');
  }

  // ── 3. Source verification ────────────────────────────────────────────────
  lines.push('---\n## 3. Source Verification\n');
  if (sourceVerifications.length === 0) {
    lines.push('No external source links found in the post.\n');
  } else {
    lines.push('| Verdict | Source URL | Note |');
    lines.push('|---------|-----------|------|');
    for (const sv of sourceVerifications) {
      const icon = sv.verdict === 'SUPPORTED' ? 'PASS' : sv.verdict === 'UNREACHABLE' ? 'SKIP' : 'REVIEW';
      lines.push(`| ${icon} | [${sv.link.text || sv.link.href}](${sv.link.href}) | ${sv.note} |`);
    }
    lines.push('');
  }

  // ── 4. Topical map alignment ──────────────────────────────────────────────
  lines.push('---\n## 4. Topical Map Alignment\n');
  if (topicalSuggestions.length === 0) {
    lines.push('No additional cluster articles identified for cross-linking at this time.\n');
  } else {
    lines.push('The following posts are in the same topical cluster and should be linked from this post (or vice versa) as the cluster grows:\n');
    for (const s of topicalSuggestions) {
      const orphanNote = s.isOrphan ? ' *(orphan — no inbound links yet)*' : ` *(${s.inbound} inbound links)*`;
      lines.push(`- **[${s.title}](${s.url})**${orphanNote}`);
    }
    lines.push('\n> Note: As new deodorant posts are published, revisit this post to add cross-links to the growing cluster.\n');
  }

  // ── 5. Editorial review ───────────────────────────────────────────────────
  lines.push('---\n## 5. Editorial Review\n');
  lines.push(editorialReview);
  lines.push('');

  return lines.join('\n');
}

// ── auto-fix ──────────────────────────────────────────────────────────────────

/**
 * Apply unambiguous fixes directly to the HTML file:
 *   1. Remove broken external links (keep anchor text, strip <a> wrapper)
 *   2. Correct stale years in visible text (any 4-digit year < current year)
 *
 * Creates a timestamped backup before writing.
 */
function applyAutoFixes(htmlPath, html, brokenLinks, { linksToRemove = [] } = {}) {
  const currentYear = new Date().getFullYear();
  let fixed = html;
  const changes = [];

  // 0. Remove internal links to unpublished posts that would 404 at publish time.
  //    These are links to drafts with no schedule, or links to posts scheduled
  //    after the parent. The internal-linker will re-add them once both are live.
  for (const link of linksToRemove) {
    const escapedHref = link.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Try to remove the entire <li> if inside a list (common in related-articles)
    const liRegex = new RegExp(`\\s*<li[^>]*>\\s*<a[^>]+href=["']${escapedHref}["'][^>]*>[\\s\\S]*?<\\/a>\\s*<\\/li>`, 'gi');
    const before = fixed;
    fixed = fixed.replace(liRegex, '');
    if (fixed !== before) {
      changes.push(`Auto-removed link to unpublished post: ${link.href} ("${link.text}")`);
      continue;
    }
    // Fallback: just strip the <a> wrapper, keep the text
    const aRegex = new RegExp(`<a[^>]+href=["']${escapedHref}["'][^>]*>(.*?)<\\/a>`, 'gis');
    fixed = fixed.replace(aRegex, '$1');
    if (fixed !== before) {
      changes.push(`Auto-removed link to unpublished post: ${link.href} (kept text: "${link.text}")`);
    }
  }

  // 1. Remove broken external links
  const siteHost = new URL(config.url).hostname;
  for (const link of brokenLinks) {
    try {
      const urlHost = new URL(link.href).hostname;
      const isInternal = urlHost === siteHost || urlHost === `www.${siteHost}`;
      if (isInternal) continue; // Don't strip internal links — may just be temporarily down
    } catch { continue; }

    // Escape for regex
    const escapedHref = link.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkRegex = new RegExp(`<a[^>]+href=["']${escapedHref}["'][^>]*>(.*?)<\\/a>`, 'gis');
    const before = fixed;
    fixed = fixed.replace(linkRegex, '$1');
    if (fixed !== before) {
      changes.push(`Removed broken link: ${link.href} (kept text: "${link.text}")`);
    }
  }

  // 2. Fix stale years in visible text (not inside href/src attributes)
  // Replace year strings like "in 2023" or "2024" in text nodes only
  for (let year = 2020; year < currentYear; year++) {
    // Match year in text context: preceded/followed by space, punctuation, or common words
    const yearRegex = new RegExp(`\\b(in |updated |\\()${year}\\b`, 'gi');
    const before = fixed;
    fixed = fixed.replace(yearRegex, (match, prefix) => `${prefix}${currentYear}`);
    if (fixed !== before) {
      changes.push(`Corrected year: ${year} → ${currentYear}`);
    }
  }

  if (changes.length === 0) {
    console.log('  Auto-fix: no changes needed.');
    return;
  }

  // Backup original
  const backupPath = htmlPath.replace('.html', `.backup-${Date.now()}.html`);
  copyFileSync(htmlPath, backupPath);
  writeFileSync(htmlPath, fixed, 'utf8');

  console.log(`\n  Auto-fix applied ${changes.length} change(s) (backup: ${basename(backupPath)}):`);
  changes.forEach((c) => console.log(`    • ${c}`));
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

async function runEditor(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  // New layout: data/posts/{slug}/content.html — extract slug from directory name
  const slug = basename(dirname(htmlPath));
  const metaPath = getMetaPath(slug);
  let meta = null;
  if (existsSync(metaPath)) {
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); }
    catch (e) { console.warn(`  Warning: could not parse metadata ${metaPath}: ${e.message}`); }
  }
  const keyword = meta?.target_keyword ?? slug.replace(/-/g, ' ');

  console.log(`\n  Post: "${meta?.title ?? slug}"`);
  console.log(`  Keyword: ${keyword}\n`);

  // Detect product type for ingredient context
  const kw = keyword.toLowerCase();
  let productIngredients = null;
  function flattenProduct(p) {
    if (!p) return null;
    const base = p.base_ingredients || p.ingredients || [];
    const oils = (p.variations || []).flatMap((v) => v.essential_oils || []);
    return { name: p.name, format: p.format, ingredients: [...new Set([...base, ...oils])] };
  }
  if (kw.includes('deodorant')) productIngredients = flattenProduct(ingredients.deodorant);
  else if (kw.includes('toothpaste') || kw.includes('oral')) productIngredients = flattenProduct(ingredients.toothpaste);
  else if (kw.includes('lotion') || kw.includes('moisturizer')) productIngredients = flattenProduct(ingredients.lotion);
  else if (kw.includes('cream')) productIngredients = flattenProduct(ingredients.cream);
  else if (kw.includes('soap')) productIngredients = flattenProduct(ingredients.bar_soap);
  else if (kw.includes('lip')) productIngredients = flattenProduct(ingredients.lip_balm);
  else productIngredients = { name: 'our products', ingredients: [...new Set(Object.values(ingredients).flatMap((p) => { const f = flattenProduct(p); return f?.ingredients || []; }))] };

  const formatNote = productIngredients.format ? ` | Product format: ${productIngredients.format}` : '';
  const productIngredientsContext = `${productIngredients.name}: ${productIngredients.ingredients.join(', ')}${formatNote}`;

  // Load context data
  const sitemap = loadSitemap();
  const blogArticles = loadBlogIndex();
  const topicalMap = loadTopicalMap();

  // Parse HTML
  const $ = cheerio.load(html);
  const allLinks = extractLinks($);
  const categorised = categoriseLinks(allLinks);

  // Build post URL (approximate — for topical map matching)
  const postUrl = `${config.url}/blogs/news/${slug}`;
  const linkedBlogUrls = new Set(categorised.internal.blog.map((l) => l.href));

  // 1. HTTP check all links
  process.stdout.write('  Checking all links... ');
  const allLinksFlat = [
    ...categorised.internal.products,
    ...categorised.internal.collections,
    ...categorised.internal.blog,
    ...categorised.external.sources,
    ...categorised.external.other,
  ];
  const linkResults = await checkAllLinks(allLinksFlat);
  console.log(`${linkResults.length} checked (${linkResults.filter((r) => !r.check.ok).length} broken)`);

  // 2. Internal validation
  process.stdout.write('  Validating internal links... ');
  const internalIssues = validateInternalLinks(categorised, sitemap, blogArticles);
  console.log(`${internalIssues.length} issues`);

  // 2b. CTA and formatting check
  const ctaResult = checkCTAs(html, categorised);
  if (ctaResult.issues.length > 0) {
    console.log(`  CTA/formatting issues: ${ctaResult.issues.map((i) => i.message).join('; ')}`);
  }

  // 3. Source verification (live sources only)
  const liveSourceLinks = linkResults.filter((r) =>
    categorised.external.sources.some((s) => s.href === r.href) && r.check.ok
  );
  process.stdout.write(`  Verifying ${liveSourceLinks.length} source(s)... `);
  const sourceVerifications = [];
  for (const link of liveSourceLinks) {
    const pageText = await fetchPageText(link.href);
    const result = await verifySource(link, pageText);
    sourceVerifications.push({ link, ...result });
    process.stdout.write('.');
  }
  // Add unreachable sources
  for (const r of linkResults.filter((r) =>
    categorised.external.sources.some((s) => s.href === r.href) && !r.check.ok
  )) {
    sourceVerifications.push({ link: r, verdict: 'UNREACHABLE', note: `HTTP ${r.check.status ?? 'timeout'}` });
  }
  console.log(' done');

  // 4. Topical map alignment
  process.stdout.write('  Checking topical map alignment... ');
  const relevantClusters = findRelevantClusters(postUrl, keyword, topicalMap);
  const topicalSuggestions = getPillarSuggestions(relevantClusters, linkedBlogUrls, postUrl);
  console.log(`${relevantClusters.length} cluster(s), ${topicalSuggestions.length} link suggestion(s)`);

  // 5. Deterministic checks (no tokens)
  const deterministicIssues = [...checkH1InBody($), ...checkYearInHeadings($)];
  if (deterministicIssues.length > 0) {
    console.log(`  Deterministic issues: ${deterministicIssues.join('; ')}`);
  }

  // 6. Extract FAQ Q&As for competitor check
  const faqQAs = extractFaqQAs($);

  // 7. Build compressed editorial content (strips HTML tags)
  const editorialContent = buildEditorialContent(html);

  // 8. Editorial review
  process.stdout.write('  Running editorial review... ');
  const linkHealthSummary = {
    totalLinks: linkResults.length,
    okLinks: linkResults.filter((r) => r.check.ok).length,
    brokenLinks: linkResults.filter((r) => !r.check.ok).map((r) => ({ href: r.href, status: r.check.status })),
  };
  const review = await editorialReview(editorialContent, faqQAs, deterministicIssues, meta, productIngredientsContext, ctaResult, linkHealthSummary);
  console.log('done');

  // Build and save report
  const report = buildReport({
    slug, meta, linkResults, internalIssues,
    sourceVerifications, topicalSuggestions,
    editorialReview: review, linkedBlogUrls, ctaResult,
  });

  ensurePostDir(slug);
  const reportPath = getEditorReportPath(slug);
  writeFileSync(reportPath, report);

  console.log(`\n  Report saved: ${reportPath}`);

  // Print summary
  const brokenLinks = linkResults.filter((r) => !r.check.ok);
  const needsReview = sourceVerifications.filter((s) => s.verdict !== 'SUPPORTED' && s.verdict !== 'UNREACHABLE').length;
  console.log(`\n  Summary:`);
  console.log(`    Broken links:       ${brokenLinks.length}`);
  console.log(`    Internal issues:    ${internalIssues.length}`);
  console.log(`    CTA/format issues:  ${ctaResult.issues.length}`);
  console.log(`    Deterministic:      ${deterministicIssues.length} issue(s)`);
  console.log(`    Sources to review:  ${needsReview}`);
  console.log(`    Topical suggestions:${topicalSuggestions.length}`);

  // Determine which unpublished-post links need auto-removal
  const parentPublishDate = meta?.shopify_publish_at ? new Date(meta.shopify_publish_at) : null;
  const linksToRemove = linkResults
    .filter(r => r.check.ok && r.check.unpublished)
    .filter(r => {
      // Remove if: no publish date at all, or scheduled after the parent
      if (!r.check.linked_publish_at) return true;
      if (parentPublishDate && new Date(r.check.linked_publish_at) > parentPublishDate) return true;
      return false;
    });

  // Always auto-fix unpublished-link removals (they're unambiguous).
  // Other auto-fixes (broken externals, year corrections) still require --auto-fix.
  if (linksToRemove.length > 0 || args.includes('--auto-fix')) {
    applyAutoFixes(htmlPath, html, args.includes('--auto-fix') ? brokenLinks : [], { linksToRemove });
  }
}

async function main() {
  console.log(`\nEditor Agent — ${config.name}\n`);

  if (!args[0] || args[0].startsWith('--')) {
    console.error('Usage: node agents/editor/index.js data/posts/<slug>.html [--auto-fix]');
    process.exit(1);
  }

  const htmlPath = args[0].startsWith('/') ? args[0] : join(ROOT, args[0]);
  if (!existsSync(htmlPath)) {
    console.error(`File not found: ${htmlPath}`);
    process.exit(1);
  }

  await runEditor(htmlPath);
  console.log('\nEditor review complete.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
