/**
 * AI Citation Tracker Agent
 *
 * Queries multiple LLM sources with branded prompts and tracks whether
 * the brand is cited (URL) or mentioned (text) in responses. Saves
 * daily JSON snapshots and generates a markdown report with week-over-week
 * comparison.
 *
 * Usage:
 *   node agents/ai-citation-tracker/index.js              # full run
 *   node agents/ai-citation-tracker/index.js --limit 3    # test with fewer prompts
 *
 * Output:
 *   data/reports/ai-citations/YYYY-MM-DD.json        — daily snapshot
 *   data/reports/ai-citations/latest.json             — copy of today's snapshot
 *   data/reports/ai-citations/ai-citation-report.md   — markdown report
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ALL_SOURCES } from '../../lib/llm-clients.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ai-citations');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const promptsConfig = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ── Detection helpers ────────────────────────────────────────────────────────

const { brand, competitors, prompts: allPrompts } = promptsConfig;

function detectBrandCited(citations) {
  return citations.some(url => url.toLowerCase().includes(brand.domain));
}

function detectBrandMentioned(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return brand.aliases.some(alias => lower.includes(alias.toLowerCase()));
}

function detectCompetitorMentions(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];
  for (const comp of competitors) {
    if (comp.aliases.some(alias => lower.includes(alias.toLowerCase()))) {
      found.push(comp.name);
    }
  }
  return found;
}

function detectCompetitorCitations(citations) {
  const found = [];
  for (const comp of competitors) {
    if (citations.some(url => url.toLowerCase().includes(comp.domain))) {
      found.push(comp.name);
    }
  }
  return found;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(REPORTS_DIR, { recursive: true });

  const prompts = allPrompts.slice(0, limit);
  const today = new Date().toISOString().slice(0, 10);
  const sourceNames = ALL_SOURCES.map(s => s.name);

  console.log(`[ai-citation-tracker] Running ${prompts.length} prompts across ${sourceNames.length} sources...`);

  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    console.log(`  [${i + 1}/${prompts.length}] "${prompt}"`);

    const responses = {};

    for (const source of ALL_SOURCES) {
      const { text, citations, error } = await source.fn(prompt);

      if (error) {
        console.log(`    ${source.name}: ERROR — ${error}`);
        responses[source.name] = {
          cited: null,
          mentioned: false,
          citations: [],
          competitor_mentions: [],
          competitor_citations: [],
          error,
        };
        continue;
      }

      const citationDomains = citations.map(url => {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
      });

      responses[source.name] = {
        cited: citations.length > 0 ? detectBrandCited(citations) : null,
        mentioned: detectBrandMentioned(text),
        citations: citationDomains,
        competitor_mentions: detectCompetitorMentions(text),
        competitor_citations: detectCompetitorCitations(citations),
      };

      console.log(`    ${source.name}: cited=${responses[source.name].cited}, mentioned=${responses[source.name].mentioned}`);
    }

    results.push({ prompt, responses });
  }

  // ── Build summary ────────────────────────────────────────────────────────

  const citationRate = {};
  const mentionRate = {};
  const competitorMentionCounts = {};
  const competitorCitationCounts = {};

  for (const source of sourceNames) {
    let citedCount = 0;
    let citedTotal = 0;
    let mentionedCount = 0;

    for (const r of results) {
      const resp = r.responses[source];
      if (!resp) continue;

      if (resp.cited !== null) {
        citedTotal++;
        if (resp.cited) citedCount++;
      }

      if (resp.mentioned) mentionedCount++;

      for (const comp of resp.competitor_mentions) {
        competitorMentionCounts[comp] = (competitorMentionCounts[comp] || 0) + 1;
      }
      for (const comp of resp.competitor_citations) {
        competitorCitationCounts[comp] = (competitorCitationCounts[comp] || 0) + 1;
      }
    }

    if (citedTotal > 0) {
      citationRate[source] = parseFloat((citedCount / citedTotal).toFixed(4));
    }
    mentionRate[source] = parseFloat((mentionedCount / results.length).toFixed(4));
  }

  // Sort competitors by count descending
  const topMentions = Object.fromEntries(
    Object.entries(competitorMentionCounts).sort((a, b) => b[1] - a[1])
  );
  const topCitations = Object.fromEntries(
    Object.entries(competitorCitationCounts).sort((a, b) => b[1] - a[1])
  );

  const snapshot = {
    date: today,
    prompts_run: prompts.length,
    sources: sourceNames,
    results,
    summary: {
      citation_rate: citationRate,
      mention_rate: mentionRate,
      top_competitor_mentions: topMentions,
      top_competitor_citations: topCitations,
    },
  };

  // ── Save snapshot ────────────────────────────────────────────────────────

  const snapshotPath = join(REPORTS_DIR, `${today}.json`);
  const latestPath = join(REPORTS_DIR, 'latest.json');

  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  writeFileSync(latestPath, JSON.stringify(snapshot, null, 2));
  console.log(`[ai-citation-tracker] Snapshot saved: ${snapshotPath}`);

  // ── Generate markdown report ─────────────────────────────────────────────

  const report = generateReport(snapshot);
  const reportPath = join(REPORTS_DIR, 'ai-citation-report.md');
  writeFileSync(reportPath, report);
  console.log(`[ai-citation-tracker] Report saved: ${reportPath}`);

  // ── Notify ───────────────────────────────────────────────────────────────

  const citedSources = Object.entries(citationRate).filter(([, v]) => v > 0).map(([k]) => k);
  const mentionedSources = Object.entries(mentionRate).filter(([, v]) => v > 0).map(([k]) => k);
  const summaryLine = citedSources.length > 0
    ? `Cited in ${citedSources.join(', ')}. Mentioned in ${mentionedSources.length} sources.`
    : mentionedSources.length > 0
      ? `Not cited, but mentioned in ${mentionedSources.join(', ')}.`
      : `Not cited or mentioned in any source across ${prompts.length} prompts.`;

  await notify({
    subject: `AI Citation Tracker — ${today}`,
    body: summaryLine,
    status: 'info',
    category: 'seo',
  });

  console.log(`[ai-citation-tracker] Done.`);
}

// ── Report generation ────────────────────────────────────────────────────────

function generateReport(snapshot) {
  const { date, prompts_run, sources, results, summary } = snapshot;
  const lines = [];

  lines.push(`# AI Citation Report — ${date}`);
  lines.push('');
  lines.push(`**Brand:** ${brand.name} (${brand.domain})`);
  lines.push(`**Prompts run:** ${prompts_run}`);
  lines.push(`**Sources:** ${sources.join(', ')}`);
  lines.push('');

  // Citation & mention rate table
  lines.push('## Citation & Mention Rates');
  lines.push('');
  lines.push('| Source | Citation Rate | Mention Rate |');
  lines.push('|--------|-------------|-------------|');
  for (const source of sources) {
    const cite = summary.citation_rate[source] != null
      ? `${(summary.citation_rate[source] * 100).toFixed(1)}%`
      : 'n/a';
    const mention = `${((summary.mention_rate[source] || 0) * 100).toFixed(1)}%`;
    lines.push(`| ${source} | ${cite} | ${mention} |`);
  }
  lines.push('');

  // Top competitor mentions
  const mentionEntries = Object.entries(summary.top_competitor_mentions);
  if (mentionEntries.length > 0) {
    lines.push('## Top Competitor Mentions');
    lines.push('');
    lines.push('| Competitor | Mentions |');
    lines.push('|-----------|---------|');
    for (const [name, count] of mentionEntries.slice(0, 15)) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push('');
  }

  // Top competitor citations
  const citationEntries = Object.entries(summary.top_competitor_citations);
  if (citationEntries.length > 0) {
    lines.push('## Top Competitor Citations');
    lines.push('');
    lines.push('| Competitor | Citations |');
    lines.push('|-----------|----------|');
    for (const [name, count] of citationEntries.slice(0, 15)) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push('');
  }

  // Week-over-week comparison
  const previous = loadPreviousSnapshot(date);
  if (previous) {
    lines.push('## Week-over-Week Comparison');
    lines.push('');
    lines.push(`Previous snapshot: ${previous.date}`);
    lines.push('');
    lines.push('| Source | Citation Rate (prev) | Citation Rate (now) | Mention Rate (prev) | Mention Rate (now) |');
    lines.push('|--------|---------------------|--------------------|--------------------|-------------------|');
    for (const source of sources) {
      const prevCite = previous.summary.citation_rate[source];
      const nowCite = summary.citation_rate[source];
      const prevMention = previous.summary.mention_rate[source];
      const nowMention = summary.mention_rate[source];
      const fmtRate = (v) => v != null ? `${(v * 100).toFixed(1)}%` : 'n/a';
      lines.push(`| ${source} | ${fmtRate(prevCite)} | ${fmtRate(nowCite)} | ${fmtRate(prevMention)} | ${fmtRate(nowMention)} |`);
    }
    lines.push('');
  }

  // Prompts where brand was cited or mentioned
  const citedPrompts = [];
  const mentionedPrompts = [];

  for (const r of results) {
    const citedIn = [];
    const mentionedIn = [];
    for (const [source, resp] of Object.entries(r.responses)) {
      if (resp.cited) citedIn.push(source);
      if (resp.mentioned) mentionedIn.push(source);
    }
    if (citedIn.length > 0) citedPrompts.push({ prompt: r.prompt, sources: citedIn });
    if (mentionedIn.length > 0) mentionedPrompts.push({ prompt: r.prompt, sources: mentionedIn });
  }

  if (citedPrompts.length > 0) {
    lines.push('## Prompts Where We Were Cited');
    lines.push('');
    for (const { prompt, sources: s } of citedPrompts) {
      lines.push(`- **"${prompt}"** — ${s.join(', ')}`);
    }
    lines.push('');
  }

  if (mentionedPrompts.length > 0) {
    lines.push('## Prompts Where We Were Mentioned');
    lines.push('');
    for (const { prompt, sources: s } of mentionedPrompts) {
      lines.push(`- **"${prompt}"** — ${s.join(', ')}`);
    }
    lines.push('');
  }

  if (citedPrompts.length === 0 && mentionedPrompts.length === 0) {
    lines.push('## Brand Visibility');
    lines.push('');
    lines.push('Brand was not cited or mentioned in any response.');
    lines.push('');
  }

  return lines.join('\n');
}

function loadPreviousSnapshot(currentDate) {
  try {
    const files = readdirSync(REPORTS_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/) && f < `${currentDate}.json`)
      .sort()
      .reverse();

    if (files.length === 0) return null;

    return JSON.parse(readFileSync(join(REPORTS_DIR, files[0]), 'utf8'));
  } catch {
    return null;
  }
}

main().catch(err => {
  console.error('[ai-citation-tracker] Fatal error:', err);
  process.exit(1);
});
