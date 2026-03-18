/**
 * SEO Reporter Agent
 *
 * Aggregates data from available local sources and Ahrefs to produce a
 * periodic SEO performance report covering:
 *   - Content inventory summary (posts published, briefs queued, gaps remaining)
 *   - Keyword ranking snapshot (from Ahrefs organic keywords CSV or API)
 *   - Top performing pages by estimated traffic
 *   - Backlink snapshot (domain rating, referring domains, new/lost)
 *   - Issue status (open technical SEO issues, editor reports with problems)
 *   - Priority actions for next period
 *
 * Data sources used (in priority order):
 *   1. data/posts/*.json        — published post inventory
 *   2. data/briefs/*.json       — queued briefs
 *   3. data/reports/*.md        — existing audit/gap/calendar reports (for summaries)
 *   4. data/blog-index.json     — live Shopify articles
 *   5. Ahrefs API               — domain metrics, organic keywords, top pages
 *
 * Output: data/reports/seo-report-<YYYY-MM>.md
 *
 * Usage:
 *   node agents/seo-reporter/index.js
 *   node agents/seo-reporter/index.js --period 2026-03   # specify month
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { notify, notifyLatestReport } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'seo-reporter');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

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

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const periodIdx = args.indexOf('--period');
const period = periodIdx !== -1 ? args[periodIdx + 1] : new Date().toISOString().slice(0, 7); // YYYY-MM

// ── ahrefs ────────────────────────────────────────────────────────────────────

async function ahrefsGet(endpoint, params) {
  if (!env.AHREFS_API_KEY) return null;
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`https://api.ahrefs.com/v3${endpoint}?${qs}`, {
      headers: { Authorization: `Bearer ${env.AHREFS_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function getDomainMetrics() {
  const data = await ahrefsGet('/site-explorer/metrics', {
    target: config.url,
    mode: 'domain',
    select: 'domain_rating,ahrefs_rank,org_keywords,org_traffic,refdomains,backlinks',
  });
  return data?.metrics || null;
}

async function getTopPages() {
  const data = await ahrefsGet('/site-explorer/top-pages', {
    target: config.url,
    mode: 'domain',
    country: 'us',
    limit: 20,
    select: 'url,title,traffic,keywords,top_keyword,top_keyword_volume',
  });
  return data?.pages || [];
}

async function getOrganicKeywords() {
  const data = await ahrefsGet('/site-explorer/organic-keywords', {
    target: config.url,
    mode: 'domain',
    country: 'us',
    limit: 50,
    order_by: 'traffic:desc',
    select: 'keyword,position,volume,traffic,url',
  });
  return data?.keywords || [];
}

async function getBacklinkStats() {
  const data = await ahrefsGet('/site-explorer/backlinks-stats', {
    target: config.url,
    mode: 'domain',
  });
  return data?.stats || null;
}

// ── local data loaders ────────────────────────────────────────────────────────

function loadPosts() {
  const dir = join(ROOT, 'data', 'posts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0));
}

function loadBriefs() {
  const dir = join(ROOT, 'data', 'briefs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const brief = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        return { slug: basename(f, '.json'), keyword: brief.target_keyword, title: brief.recommended_title };
      } catch { return null; }
    })
    .filter(Boolean);
}

function loadBlogIndex() {
  try {
    const blogs = JSON.parse(readFileSync(join(ROOT, 'data', 'blog-index.json'), 'utf8'));
    return blogs.flatMap((b) => b.articles || []);
  } catch { return []; }
}

function loadReportSummary(subdir, filename) {
  const path = join(ROOT, 'data', 'reports', subdir, filename);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  // Return first 3000 chars (header + executive summary) to stay within token budget
  return content.slice(0, 3000);
}

function loadEditorReports() {
  const editorDir = join(ROOT, 'data', 'reports', 'editor');
  if (!existsSync(editorDir)) return [];
  return readdirSync(editorDir)
    .filter((f) => f.endsWith('-editor-report.md'))
    .map((f) => {
      const content = readFileSync(join(editorDir, f), 'utf8');
      const hasBroken = content.includes('🔴 Broken');
      const hasConcern = content.includes('CONCERNING') || content.includes('NEEDS_REVIEW');
      const slug = f.replace('-editor-report.md', '');
      return { slug, hasBroken, hasConcern, issues: hasBroken || hasConcern };
    })
    .filter((r) => r.issues);
}

// ── report generation ─────────────────────────────────────────────────────────

async function generateReport(data) {
  const {
    period, posts, briefs, liveArticles, metrics, topPages, organicKeywords,
    backlinkStats, gapReportSummary, calendarSummary, editorIssues,
  } = data;

  const publishedPosts = posts.filter((p) => p.shopify_status === 'published' || p.shopify_article_id);
  const scheduledPosts = posts.filter((p) => p.shopify_status === 'scheduled');

  // Build briefing data for Claude
  const context = `
## Report Period: ${period}
## Site: ${config.name} (${config.url})

### Content Inventory
- Live Shopify articles: ${liveArticles.length}
- Posts in local pipeline: ${posts.length} total (${publishedPosts.length} published, ${scheduledPosts.length} scheduled)
- Briefs queued (not yet written): ${briefs.length}
${briefs.slice(0, 8).map((b) => `  - "${b.keyword}"`).join('\n')}

### Recent Posts (last 5)
${posts.slice(0, 5).map((p) => `- "${p.title}" (${p.shopify_status || 'local'}) — ${p.target_keyword}`).join('\n')}

### Scheduled Posts
${scheduledPosts.length > 0 ? scheduledPosts.map((p) => `- "${p.title}" → ${p.shopify_publish_at || 'TBD'}`).join('\n') : 'None'}

### Ahrefs Domain Metrics
${metrics ? `
- Domain Rating: ${metrics.domain_rating}
- Ahrefs Rank: #${metrics.ahrefs_rank}
- Organic Keywords: ${metrics.org_keywords?.toLocaleString()}
- Organic Traffic (est.): ${metrics.org_traffic?.toLocaleString()}/mo
- Referring Domains: ${metrics.refdomains?.toLocaleString()}
- Total Backlinks: ${metrics.backlinks?.toLocaleString()}
` : 'Ahrefs API not available — metrics omitted'}

### Top Pages by Traffic (Ahrefs)
${topPages.length > 0 ? topPages.slice(0, 10).map((p) => `- ${p.title || p.url} — ${p.traffic}/mo (top keyword: "${p.top_keyword}", pos. TBD)`).join('\n') : 'No data'}

### Top Ranking Keywords
${organicKeywords.length > 0 ? organicKeywords.slice(0, 15).map((k) => `- "${k.keyword}" — pos. ${k.position}, ${k.volume}/mo vol, ${k.traffic}/mo traffic`).join('\n') : 'No data'}

### Backlink Stats
${backlinkStats ? `New refdomains (30d): ${backlinkStats.refdomains_new_30d || 'N/A'} | Lost: ${backlinkStats.refdomains_lost_30d || 'N/A'}` : 'Not available'}

### Open Editor Issues (posts with unresolved problems)
${editorIssues.length > 0 ? editorIssues.map((e) => `- ${e.slug}${e.hasBroken ? ' 🔴 broken links' : ''}${e.hasConcern ? ' 🟡 claims to review' : ''}`).join('\n') : 'None'}

### Content Gap Summary (excerpt)
${gapReportSummary ? gapReportSummary.slice(0, 1500) : 'No gap report found'}

### Content Calendar Summary (excerpt)
${calendarSummary ? calendarSummary.slice(0, 1500) : 'No calendar found'}
`;

  const promptMsg = `You are the SEO lead for ${config.name}. Using the data below, write a concise monthly SEO performance report.

${context}

Write a Markdown report with these sections:
1. **Executive Summary** — 3–5 bullet points on the month's highlights and biggest issues
2. **Content Performance** — what's ranking, what's gaining traction, top pages
3. **Content Pipeline Status** — published this period, scheduled, briefs ready to write
4. **Technical Health** — any open editor issues or link problems
5. **Wins This Period** — specific improvements to celebrate
6. **Priority Actions for Next Period** — top 5 concrete next steps, ordered by impact

Be specific. Use the real numbers from the data. If data is unavailable, say so rather than guessing.
Keep the tone direct and analytical — this is an internal performance document.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: promptMsg }],
  });

  return msg.content[0].text;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSEO Reporter — ${config.name}`);
  console.log(`Period: ${period}\n`);

  // Load local data
  process.stdout.write('  Loading local data... ');
  const posts = loadPosts();
  const briefs = loadBriefs();
  const liveArticles = loadBlogIndex();
  const editorIssues = loadEditorReports();
  const gapReportSummary = loadReportSummary('content-gap', 'content-gap-report.md');
  const calendarSummary = loadReportSummary('content-strategist', 'content-calendar.md');
  console.log(`done (${posts.length} posts, ${briefs.length} briefs, ${liveArticles.length} live articles)`);

  // Fetch Ahrefs data
  if (env.AHREFS_API_KEY) {
    process.stdout.write('  Fetching Ahrefs metrics... ');
  } else {
    console.log('  Ahrefs API key not set — skipping API metrics');
  }

  const [metrics, topPages, organicKeywords, backlinkStats] = await Promise.all([
    getDomainMetrics(),
    getTopPages(),
    getOrganicKeywords(),
    getBacklinkStats(),
  ]);

  if (env.AHREFS_API_KEY) {
    console.log(metrics ? 'done' : 'unavailable (check plan/key)');
  }

  // Generate report
  process.stdout.write('\n  Generating report... ');
  const reportContent = await generateReport({
    period, posts, briefs, liveArticles, metrics, topPages, organicKeywords,
    backlinkStats, gapReportSummary, calendarSummary, editorIssues,
  });
  console.log('done');

  // Save
  const header = `# SEO Performance Report — ${config.name}\n**Period:** ${period}\n**Generated:** ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}\n\n---\n\n`;
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, `seo-report-${period}.md`);
  writeFileSync(reportPath, header + reportContent);

  console.log(`\n  Report saved: ${reportPath}`);
}

main()
  .then(() => notifyLatestReport('SEO Reporter completed', join(ROOT, 'data', 'reports', 'seo-reporter')))
  .catch((err) => {
    notify({ subject: 'SEO Reporter failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
