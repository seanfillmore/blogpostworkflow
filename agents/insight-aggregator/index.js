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

import Anthropic from '../../lib/anthropic.js';
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

const WRITER_RULES_PATH = join(CONTEXT_DIR, 'writer-standing-rules.md');
const WRITER_RULES_CHANGELOG = join(CONTEXT_DIR, 'writer-standing-rules-changelog.json');
const EDITOR_REPORT_AGE_DAYS = 30;
const PATTERN_THRESHOLD = 3;

/**
 * Editor-report category extractor.
 * Returns a map of { category: verdict } for any "## <Category>" block whose
 * first line matches "VERDICT: <text>".
 */
function extractEditorVerdicts(reportText) {
  const verdicts = {};
  const lines = reportText.split('\n');
  let currentCategory = null;
  for (const line of lines) {
    // Accept ## or ### headings, optional leading numbering like "1. " or "2b. "
    const headingMatch = line.match(/^#{2,3}\s+(?:\d+[a-z]?\.\s+)?(.+?)\s*$/);
    if (headingMatch) {
      const title = headingMatch[1].trim();
      // Skip non-category headings (Link Health, Internal Link Validation, CTA Check, etc.)
      // These get their own pseudo-categories.
      currentCategory = title.replace(/\s*&\s*/g, ' & ').toLowerCase();
      continue;
    }
    if (currentCategory) {
      const v = line.match(/^\*{0,2}VERDICT[:*\s]+(.+?)\*{0,2}\s*$/i);
      if (v) {
        verdicts[currentCategory] = v[1].trim();
        currentCategory = null;
      }
    }
  }
  return verdicts;
}

const POSITIVE_VERDICT_RE = /\b(Pass|Strong|Good|Excellent|Approve|OK)\b/i;

/**
 * Scan recent editor reports for recurring issues. Any (category, finding-type)
 * that appears in PATTERN_THRESHOLD+ posts within EDITOR_REPORT_AGE_DAYS becomes
 * a standing rule.
 *
 * Returns array of { category, count, sample_slugs }.
 */
function detectRecurringEditorIssues() {
  const editorDir = join(REPORTS_DIR, 'editor');
  if (!existsSync(editorDir)) return [];
  const cutoff = Date.now() - EDITOR_REPORT_AGE_DAYS * 86400000;
  const counts = {}; // category -> { count, slugs:Set }

  for (const f of readdirSync(editorDir).filter((x) => x.endsWith('-editor-report.md'))) {
    const full = join(editorDir, f);
    const stat = statSync(full);
    if (stat.mtimeMs < cutoff) continue;
    const slug = f.replace(/-editor-report\.md$/, '');
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    const verdicts = extractEditorVerdicts(text);
    for (const [cat, verdict] of Object.entries(verdicts)) {
      if (POSITIVE_VERDICT_RE.test(verdict)) continue;
      const entry = (counts[cat] = counts[cat] || { count: 0, slugs: new Set() });
      entry.slugs.add(slug);
      entry.count = entry.slugs.size;
    }
  }

  return Object.entries(counts)
    .filter(([, v]) => v.count >= PATTERN_THRESHOLD)
    .map(([category, v]) => ({ category, count: v.count, sample_slugs: [...v.slugs].slice(0, 5) }));
}

/**
 * Append-only update of data/context/writer-standing-rules.md. New rules
 * are appended; existing rules are never modified or removed. A JSON
 * changelog tracks every appended rule with its date and supporting evidence.
 */
function updateWriterStandingRules(patterns) {
  if (!patterns.length) return { added: 0 };
  mkdirSync(CONTEXT_DIR, { recursive: true });

  const existing = existsSync(WRITER_RULES_PATH) ? readFileSync(WRITER_RULES_PATH, 'utf8') : '';
  const changelog = existsSync(WRITER_RULES_CHANGELOG)
    ? (() => { try { return JSON.parse(readFileSync(WRITER_RULES_CHANGELOG, 'utf8')); } catch { return []; } })()
    : [];

  const knownCategories = new Set(changelog.map((c) => c.category));
  const today = new Date().toISOString().slice(0, 10);
  const newEntries = [];

  for (const p of patterns) {
    if (knownCategories.has(p.category)) continue; // never duplicate
    newEntries.push({
      added_at: today,
      category: p.category,
      pattern_count: p.count,
      sample_slugs: p.sample_slugs,
      rule: `**${p.category}** — Editor flagged this category in ${p.count} of the last ${EDITOR_REPORT_AGE_DAYS} days of posts. Tighten on this dimension before submitting. Sample posts: ${p.sample_slugs.join(', ')}.`,
    });
  }

  if (!newEntries.length) return { added: 0 };

  let body = existing;
  if (!body) {
    body = `# Writer Standing Rules\n\n> Append-only. New rules are added by insight-aggregator when a recurring editor pattern is detected (≥${PATTERN_THRESHOLD} posts in ${EDITOR_REPORT_AGE_DAYS} days). Existing rules are never removed.\n\n`;
  }
  for (const e of newEntries) {
    body += `\n## Added ${e.added_at} — ${e.category}\n\n${e.rule}\n`;
  }
  writeFileSync(WRITER_RULES_PATH, body);
  writeFileSync(WRITER_RULES_CHANGELOG, JSON.stringify([...changelog, ...newEntries], null, 2));
  return { added: newEntries.length, entries: newEntries };
}

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

/**
 * Input budget. This agent was the fleet's largest LLM line item — ~370,000 input
 * tokens per call, 41% of every input token the fleet spent, $9.72 of a $26.74
 * week — because it read every changed report in full and the only guard was a
 * console warning that printed and then sent the request anyway.
 *
 * Chars rather than tokens because the loader has no tokenizer and a 4-chars-per-
 * token estimate is what the agent already used. TOTAL is the old 150k-token
 * warning threshold expressed in chars; PER_REPORT keeps one runaway file from
 * consuming the whole budget.
 */
export const PER_REPORT_CHAR_CAP = 12_000;   // ~3k tokens
export const TOTAL_CHAR_CAP = 600_000;       // ~150k tokens

/**
 * Fit reports inside the budget: truncate any single oversized report, then drop
 * whole reports oldest-first until the total fits. Returns what was dropped and
 * how many were truncated so the caller can log it — a silent cap would read as
 * "the model saw everything" when it did not.
 *
 * Newest-first is the right eviction order here: recurring patterns are what this
 * agent extracts, and a pattern still live shows up in recent reports.
 */
export function capReports(reports) {
  const dropped = [];
  let truncated = 0;

  const sized = reports.map((r) => {
    if (r.content.length <= PER_REPORT_CHAR_CAP) return r;
    truncated += 1;
    const omitted = r.content.length - PER_REPORT_CHAR_CAP;
    return {
      ...r,
      content: `${r.content.slice(0, PER_REPORT_CHAR_CAP)}\n\n[truncated — ${omitted.toLocaleString()} further characters omitted]`,
    };
  });

  const total = sized.reduce((n, r) => n + r.content.length, 0);
  if (total <= TOTAL_CHAR_CAP) return { reports: sized, dropped, truncated };

  // Walk newest-first, keeping what fits; anything that doesn't is dropped.
  const keep = new Set();
  let used = 0;
  for (const r of [...sized].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))) {
    if (used + r.content.length <= TOTAL_CHAR_CAP) {
      keep.add(r);
      used += r.content.length;
    } else {
      dropped.push(r.path);
    }
  }

  // Re-emit in the caller's original order — eviction order is an implementation
  // detail and should not reshuffle the prompt.
  return { reports: sized.filter((r) => keep.has(r)), dropped, truncated };
}

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

  // Pre-step: deterministic editor → writer feedback loop. Detect recurring
  // editor findings and append new standing rules. This runs before the
  // Claude pass and is always safe to run.
  const patterns = detectRecurringEditorIssues();
  if (patterns.length) {
    console.log(`\nDetected ${patterns.length} recurring editor pattern(s) in last ${EDITOR_REPORT_AGE_DAYS} days:`);
    for (const p of patterns) console.log(`  - ${p.category} (${p.count} posts)`);
    const result = updateWriterStandingRules(patterns);
    if (result.added > 0) console.log(`  Appended ${result.added} new standing rule(s) to writer-standing-rules.md`);
    else console.log('  All detected patterns already covered by existing standing rules.');
  }

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

  // Enforce the input budget. This used to be a warning that printed and then
  // sent the request regardless, which is how a single call reached ~370k tokens.
  const rawChars = reports.reduce((sum, r) => sum + r.content.length, 0);
  const { reports: budgeted, dropped, truncated } = capReports(reports);
  const totalChars = budgeted.reduce((sum, r) => sum + r.content.length, 0);
  console.log(`  Estimated input size: ~${Math.round(totalChars / 4).toLocaleString()} tokens (raw ~${Math.round(rawChars / 4).toLocaleString()})`);
  if (truncated) console.log(`  Truncated ${truncated} oversized report(s) to ${PER_REPORT_CHAR_CAP.toLocaleString()} chars each.`);
  if (dropped.length) {
    console.log(`  Dropped ${dropped.length} report(s) to stay inside the input budget (oldest first):`);
    for (const p of dropped) console.log(`    - ${p}`);
  }

  console.log('\nAsking Claude to analyze patterns...');
  const prompt = buildPrompt(budgeted);

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
  // Only the reports that actually reached the model. Marking a dropped report
  // processed would retire it permanently — the mtime check would skip it on every
  // later run, so a report evicted for budget would never be analyzed at all.
  saveManifest(budgeted);

  console.log(`\nFeedback written to: ${relative(ROOT, FEEDBACK_PATH)}`);

  // Print section summary
  const sectionMatches = [...feedback.matchAll(/^## ([a-z][a-z0-9-]+)/gm)];
  if (sectionMatches.length > 0) {
    console.log(`\nSections written for: ${sectionMatches.map((m) => m[1]).join(', ')}`);
  }

  console.log('\nDone.');
}

// Only run when invoked directly. Without this guard, importing anything from
// this module executes the whole agent against live reports and the Anthropic
// API, and its process.exit(1) takes the host process down with it.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  run().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
