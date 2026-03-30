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

  // ── Step 3: Save calendar ─────────────────────────────────────────────────────

  mkdirSync(REPORTS_DIR, { recursive: true });
  const calendarPath = join(REPORTS_DIR, 'content-calendar.md');

  const calendarHeader = `# Content Calendar — Real Skin Care
**Generated:** ${todayStr}
**Mode:** ${generateBriefs ? `Plan + Brief generation (${briefQueue.length} items)` : 'Plan only'}

---

`;
  writeFileSync(calendarPath, calendarHeader + calendarMd);
  console.log(`\n  Calendar saved: ${calendarPath}`);

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
