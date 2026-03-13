/**
 * Insight Aggregator Agent
 *
 * Reads all agent reports from data/reports/**\/*.md, uses Claude to extract
 * recurring patterns and actionable feedback per agent, and writes
 * data/context/feedback.md with clearly labeled sections for each agent.
 *
 * Each agent reads its section from feedback.md at startup and incorporates
 * the guidance into its prompt context before running.
 *
 * Usage:
 *   node agents/insight-aggregator/index.js           # read all reports, write feedback.md
 *   node agents/insight-aggregator/index.js --verbose # print each report as it's loaded
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports');
const CONTEXT_DIR = join(ROOT, 'data', 'context');
const FEEDBACK_PATH = join(CONTEXT_DIR, 'feedback.md');
const MANIFEST_PATH = join(CONTEXT_DIR, 'feedback-manifest.json');

const VERBOSE = process.argv.includes('--verbose');
const FORCE = process.argv.includes('--force');

// ── manifest ──────────────────────────────────────────────────────────────────

function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return { lastRunAt: 0, processedFiles: {} };
  }
}

function saveManifest(files) {
  const manifest = {
    lastRunAt: Date.now(),
    processedFiles: Object.fromEntries(
      files.map((f) => [f.path, f.mtimeMs])
    ),
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
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

// ── report loader ─────────────────────────────────────────────────────────────

function walkReports(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkReports(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function loadReports(manifest) {
  if (!existsSync(REPORTS_DIR)) return [];
  const files = walkReports(REPORTS_DIR);
  const reports = [];
  let skippedCount = 0;

  for (const file of files) {
    try {
      const relPath = relative(ROOT, file);
      const mtimeMs = statSync(file).mtimeMs;

      // Skip unchanged reports unless --force
      if (!FORCE && manifest.processedFiles[relPath] === mtimeMs) {
        skippedCount++;
        continue;
      }

      const content = readFileSync(file, 'utf8');
      const parts = relPath.split('/');
      const agentDir = parts[2]; // e.g. "editor", "content-refresher"
      reports.push({ path: relPath, agentDir, content, mtimeMs });
      if (VERBOSE) console.log(`  Loaded: ${relPath}`);
    } catch (err) {
      console.warn(`  Warning: could not read ${file}: ${err.message}`);
    }
  }

  if (skippedCount > 0) {
    console.log(`  Skipped ${skippedCount} unchanged report(s) (use --force to re-process all)`);
  }
  return reports;
}

// ── agent mapping ─────────────────────────────────────────────────────────────

// Maps report directory names to agent section names in feedback.md
// Also defines which agents should receive GSC/strategic feedback
const AGENT_SECTIONS = [
  'blog-post-writer',
  'content-refresher',
  'editor',
  'content-researcher',
  'keyword-research',
  'technical-seo',
  'internal-linker',
  'meta-optimizer',
  'product-optimizer',
  'content-gap',
  'gsc-query-miner',
  'rank-tracker',
  'seo-reporter',
];

// ── prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(reports) {
  const reportSections = reports.map((r) =>
    `### Report: ${r.path}\n\n${r.content}`
  ).join('\n\n---\n\n');

  return `You are an insight aggregator for an SEO content team. Your job is to read all agent reports and extract recurring, actionable patterns — then write clear per-agent feedback that will improve future runs.

## Known Platform Facts (treat these as resolved — do not surface as issues)

- **Shopify H1 behavior**: Shopify blog posts render the article title as the page H1 automatically. The post body_html should NOT contain an H1 tag. Any report flagging "missing H1 in post body" is a false positive for blog posts — this is correct behavior, not an error. Do not include H1-related instructions in any agent section.

## Your Task

1. Read all reports below carefully.
2. Identify **recurring issues** — problems that appear in 2+ reports or show a consistent pattern, not one-off anomalies.
3. For each agent listed in AGENT SECTIONS, write a section with:
   - Specific, actionable instructions the agent should follow
   - Patterns you found in the reports that indicate a systematic issue
   - Routing: if GSC or competitive data suggests content gaps, route those recommendations to the right writing agents
4. Skip any agent section where there are no meaningful recurring issues or recommendations to add.
5. Be direct and specific. Write as if you're updating a standing operating procedure.

## Agent Sections to Write (use these exact section headings)

${AGENT_SECTIONS.map((a) => `- ## ${a}`).join('\n')}

## Format for Each Section

\`\`\`
## <agent-name>

**Last updated:** <date>

### Recurring Issues
- Bullet list of patterns found across reports (skip if none)

### Standing Instructions
- Bullet list of specific rules or checks this agent should follow going forward

### Routed Intelligence
- Any findings from other agents/reports that this agent should act on (skip if none)
\`\`\`

Only include sections for agents that have actionable feedback. Do not write empty sections.
Do not invent issues that aren't supported by the reports.

---

## All Reports

${reportSections}`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Insight Aggregator');
  console.log('==================');

  console.log('\nLoading reports...');
  const manifest = loadManifest();
  if (manifest.lastRunAt && !FORCE) {
    const age = Math.round((Date.now() - manifest.lastRunAt) / 60000);
    console.log(`  Last run: ${age} minute(s) ago (--force to re-process all reports)`);
  }
  const reports = loadReports(manifest);
  if (reports.length === 0) {
    console.log('No new or changed reports since last run. feedback.md is up to date.');
    console.log('Use --force to re-process all reports.');
    process.exit(0);
  }
  console.log(`  Loaded ${reports.length} new/changed report(s) from ${[...new Set(reports.map((r) => r.agentDir))].join(', ')}`);

  // Rough token estimate (4 chars ≈ 1 token) — warn if very large
  const totalChars = reports.reduce((sum, r) => sum + r.content.length, 0);
  const estTokens = Math.round(totalChars / 4);
  console.log(`  Estimated input size: ~${estTokens.toLocaleString()} tokens`);
  if (estTokens > 150000) {
    console.warn('  Warning: large input — consider trimming older reports if this times out');
  }

  console.log('\nAsking Claude to analyze patterns...');
  const prompt = buildPrompt(reports);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
    system: `You are an experienced SEO content operations analyst. You read agent reports and synthesize recurring patterns into clear, actionable standing instructions. Be specific, concise, and evidence-based. Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
  });

  const feedback = message.content[0].text;

  mkdirSync(CONTEXT_DIR, { recursive: true });

  const header = `# Agent Feedback — Standing Instructions\n\n> Auto-generated by insight-aggregator on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.\n> Re-run \`npm run insights\` after any agent completes a batch of reports to refresh this file.\n\n---\n\n`;

  writeFileSync(FEEDBACK_PATH, header + feedback, 'utf8');

  // Save manifest so next run skips unchanged reports
  saveManifest(reports);

  console.log(`\nFeedback written to: ${relative(ROOT, FEEDBACK_PATH)}`);

  // Print section summary
  const sectionMatches = [...feedback.matchAll(/^## ([a-z][a-z0-9-]+)/gm)];
  if (sectionMatches.length > 0) {
    console.log(`\nSections written for: ${sectionMatches.map((m) => m[1]).join(', ')}`);
  }

  console.log('\nDone.');
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
