/**
 * Content Strategist Agent
 *
 * Reads the content gap report and existing inventory, then:
 *   1. Produces a prioritized content calendar (data/reports/content-calendar.md)
 *   2. Optionally generates briefs by calling the content-researcher agent for each gap
 *
 * Usage:
 *   node agents/content-strategist/index.js                   # plan only
 *   node agents/content-strategist/index.js --generate-briefs # plan + generate briefs
 *   node agents/content-strategist/index.js --generate-briefs --limit 3  # top N only
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { writeCalendar } from '../../lib/calendar-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'content-strategist');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');
const POSTS_DIR = join(ROOT, 'data', 'posts');

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
const generateBriefs = args.includes('--generate-briefs');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

// ── helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadLatestRankReport() {
  const path = join(ROOT, 'data', 'reports', 'rank-tracker', 'rank-tracker-report.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').slice(0, 3000);
}

/**
 * Load latest rank snapshot + post tags and compute per-cluster performance.
 *
 * A "cluster" is derived from a post's first tag (falls back to the first
 * slug token). For each cluster we record median position, count of page-1
 * posts, count of drag posts (position > 30 and age > 30d), and any
 * outstanding flops surfaced by the post-performance agent.
 *
 * Weighting rules used by the strategist:
 *   - page_1 cluster (≥1 post at positions 1–10 AND no outstanding flops):
 *     +2 priority weight — reinforce with adjacent topics.
 *   - drag cluster (median position > 30 AND median age > 30 days):
 *     −3 priority weight — deprioritize new topics here.
 *
 * Returns { computed_at, clusters: { <name>: { weight, page_1, drag, ... } } }
 * or null if no rank snapshot is available.
 */
export function loadClusterPerformance() {
  const snapshotsDir = join(ROOT, 'data', 'rank-snapshots');
  if (!existsSync(snapshotsDir)) return null;
  const files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  const snap = JSON.parse(readFileSync(join(snapshotsDir, files[files.length - 1]), 'utf8'));
  const posts = snap.posts || [];

  // Map slug -> tags from data/posts/*.json
  const tagsBySlug = {};
  if (existsSync(POSTS_DIR)) {
    for (const f of readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
        if (meta.slug) tagsBySlug[meta.slug] = meta.tags || [];
      } catch { /* skip */ }
    }
  }

  // Outstanding flops by slug from post-performance latest.json
  const flopSlugs = new Set();
  const ppPath = join(ROOT, 'data', 'reports', 'post-performance', 'latest.json');
  if (existsSync(ppPath)) {
    try {
      const pp = JSON.parse(readFileSync(ppPath, 'utf8'));
      for (const f of (pp.action_required || [])) flopSlugs.add(f.slug);
    } catch { /* ignore */ }
  }

  // Known product clusters — checked against tags AND slug as a fallback so
  // posts without proper tags still group correctly.
  const KNOWN_CLUSTERS = [
    'deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm', 'lip-balm',
    'coconut oil', 'coconut-oil', 'shampoo', 'conditioner', 'sunscreen',
  ];
  function clusterFor(post) {
    const tags = (tagsBySlug[post.slug] || []).map((t) => t.toLowerCase());
    for (const c of KNOWN_CLUSTERS) {
      if (tags.some((t) => t.includes(c.replace('-', ' ')))) return c.replace('-', ' ');
    }
    const slug = (post.slug || '').toLowerCase();
    for (const c of KNOWN_CLUSTERS) {
      if (slug.includes(c.replace(' ', '-'))) return c.replace('-', ' ');
    }
    if (tags.length) return tags[0];
    return slug.split('-')[0];
  }

  const groups = {};
  const now = Date.now();
  for (const p of posts) {
    if (!p.position) continue;
    const cluster = clusterFor(p);
    if (!cluster) continue;
    const ageDays = p.published_at ? Math.floor((now - new Date(p.published_at).getTime()) / 86400000) : null;
    (groups[cluster] = groups[cluster] || []).push({ ...p, age_days: ageDays });
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const clusters = {};
  for (const [name, items] of Object.entries(groups)) {
    const positions = items.map((i) => i.position);
    const ages = items.map((i) => i.age_days).filter((a) => a != null);
    const medianPos = median(positions);
    const medianAge = median(ages);
    const page1Count = items.filter((i) => i.position <= 10).length;
    const dragCount = items.filter((i) => i.position > 30 && (i.age_days || 0) > 30).length;
    const hasFlop = items.some((i) => flopSlugs.has(i.slug));

    let weight = 0;
    const reasons = [];
    if (page1Count >= 1 && !hasFlop) {
      weight += 2;
      reasons.push(`+2 page-1 cluster (${page1Count} post${page1Count > 1 ? 's' : ''} on page 1)`);
    }
    if (medianPos != null && medianPos > 30 && medianAge != null && medianAge > 30) {
      weight -= 3;
      reasons.push(`-3 drag cluster (median pos ${medianPos}, median age ${medianAge}d)`);
    }
    if (hasFlop) reasons.push(`flop present — page-1 boost suppressed`);

    clusters[name] = {
      post_count: items.length,
      median_position: medianPos,
      median_age_days: medianAge,
      page_1_count: page1Count,
      drag_count: dragCount,
      has_outstanding_flop: hasFlop,
      weight,
      reasons,
    };
  }

  return { computed_at: new Date().toISOString(), snapshot_file: files[files.length - 1], clusters };
}

function buildClusterWeightSection(clusterPerf) {
  if (!clusterPerf) return '';
  const entries = Object.entries(clusterPerf.clusters)
    .filter(([, c]) => c.weight !== 0)
    .sort((a, b) => b[1].weight - a[1].weight);
  if (!entries.length) return '';
  const lines = entries.map(([name, c]) => `- **${name}** (weight ${c.weight > 0 ? '+' : ''}${c.weight}): ${c.reasons.join('; ')}`);
  return `\n## Cluster Authority Weights\nApply these to your prioritization. Add the weight to the base priority score for any topic in that cluster:\n${lines.join('\n')}\n\nScoring rules:\n- Topics in **page-1 clusters** (+2): prefer these — reinforcing existing winners is higher ROI than breaking into new ones.\n- Topics in **drag clusters** (−3): deprioritize new topics here unless strategically essential. The cluster has not earned authority despite age.\n`;
}

export function loadRejections() {
  const path = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

export function isRejected(keyword, rejections) {
  const kw = keyword.toLowerCase().trim();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase().trim();
    if (r.matchType === 'exact') return kw === term;
    return kw.includes(term);
  });
}

export function buildRejectionSection(rejections) {
  if (!rejections.length) return '';
  const lines = rejections.map(r => {
    const note = r.reason ? ` — ${r.reason}` : '';
    if (r.matchType === 'broad') {
      return `- "${r.keyword}" (broad match) — avoid this topic and closely related ideas${note}`;
    }
    if (r.matchType === 'phrase') {
      return `- "${r.keyword}" (phrase match) — do not include keywords containing this phrase${note}`;
    }
    return `- "${r.keyword}" (exact match) — do not schedule this exact keyword${note}`;
  });
  return `\n## Rejected Keywords\nDo not schedule or suggest content related to these topics:\n${lines.join('\n')}\n`;
}

function loadInventory() {
  const existing = new Set();

  // Existing briefs
  if (existsSync(BRIEFS_DIR)) {
    readdirSync(BRIEFS_DIR)
      .filter((f) => f.endsWith('.json'))
      .forEach((f) => existing.add(basename(f, '.json')));
  }

  // Published posts (local HTML/JSON files)
  if (existsSync(POSTS_DIR)) {
    readdirSync(POSTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .forEach((f) => {
        const slug = basename(f, '.json');
        existing.add(slug);
        // Also try to extract target_keyword for broader matching
        try {
          const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
          if (meta.target_keyword) existing.add(slugify(meta.target_keyword));
        } catch {}
      });
  }

  // Published registry (written by scheduler after successful pipeline runs)
  const publishedPath = join(ROOT, 'data', 'published.json');
  if (existsSync(publishedPath)) {
    try {
      const published = JSON.parse(readFileSync(publishedPath, 'utf8'));
      for (const entry of published) {
        if (entry.slug) existing.add(entry.slug);
        if (entry.keyword) existing.add(slugify(entry.keyword));
      }
    } catch {}
  }

  return existing;
}

// ── schedule extraction ───────────────────────────────────────────────────────

/**
 * Extract structured calendar items from the markdown Publishing Schedule table.
 * Expects the table with columns: Week | Publish Date | Category | Target Keyword | Suggested Title | KD | Volume | Content Type | Priority
 */
function extractScheduleItems(markdown) {
  const items = [];
  const tableRegex = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;

  for (const match of markdown.matchAll(tableRegex)) {
    const [, week, dateStr, category, keyword, title, kd, volume, contentType, priority] = match;
    if (week.trim() === 'Week' || week.trim() === '---') continue;
    const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
    if (!dm) continue;
    const publishDate = new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 08:00:00 GMT-0700`);
    const slug = slugify(keyword.trim());
    items.push({
      slug,
      keyword: keyword.trim(),
      title: title.trim(),
      category: category.trim(),
      content_type: contentType.trim(),
      priority: priority.trim(),
      week: parseInt(week.trim(), 10),
      publish_date: publishDate.toISOString(),
      kd: parseInt(kd.trim(), 10) || 0,
      volume: parseInt(volume.trim().replace(/,/g, ''), 10) || 0,
      source: 'gap_report',
    });
  }

  return items;
}

/**
 * Extract the non-table sections (Topical Clusters, Brief Queue, etc.) from
 * Claude's markdown output so the rendered calendar preserves them.
 */
function extractNonScheduleSections(markdown) {
  // Strip the Publishing Schedule section (header + table) and return the rest
  const parts = markdown.split(/^##\s+/m);
  const kept = parts.filter((p) => !/^Publishing Schedule/i.test(p.trim()));
  return kept.map((p, i) => (i === 0 ? p : '## ' + p)).join('').trim();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nContent Strategist Agent — ${config.name}\n`);

  // Load gap report
  const gapReportPath = join(ROOT, 'data', 'reports', 'content-gap', 'content-gap-report.md');
  if (!existsSync(gapReportPath)) {
    console.error(`Content gap report not found: ${gapReportPath}`);
    console.error('Run the content-gap agent first: node agents/content-gap/index.js');
    process.exit(1);
  }

  const gapReport = readFileSync(gapReportPath, 'utf8');
  const inventory = loadInventory();
  const rankReport = loadLatestRankReport();
  const clusterPerf = loadClusterPerformance();

  // Load latest GSC opportunity report (unmapped queries are net-new topic candidates)
  let gscOpps = null;
  const gscOppPath = join(ROOT, 'data', 'reports', 'gsc-opportunity', 'latest.json');
  if (existsSync(gscOppPath)) {
    try { gscOpps = JSON.parse(readFileSync(gscOppPath, 'utf8')); } catch { /* ignore */ }
  }

  // Load latest competitor activity (cluster boosts when competitors recently published)
  let competitorSignals = null;
  const compPath = join(ROOT, 'data', 'reports', 'competitor-watcher', 'latest.json');
  if (existsSync(compPath)) {
    try { competitorSignals = JSON.parse(readFileSync(compPath, 'utf8')); } catch { /* ignore */ }
  }

  // Persist computed cluster weights for dashboard / inspection
  if (clusterPerf) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(join(REPORTS_DIR, 'cluster-weights.json'), JSON.stringify(clusterPerf, null, 2));
    const weighted = Object.values(clusterPerf.clusters).filter((c) => c.weight !== 0).length;
    console.log(`  Cluster weights: ${Object.keys(clusterPerf.clusters).length} clusters, ${weighted} weighted`);
  }

  console.log(`  Gap report: ${gapReportPath}`);
  console.log(`  Existing content: ${inventory.size} slugs found (briefs + posts)`);
  if (generateBriefs) {
    console.log(`  Mode: plan + generate briefs${limit ? ` (top ${limit})` : ''}`);
  } else {
    console.log('  Mode: plan only (use --generate-briefs to auto-generate briefs)');
  }

  // ── Step 1: Generate content calendar ────────────────────────────────────────

  process.stdout.write('\n  Generating content calendar... ');

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const rejections = loadRejections();

  const calendarPrompt = `You are a senior SEO content strategist for Real Skin Care (realskincare.com), a clean beauty ecommerce brand selling natural skincare products on Shopify.

TODAY'S DATE: ${todayStr}
SITE: ${config.url || 'https://www.realskincare.com'}

You have been given a content gap analysis report. Your job is to produce a detailed, prioritized content calendar that:
1. Targets the highest-impact gaps first (volume × low KD × category importance)
2. Groups related content into topical clusters to build category authority
3. Balances publishing cadence (realistic for a small team — roughly 2–3 posts/week)
4. Considers the buyer journey — ensure each category has TOF, MOF, and BOF coverage over time
5. Specifies the exact keyword, suggested title, content type, and target publish week for each piece

EXISTING CONTENT (already published or briefed — DO NOT include these):
${[...inventory].sort().join('\n')}

${buildClusterWeightSection(clusterPerf)}
${competitorSignals && Object.keys(competitorSignals.cluster_boosts || {}).length ? `\n## Competitor Activity Signals\nCompetitors have recently published in the following clusters. Treat these as a +1 priority boost — keep our cluster fresh and reinforce authority before the competitor post gains traction.\n${Object.entries(competitorSignals.cluster_boosts).map(([cl, n]) => `- **${cl}** — ${n} new competitor post${n > 1 ? 's' : ''}`).join('\n')}\n` : ''}
${gscOpps && (gscOpps.unmapped?.length || gscOpps.low_ctr?.length) ? `\n## GSC Opportunity Signals\nUse these to inform new-topic and rewrite priorities.\n\n**Unmapped high-impression queries (no current page targets these — strong new-topic candidates):**\n${(gscOpps.unmapped || []).slice(0, 15).map((r) => `- "${r.keyword}" — ${r.impressions} impressions, position ${r.position.toFixed(1)}`).join('\n')}\n\n**Low-CTR queries (existing pages need title/meta rewrites — do not schedule as new posts):**\n${(gscOpps.low_ctr || []).slice(0, 10).map((r) => `- "${r.keyword}" — ${r.impressions} impressions, ${(r.ctr * 100).toFixed(1)}% CTR`).join('\n')}\n` : ''}
${rankReport ? `RANK PERFORMANCE DATA (from latest rank tracker snapshot):
Use this to inform cluster prioritization — double down on clusters with page-1 posts, prioritize quick wins for internal link boosts, and deprioritize clusters with no rankings yet unless high strategic value.
${rankReport}

` : ''}CONTENT GAP REPORT:
${gapReport}
${buildRejectionSection(rejections)}
OUTPUT REQUIREMENTS:
Produce a Markdown content calendar with the following sections:

## Content Calendar — Real Skin Care
[intro paragraph with strategic rationale]

## Publishing Schedule
A table with columns: | Week | Publish Date | Category | Target Keyword | Suggested Title | KD | Volume | Content Type | Priority |
- Plan 8 weeks of content from today
- Start with quick wins and highest-priority items
- Group related topics in adjacent weeks to build cluster authority

## Topical Clusters
For each major category (Toothpaste, Lip Balm, Bar Soap, Body Lotion, Deodorant, Coconut Oil):
- List the planned pieces in recommended order
- Note which piece is the "pillar" vs supporting articles

## Brief Queue
A numbered list of keywords to brief next, in priority order. For each:
- **Keyword:** [target keyword]
- **Suggested Title:** [title]
- **Category:** [category]
- **Rationale:** [1–2 sentences on why this is next]

Format the Brief Queue items so they can be fed directly into the content-researcher agent.
The content-researcher agent is called with: node agents/content-researcher/index.js "<keyword>"

Be specific with dates. Use realistic weekly batches of 2–3 posts.`;

  const calendarResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: calendarPrompt }],
  });

  const calendarMd = calendarResponse.content[0].text;
  console.log('done');

  // ── Step 2: Extract brief queue ───────────────────────────────────────────────

  process.stdout.write('  Extracting brief queue... ');

  const extractPrompt = `From this content calendar, extract the "Brief Queue" section and return ONLY a JSON array of objects, one per item. Each object should have:
{
  "keyword": "the exact target keyword",
  "title": "the suggested title",
  "category": "the category",
  "slug": "url-friendly slug of the keyword"
}

Return only valid JSON, no explanation, no markdown fences.

CONTENT CALENDAR:
${calendarMd}`;

  const extractResponse = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: extractPrompt }],
  });

  let briefQueue = [];
  try {
    const raw = extractResponse.content[0].text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    briefQueue = JSON.parse(raw);
    if (limit) briefQueue = briefQueue.slice(0, limit);
    briefQueue = briefQueue.filter(item => {
      if (isRejected(item.keyword, rejections)) {
        console.log(`  [SKIP] Rejected keyword: "${item.keyword}"`);
        return false;
      }
      return true;
    });
  } catch (e) {
    console.log('(parse error — queue will be empty)');
    console.error(e.message);
  }
  console.log(`done (${briefQueue.length} items)`);

  // ── Step 3: Extract structured items from Claude's markdown and save as JSON ──

  const extractedItems = extractScheduleItems(calendarMd);
  console.log(`  Extracted ${extractedItems.length} calendar items from markdown`);

  // Preserve any existing supporting sections (clusters, brief queue) in the markdown view
  const markdownExtras = extractNonScheduleSections(calendarMd);

  // Write JSON as source of truth + regenerate markdown view automatically
  writeCalendar({
    items: extractedItems,
    regenerated_at: new Date().toISOString(),
    preserve_metadata: true,
    markdown_extras: markdownExtras,
  });
  console.log(`\n  Calendar saved: data/calendar/calendar.json (+ markdown view)`);

  // ── Step 4: Generate briefs (optional) ───────────────────────────────────────

  if (generateBriefs && briefQueue.length > 0) {
    console.log(`\n  Generating ${briefQueue.length} brief(s) via content-researcher...\n`);

    for (let i = 0; i < briefQueue.length; i++) {
      const item = briefQueue[i];
      const slug = item.slug || slugify(item.keyword);
      const briefPath = join(BRIEFS_DIR, `${slug}.json`);

      if (existsSync(briefPath)) {
        console.log(`  [${i + 1}/${briefQueue.length}] Skipping "${item.keyword}" — brief already exists`);
        continue;
      }

      console.log(`  [${i + 1}/${briefQueue.length}] Briefing: "${item.keyword}"`);
      try {
        execSync(
          `node ${join(ROOT, 'agents', 'content-researcher', 'index.js')} "${item.keyword}"`,
          { stdio: 'inherit', cwd: ROOT },
        );
      } catch (e) {
        console.error(`    Error generating brief for "${item.keyword}": ${e.message}`);
      }
    }

    console.log('\n  Brief generation complete.');
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('\n── Summary ──────────────────────────────────────────────────────────────────');
  console.log(`  Calendar:  ${calendarPath}`);
  if (briefQueue.length > 0) {
    console.log(`\n  Brief Queue (top ${Math.min(briefQueue.length, 10)}):`);
    briefQueue.slice(0, 10).forEach((item, i) => {
      console.log(`    ${i + 1}. [${item.category}] "${item.keyword}"`);
    });
  }
  if (!generateBriefs && briefQueue.length > 0) {
    console.log(`\n  To generate briefs, run:`);
    console.log(`    node agents/content-strategist/index.js --generate-briefs`);
    console.log(`    node agents/content-strategist/index.js --generate-briefs --limit 3`);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => {
    console.log('\nStrategy complete.');
  }).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
