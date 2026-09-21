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
 *   node agents/ai-citation-tracker/index.js --runs 3     # sample each cell 3x
 *   node agents/ai-citation-tracker/index.js --runs 3 --core 20   # repeat only the first 20
 *   node agents/ai-citation-tracker/index.js --no-resolve # skip Gemini redirect resolution
 *
 * GEMINI'S REDIRECTOR. Every Gemini citation is an opaque
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/<token>` URL — 8,400
 * of 8,400 across every stored snapshot — so brand and competitor citation
 * detection was impossible for that engine and `citation_rate.gemini` read 0 by
 * construction. Redirects are resolved (HEAD only, no API money) BEFORE
 * detection; `--no-resolve` restores the old behaviour and the snapshot's
 * `redirect_resolution` block says which mode ran. See lib/citation-detect.js.
 *
 * SAMPLING. AI answers are non-deterministic, so one run per prompt is an
 * anecdote and not a measurement. `--runs N` samples each prompt x engine cell
 * N times and reports the RATE with its sample size. Rates are computed over
 * runs, so `--runs 1` reproduces every pre-2026-09 figure exactly and no
 * historical snapshot is re-based — see lib/citation-sampling.js for why that
 * constraint drove the design. `--core K` limits repetition to the first K
 * prompts, because repeating all 75 multiplies a paid unattended bill by N and
 * a trend only needs the same prompts each week.
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
import { isDirectRun } from '../../lib/is-direct-run.js';
import {
  aggregateRuns,
  summarizeSources,
  runsForPrompt,
  samplingMeta,
} from '../../lib/citation-sampling.js';
import {
  applyResolvedUrls,
  detectBrandCited,
  detectCompetitorCitations,
  redirectResolutionBanner,
} from '../../lib/citation-detect.js';
import { resolveGroundingRedirects, DEFAULT_CONCURRENCY } from '../../lib/citation-redirects.js';
import { isGroundingRedirect } from '../../lib/pr-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ai-citations');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const promptsConfig = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));

const args = process.argv.slice(2);
const numericArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const n = parseInt(args[i + 1], 10);
  // A typo'd value must not silently become NaN and disable the flag (or, for
  // --runs, quietly multiply a paid bill by garbage). Refuse rather than guess.
  if (!Number.isFinite(n)) throw new Error(`${flag} requires a number, got: ${args[i + 1]}`);
  return n;
};

const limit = numericArg('--limit', Infinity);
// Default 1 — identical to the pre-2026-09 behaviour. Repetition is opt-in
// because it multiplies an unattended paid API bill, and the scheduled run
// passes its own value explicitly so the cost is visible where it is chosen
// rather than buried in a default here.
const runs = Math.max(1, numericArg('--runs', 1));
const coreSize = Math.max(0, numericArg('--core', 0));

// Gemini cites through an opaque redirector, so without this pass
// `detectBrandCited` CANNOT return true for that engine and its citation rate
// reads 0 by construction — see lib/citation-detect.js for the measurement.
// Resolution is HEAD-only and costs NO API money against a run that already
// spends 575 paid LLM calls. Measured 2026-09-21 by replaying the real
// 2026-09-20 cells: ~0.52s per resolved run-batch, so **≤ ~59s added to a full
// run** for the ~1,066 redirects it produces (a conservative ceiling — the
// sample batched a cell's whole UNION, ~31 URLs, where a live run resolves one
// run's ~9). `--no-resolve` skips it and the run degrades to exactly its
// pre-2026-09-21 behaviour, which the snapshot then SAYS.
const RESOLVE = !args.includes('--no-resolve');

// ── Detection helpers ────────────────────────────────────────────────────────

const { brand, competitors, prompts: allPrompts } = promptsConfig;

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(REPORTS_DIR, { recursive: true });

  const prompts = allPrompts.slice(0, limit);
  const today = new Date().toISOString().slice(0, 10);
  const sourceNames = ALL_SOURCES.map(s => s.name);

  const sampling = samplingMeta({
    prompts: prompts.length,
    sources: sourceNames.length,
    runs,
    coreSize,
  });

  console.log(
    `[ai-citation-tracker] Running ${prompts.length} prompts across ${sourceNames.length} sources`
    + ` at ${sampling.runs_per_core_cell} run(s) per cell`
    + (sampling.tail_prompts ? ` (core ${sampling.core_prompts}, tail ${sampling.tail_prompts} at 1 run)` : '')
    + ` — ${sampling.total_calls} calls.`,
  );

  const results = [];

  // One cache for the whole process. It is deliberately NOT persisted to disk:
  // measured over all 23 stored snapshots, every one of the 8,400 grounding
  // tokens is DISTINCT — none recurs within a run or between runs — so a cache
  // file would be ~1 MB of write-only data on a box that has already lost four
  // days of cron to a full disk. The durable record is `citation_urls_resolved`
  // on the snapshot itself, which is strictly better: tokens EXPIRE after about
  // 30 days (measured — 2026-08-16 resolves 0/25, 2026-08-23 resolves 25/25),
  // so storing the destination is the only thing that makes this history
  // recoverable at all later.
  const redirectCache = new Map();
  let redirectsSeen = 0;
  let redirectsResolved = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const promptRuns = runsForPrompt(i, { runs, coreSize });
    console.log(`  [${i + 1}/${prompts.length}] "${prompt}"${promptRuns > 1 ? ` (${promptRuns} runs)` : ''}`);

    const responses = {};

    for (const source of ALL_SOURCES) {
      const sampled = [];

      for (let run = 0; run < promptRuns; run++) {
        const { text, citations, error } = await source.fn(prompt);

        if (error) {
          console.log(`    ${source.name}: ERROR — ${error}`);
          sampled.push({
            cited: null,
            mentioned: false,
            citations: [],
            citation_urls: [],
            competitor_mentions: [],
            competitor_citations: [],
            error,
          });
          continue;
        }

        const citationDomains = citations.map(url => {
          try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
        });

        // Resolve Gemini's redirector BEFORE asking who was cited. Without this
        // `detectBrandCited` cannot return true for that engine at all, because
        // the publisher never appears in the URL. Detection runs PER RUN rather
        // than on the aggregate, so `cited_runs` stays exact — `citation_urls`
        // on the aggregate is a UNION across runs and cannot answer "how many
        // runs cited us".
        let effectiveCitations = citations;
        const redirects = RESOLVE ? citations.filter(isGroundingRedirect) : [];
        if (redirects.length) {
          const r = await resolveGroundingRedirects(redirects, {
            cache: redirectCache,
            concurrency: DEFAULT_CONCURRENCY,
          });
          redirectsSeen += redirects.length;
          redirectsResolved += r.resolved.size;
          effectiveCitations = applyResolvedUrls(citations, r.resolved);
        } else if (!RESOLVE) {
          redirectsSeen += citations.filter(isGroundingRedirect).length;
        }

        sampled.push({
          cited: citations.length > 0 ? detectBrandCited(effectiveCitations, brand) : null,
          mentioned: detectBrandMentioned(text),
          citations: citationDomains,
          // Full URLs preserved alongside the domains so downstream agents
          // (pr-target-finder) can fetch the actual article for its author byline
          // and pinpoint specific Reddit threads — not just the homepage.
          // RAW and unchanged in shape: pr-target-finder resolves it itself.
          citation_urls: citations,
          // ADDITIVE. Empty when nothing needed resolving, which is every
          // engine but Gemini. Storing it is what makes a later recomputation
          // possible after the tokens expire.
          citation_urls_resolved: effectiveCitations === citations ? [] : effectiveCitations,
          competitor_mentions: detectCompetitorMentions(text),
          competitor_citations: detectCompetitorCitations(effectiveCitations, competitors),
        });
      }

      // Collapse the runs into the per-source record the snapshot format already
      // uses, so lib/pr-targets.js reads exactly the fields it always has.
      responses[source.name] = aggregateRuns(sampled);

      const r = responses[source.name];
      const detail = r.runs > 1
        ? ` (cited ${r.cited_runs}/${r.runs_with_citations}, mentioned ${r.mentioned_runs}/${r.runs})`
        : '';
      console.log(`    ${source.name}: cited=${r.cited}, mentioned=${r.mentioned}${detail}`);
    }

    results.push({ prompt, responses });
  }

  // ── Build summary ────────────────────────────────────────────────────────

  // Rates are computed over RUNS, so at 1 run per cell this is identical to
  // what the old inline block produced and every prior snapshot stays
  // comparable. See lib/citation-sampling.js.
  const summary = summarizeSources(results, sourceNames);
  const citationRate = summary.citation_rate;
  const mentionRate = summary.mention_rate;

  // A resolution pass that quietly stopped resolving looks BYTE-IDENTICAL to
  // one with nothing to resolve, so the snapshot states which it was. Absent on
  // pre-2026-09-21 snapshots, and that absence means NO resolution — every
  // Gemini citation rate in those files reads 0 by construction.
  const redirectResolution = {
    mode: RESOLVE ? 'on' : 'off',
    redirects_seen: redirectsSeen,
    redirects_resolved: redirectsResolved,
    redirects_unresolved: Math.max(0, redirectsSeen - redirectsResolved),
    note:
      'Gemini cites through an opaque grounding redirector, so brand and competitor '
      + 'citation detection is impossible for that engine without resolving it. '
      + 'Absence of this block means the snapshot predates resolution.',
  };
  console.log(`[ai-citation-tracker] ${redirectResolutionBanner(redirectResolution)}`);

  const snapshot = {
    date: today,
    prompts_run: prompts.length,
    sources: sourceNames,
    // Absent on pre-2026-09 snapshots, and that absence means 1 run per cell.
    sampling,
    redirect_resolution: redirectResolution,
    results,
    summary,
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

  // The sample size travels with the finding into the 5 AM digest. Without it
  // a reader gets a visibility verdict and no way to weigh it.
  const samplingLine = sampling.runs_per_core_cell > 1
    ? `Sampled ${sampling.runs_per_core_cell}x per cell (${sampling.total_calls} calls).`
    : 'Sampled 1x per cell — single observations, not rates.';

  await notify({
    subject: `AI Citation Tracker — ${today}`,
    // The redirect banner travels into the 5 AM digest for the same reason the
    // sample size does: a citation rate read without knowing whether the
    // redirector was resolved is a number of unknown meaning.
    body: `${summaryLine} ${samplingLine} ${redirectResolutionBanner(redirectResolution)}`,
    status: 'info',
    category: 'seo',
  });

  console.log(`[ai-citation-tracker] Done.`);
}

// ── Report generation ────────────────────────────────────────────────────────

function generateReport(snapshot) {
  const { date, prompts_run, sources, results, summary, sampling } = snapshot;
  const redirects = snapshot.redirect_resolution;
  const perCell = sampling?.runs_per_core_cell ?? 1;
  const lines = [];

  lines.push(`# AI Citation Report — ${date}`);
  lines.push('');
  lines.push(`**Brand:** ${brand.name} (${brand.domain})`);
  lines.push(`**Prompts run:** ${prompts_run}`);
  lines.push(`**Sources:** ${sources.join(', ')}`);
  lines.push(`**Sampling:** ${perCell} run(s) per prompt×source cell`
    + (sampling?.tail_prompts ? `, core ${sampling.core_prompts} repeated / ${sampling.tail_prompts} at 1 run` : ''));
  lines.push(`**Redirect resolution:** ${redirects
    ? redirectResolutionBanner(redirects)
    : 'not recorded — this snapshot predates resolution, so any Gemini citation rate here reads 0 by construction.'}`);
  lines.push('');
  if (!redirects || redirects.mode !== 'on') {
    lines.push('> **Gemini citation detection is OFF.** Every Gemini citation arrives as an opaque '
      + '`vertexaisearch.cloud.google.com/grounding-api-redirect/<token>` URL, so the brand can never '
      + 'match and `citation_rate.gemini` is 0 whatever the truth is. Do not read it as evidence.');
    lines.push('');
  }
  if (perCell === 1) {
    // Say it plainly rather than leaving a reader to infer precision from a
    // percentage. A single run is an anecdote — this is the caveat that was
    // missing while "~2% mention" was being quoted as a measurement.
    lines.push('> **One run per cell — these are single observations, not rates.** '
      + 'AI answers are non-deterministic, so a move between two snapshots at this '
      + 'sampling cannot be told from noise. Re-run with `--runs 3` to read a rate.');
    lines.push('');
  }

  // Citation & mention rate table. Every rate carries its denominator: a
  // percentage without its n is what let a single observation be read as a
  // measurement for months.
  lines.push('## Citation & Mention Rates');
  lines.push('');
  lines.push('| Source | Citation Rate | n | Mention Rate | n |');
  lines.push('|--------|-------------|---|-------------|---|');
  for (const source of sources) {
    const cite = summary.citation_rate[source] != null
      ? `${(summary.citation_rate[source] * 100).toFixed(1)}%`
      : 'n/a';
    const citeN = summary.citation_rate_n?.[source] ?? '—';
    const mention = `${((summary.mention_rate[source] || 0) * 100).toFixed(1)}%`;
    const mentionN = summary.mention_rate_n?.[source] ?? '—';
    lines.push(`| ${source} | ${cite} | ${citeN} | ${mention} | ${mentionN} |`);
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
    const prevPerCell = previous.sampling?.runs_per_core_cell ?? 1;
    if (prevPerCell !== perCell) {
      // Both sides are computed over runs so they ARE comparable, but the
      // precision is not, and a reader deciding whether a move is real needs
      // to know which side is the thin one.
      lines.push('');
      lines.push(`> Sampling differs: previous ${prevPerCell} run(s) per cell, now ${perCell}. `
        + 'Both rates are computed over runs so they are on the same basis, but the '
        + `${prevPerCell < perCell ? 'previous' : 'current'} side carries the larger error bar.`);
    }
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

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main().catch(err => {
    console.error('[ai-citation-tracker] Fatal error:', err);
    process.exit(1);
  });
}
