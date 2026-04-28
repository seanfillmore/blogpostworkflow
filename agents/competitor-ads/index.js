/**
 * Competitor Ads Agent
 *
 * Scrapes the Meta Ad Library for each competitor in config/competitors.json,
 * sends the rendered text to Claude to extract dominant messaging angles,
 * hooks, and visual themes, and writes a consolidated report.
 *
 * Output:
 *   data/reports/competitor-ads/YYYY-MM-DD.json — per-run snapshot
 *   data/reports/competitor-ads/latest.json     — latest pointer for downstream
 *
 * Downstream consumer (separate PR): creative-packager will read latest.json
 * to inject "competitor patterns" into the Gemini style prompt.
 *
 * Usage:
 *   node agents/competitor-ads/index.js
 *   node agents/competitor-ads/index.js --limit 3   # only first N competitors
 *   node agents/competitor-ads/index.js --dry-run   # don't call Firecrawl/Claude
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrape, metaAdLibraryUrl } from '../../lib/firecrawl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'competitor-ads');
const COMPETITORS_PATH = join(ROOT, 'config', 'competitors.json');

// ── env loader (project convention) ───────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

// ── Pure helpers (tested) ─────────────────────────────────────────────────────

/**
 * Truncate a long markdown blob to keep Claude token costs reasonable.
 * Meta Ad Library pages often run 50k+ chars after JS render — we don't
 * need all of it for pattern extraction.
 */
export function truncateForLLM(markdown, maxChars = 12000) {
  if (!markdown) return '';
  const s = String(markdown);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n\n[...truncated]';
}

/**
 * Aggregate per-competitor pattern objects into a single rollup. Counts
 * how often each angle / hook / theme appears across competitors so the
 * downstream prompt can prioritize the dominant patterns.
 */
export function aggregatePatterns(perCompetitor) {
  const counts = (key) => {
    const m = new Map();
    for (const p of perCompetitor) {
      for (const item of p.patterns?.[key] || []) {
        const k = String(item).trim().toLowerCase();
        if (!k) continue;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count }));
  };
  return {
    angles: counts('angles'),
    hooks: counts('hooks'),
    themes: counts('themes'),
  };
}

/**
 * Build the Claude pattern-extraction prompt. Pure — exported for tests.
 */
export function buildPatternPrompt(competitorName, scrapedText) {
  return `You are an SEO + creative-strategy analyst reviewing a competitor's currently-running paid ads on Meta.

COMPETITOR: ${competitorName}

The text below is the rendered content of the brand's Meta Ad Library page. It contains the headlines, body copy, CTAs, and metadata for ads they are paying to run right now. Some of it may be navigation chrome — ignore that.

Identify the DOMINANT patterns across this brand's currently-running ads. Return ONLY valid JSON (no markdown fences) with this exact shape:

{
  "angles": ["<messaging angle 1>", "<messaging angle 2>", ...],
  "hooks": ["<opening hook 1>", "<hook 2>", ...],
  "themes": ["<visual or copy theme 1>", "<theme 2>", ...]
}

Constraints:
- 3–6 entries per array, no more.
- Each entry is a short noun phrase (≤ 6 words).
- "angles" = WHAT the ads are selling on (e.g. "no aluminum", "all-day protection", "scientist-formulated").
- "hooks" = HOW the ads grab attention in the first 3 words (e.g. "stop sweating chemicals", "your armpit deserves better").
- "themes" = recurring visual or stylistic patterns (e.g. "before/after testimonials", "natural ingredient close-ups", "minimal white background").
- If the page contains too few ads to extract patterns, return arrays of length 0.

SCRAPED CONTENT:
${scrapedText}`;
}

// ── orchestration ─────────────────────────────────────────────────────────────

async function extractPatternsViaClaude(client, competitorName, scrapedText) {
  if (!scrapedText || !scrapedText.trim()) {
    return { angles: [], hooks: [], themes: [] };
  }
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPatternPrompt(competitorName, scrapedText) }],
  });
  const raw = message.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(raw);
    return {
      angles: Array.isArray(parsed.angles) ? parsed.angles : [],
      hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
    };
  } catch {
    return { angles: [], hooks: [], themes: [] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

  console.log(`\nCompetitor Ads — Meta Ad Library scraper\n`);

  const env = loadEnv();
  const firecrawlKey = env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!dryRun && !firecrawlKey) throw new Error('Missing FIRECRAWL_API_KEY');
  if (!dryRun && !anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY');

  if (!existsSync(COMPETITORS_PATH)) {
    throw new Error(`Competitors config not found: ${COMPETITORS_PATH}`);
  }
  let competitors = JSON.parse(readFileSync(COMPETITORS_PATH, 'utf8'));
  if (limit) competitors = competitors.slice(0, limit);
  console.log(`  Competitors: ${competitors.length} (${competitors.map((c) => c.name).join(', ')})`);

  if (dryRun) {
    for (const c of competitors) {
      console.log(`  [dry-run] would scrape ${metaAdLibraryUrl(c.name)}`);
    }
    return;
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: anthropicKey });

  const perCompetitor = [];
  for (const c of competitors) {
    process.stdout.write(`  ${c.name}... scraping `);
    const url = metaAdLibraryUrl(c.name);
    const scraped = await scrape(firecrawlKey, url, { waitFor: 6000 });
    if (!scraped?.markdown) {
      console.log('no content');
      perCompetitor.push({ name: c.name, url, scraped_chars: 0, patterns: { angles: [], hooks: [], themes: [] }, error: 'no markdown' });
      continue;
    }
    const truncated = truncateForLLM(scraped.markdown);
    process.stdout.write(`(${truncated.length} chars) extracting `);
    const patterns = await extractPatternsViaClaude(client, c.name, truncated);
    console.log(`done (${patterns.angles.length} angles, ${patterns.hooks.length} hooks, ${patterns.themes.length} themes)`);
    perCompetitor.push({
      name: c.name,
      url,
      scraped_chars: scraped.markdown.length,
      patterns,
    });
  }

  const aggregated = aggregatePatterns(perCompetitor);
  const dateStr = new Date().toISOString().slice(0, 10);
  mkdirSync(REPORTS_DIR, { recursive: true });

  const report = {
    generated_at: new Date().toISOString(),
    competitors: perCompetitor,
    aggregate: aggregated,
  };
  writeFileSync(join(REPORTS_DIR, `${dateStr}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));

  console.log(`\n  Report: data/reports/competitor-ads/${dateStr}.json`);
  console.log(`  Top angles: ${aggregated.angles.slice(0, 5).map((a) => `${a.label} (${a.count})`).join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Competitor Ads agent failed:', err.message);
    process.exit(1);
  });
}
