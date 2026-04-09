/**
 * AI Citation Tracker Agent
 *
 * Runs a fixed list of target prompts through ChatGPT (OpenAI), Claude
 * (Anthropic), and Gemini (Google) using each provider's web-grounded
 * search tool. Parses responses for brand and competitor mentions and
 * tracks share-of-voice over time.
 *
 * Snapshot:  data/citation-snapshots/YYYY-MM-DD.json
 * Report:    data/reports/ai-citation/citation-report.md
 *
 * Config:    config/ai-citation-prompts.json
 *
 * Usage:
 *   node agents/ai-citation-tracker/index.js
 *   node agents/ai-citation-tracker/index.js --providers openai,gemini
 *   node agents/ai-citation-tracker/index.js --limit 5    # first 5 prompts only
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'citation-snapshots');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ai-citation');
const PROMPTS_PATH = join(ROOT, 'config', 'ai-citation-prompts.json');

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const env = {};
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
  } catch {}
  return env;
}
const env = loadEnv();
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
  if (env[k] && !process.env[k]) process.env[k] = env[k];
}

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}
const providersArg = arg('--providers');
const limitArg = arg('--limit');
const REQUESTED = providersArg
  ? new Set(providersArg.split(',').map((s) => s.trim().toLowerCase()))
  : new Set(['openai', 'anthropic', 'gemini']);

// ── config ────────────────────────────────────────────────────────────────────

const cfg = JSON.parse(readFileSync(PROMPTS_PATH, 'utf8'));
const BRAND = cfg.brand;
const COMPETITORS = cfg.competitors || [];
let PROMPTS = cfg.prompts || [];
if (limitArg) PROMPTS = PROMPTS.slice(0, parseInt(limitArg, 10));

// ── mention detection ─────────────────────────────────────────────────────────

function buildBrandPatterns(name, domain, aliases = []) {
  const terms = new Set([name, domain, ...aliases].filter(Boolean));
  return [...terms].map((t) => new RegExp(escapeRe(t), 'i'));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function detectMention(text, patterns) {
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}
function detectInCitations(citations, domain) {
  if (!citations || !domain) return false;
  return citations.some((c) => (c.url || '').toLowerCase().includes(domain.toLowerCase()));
}

const BRAND_PATTERNS = buildBrandPatterns(BRAND.name, BRAND.domain, BRAND.aliases);
const COMPETITOR_PATTERNS = COMPETITORS.map((c) => ({
  ...c,
  patterns: buildBrandPatterns(c.name, c.domain, c.aliases),
}));

function analyze(text, citations) {
  const brandCited = detectMention(text, BRAND_PATTERNS) || detectInCitations(citations, BRAND.domain);
  const competitorsCited = COMPETITOR_PATTERNS
    .filter((c) => detectMention(text, c.patterns) || detectInCitations(citations, c.domain))
    .map((c) => c.name);
  return { brandCited, competitorsCited };
}

// ── providers ─────────────────────────────────────────────────────────────────

async function queryOpenAI(prompt) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.responses.create({
    model: 'gpt-4o-mini',
    tools: [{ type: 'web_search_preview' }],
    input: prompt,
  });
  const text = res.output_text || '';
  const citations = [];
  for (const item of res.output || []) {
    for (const c of item.content || []) {
      for (const ann of c.annotations || []) {
        if (ann.type === 'url_citation' && ann.url) {
          citations.push({ url: ann.url, title: ann.title || '' });
        }
      }
    }
  }
  return { text, citations };
}

async function queryAnthropic(prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    messages: [{ role: 'user', content: prompt }],
  });
  let text = '';
  const citations = [];
  for (const block of res.content || []) {
    if (block.type === 'text') {
      text += block.text;
      for (const c of block.citations || []) {
        if (c.url) citations.push({ url: c.url, title: c.title || '' });
      }
    }
  }
  return { text, citations };
}

async function queryGemini(prompt) {
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { tools: [{ googleSearch: {} }] },
  });
  const text = res.text || '';
  const citations = [];
  const grounding = res.candidates?.[0]?.groundingMetadata;
  for (const chunk of grounding?.groundingChunks || []) {
    const url = chunk.web?.uri;
    if (url) citations.push({ url, title: chunk.web?.title || '' });
  }
  return { text, citations };
}

const PROVIDERS = [
  { id: 'openai',    label: 'ChatGPT (gpt-4o-mini + web_search)', run: queryOpenAI,    envKey: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Claude (haiku-4.5 + web_search)',    run: queryAnthropic, envKey: 'ANTHROPIC_API_KEY' },
  { id: 'gemini',    label: 'Gemini (2.0-flash + googleSearch)',  run: queryGemini,    envKey: 'GEMINI_API_KEY' },
];

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nAI Citation Tracker — ${BRAND.name}\n`);

  const active = PROVIDERS.filter((p) => REQUESTED.has(p.id) && process.env[p.envKey]);
  const skipped = PROVIDERS.filter((p) => REQUESTED.has(p.id) && !process.env[p.envKey]);
  for (const s of skipped) console.log(`  ⚠️  Skipping ${s.id} — ${s.envKey} not set`);
  if (active.length === 0) {
    console.error('No providers available. Set API keys in .env.');
    process.exit(1);
  }
  console.log(`  Providers: ${active.map((p) => p.id).join(', ')}`);
  console.log(`  Prompts: ${PROMPTS.length}`);
  console.log(`  Competitors tracked: ${COMPETITORS.length}\n`);

  const today = new Date().toISOString().slice(0, 10);
  const results = []; // { prompt, provider, brandCited, competitorsCited, citations, text }

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`  [${i + 1}/${PROMPTS.length}] "${prompt}"`);
    for (const p of active) {
      try {
        const { text, citations } = await p.run(prompt);
        const { brandCited, competitorsCited } = analyze(text, citations);
        results.push({
          prompt,
          provider: p.id,
          brandCited,
          competitorsCited,
          citationCount: citations.length,
          citations: citations.slice(0, 10),
          textPreview: text.slice(0, 500),
        });
        const flag = brandCited ? '✅ cited' : '❌';
        console.log(`      ${p.id.padEnd(10)} ${flag}  competitors: ${competitorsCited.join(', ') || '—'}`);
      } catch (e) {
        console.log(`      ${p.id.padEnd(10)} ⚠️  error: ${e.message}`);
        results.push({ prompt, provider: p.id, error: e.message });
      }
    }
  }

  // Save snapshot
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshot = { date: today, brand: BRAND, providers: active.map((p) => p.id), results };
  const snapshotPath = join(SNAPSHOTS_DIR, `${today}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n  Snapshot: ${snapshotPath}`);

  // Build report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const previous = loadPreviousSnapshot(today);
  const report = buildReport(snapshot, previous);
  const reportPath = join(REPORTS_DIR, 'citation-report.md');
  writeFileSync(reportPath, report);
  console.log(`  Report:   ${reportPath}\n`);

  // Summary
  printSummary(results, active);
}

function loadPreviousSnapshot(today) {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.json') && f.replace('.json', '') < today)
    .sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, files[files.length - 1]), 'utf8'));
}

function shareOfVoice(results, providerId) {
  const rows = results.filter((r) => r.provider === providerId && !r.error);
  const total = rows.length;
  if (total === 0) return { brand: 0, total: 0, pct: 0 };
  const brand = rows.filter((r) => r.brandCited).length;
  return { brand, total, pct: Math.round((brand / total) * 100) };
}

function competitorTallies(results, providerId) {
  const tally = new Map();
  for (const r of results) {
    if (r.provider !== providerId || r.error) continue;
    for (const c of r.competitorsCited || []) {
      tally.set(c, (tally.get(c) || 0) + 1);
    }
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]);
}

function buildReport(snapshot, previous) {
  const lines = [];
  const { date, results, providers } = snapshot;
  lines.push(`# AI Citation Report — ${BRAND.name}`);
  lines.push(`**Date:** ${date}`);
  if (previous) lines.push(`**Compared with:** ${previous.date}`);
  lines.push(`**Prompts:** ${PROMPTS.length}  •  **Providers:** ${providers.join(', ')}`);
  lines.push('');

  // Share of voice per provider
  lines.push('## Share of Voice\n');
  lines.push('| Provider | Cited | Out of | % | Δ vs prev |');
  lines.push('|----------|-------|--------|---|-----------|');
  for (const p of providers) {
    const sov = shareOfVoice(results, p);
    let delta = '—';
    if (previous) {
      const prev = shareOfVoice(previous.results, p);
      const d = sov.pct - prev.pct;
      delta = d === 0 ? '→ 0' : d > 0 ? `↑ ${d}` : `↓ ${Math.abs(d)}`;
    }
    lines.push(`| ${p} | ${sov.brand} | ${sov.total} | ${sov.pct}% | ${delta} |`);
  }
  lines.push('');

  // Per-prompt grid
  lines.push('## Per-Prompt Citation Grid\n');
  const header = ['Prompt', ...providers].join(' | ');
  const sep = ['---', ...providers.map(() => ':-:')].join(' | ');
  lines.push(`| ${header} |`);
  lines.push(`| ${sep} |`);
  for (const prompt of PROMPTS) {
    const cells = [prompt];
    for (const p of providers) {
      const r = results.find((x) => x.prompt === prompt && x.provider === p);
      if (!r) cells.push('—');
      else if (r.error) cells.push('⚠️');
      else cells.push(r.brandCited ? '✅' : '❌');
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Competitor share
  lines.push('## Competitor Mentions\n');
  for (const p of providers) {
    const tallies = competitorTallies(results, p);
    if (tallies.length === 0) continue;
    lines.push(`### ${p}\n`);
    lines.push('| Competitor | Mentions |');
    lines.push('|-----------|----------|');
    for (const [name, count] of tallies) lines.push(`| ${name} | ${count} |`);
    lines.push('');
  }

  // Missed opportunities — brand not cited but competitors were
  lines.push('## Missed Opportunities\n');
  lines.push('Prompts where competitors were cited but the brand was not.\n');
  const missed = results.filter((r) => !r.error && !r.brandCited && (r.competitorsCited || []).length > 0);
  if (missed.length === 0) {
    lines.push('_None this run._\n');
  } else {
    lines.push('| Prompt | Provider | Competitors cited |');
    lines.push('|--------|----------|-------------------|');
    for (const r of missed) {
      lines.push(`| ${r.prompt} | ${r.provider} | ${r.competitorsCited.join(', ')} |`);
    }
    lines.push('');
  }

  // Citing pages — when the brand IS cited, which pages got picked
  const citingPages = new Map();
  for (const r of results) {
    if (!r.brandCited || !r.citations) continue;
    for (const c of r.citations) {
      if ((c.url || '').toLowerCase().includes(BRAND.domain)) {
        citingPages.set(c.url, (citingPages.get(c.url) || 0) + 1);
      }
    }
  }
  if (citingPages.size > 0) {
    lines.push('## Pages Cited (own domain)\n');
    lines.push('| URL | Times cited |');
    lines.push('|-----|------------|');
    for (const [url, n] of [...citingPages.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${url} | ${n} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function printSummary(results, active) {
  console.log('Summary:');
  for (const p of active) {
    const sov = shareOfVoice(results, p.id);
    console.log(`  ${p.id.padEnd(10)} ${sov.brand}/${sov.total} cited (${sov.pct}%)`);
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  console.error(err.stack);
  process.exit(1);
});
