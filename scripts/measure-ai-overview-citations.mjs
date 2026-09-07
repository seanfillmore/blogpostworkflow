#!/usr/bin/env node
/**
 * Measure how often Google's AI Overview cites realskincare.com for questions
 * this store already earns impressions for.
 *
 *   node scripts/measure-ai-overview-citations.mjs                 # dry: the plan and the cost, ZERO calls
 *   node scripts/measure-ai-overview-citations.mjs --apply         # spend: top 30 questions x 3 runs
 *   node scripts/measure-ai-overview-citations.mjs --apply --limit 10 --runs 2
 *
 * READ-ONLY against the world: it calls DataForSEO and writes two files under
 * `data/reports/ai-overview-citations/`. It touches no Shopify object, no post,
 * no queue and no live page.
 *
 * DRY BY DEFAULT BECAUSE THE COST IS THE HAZARD. One SERP call per query per run
 * — the default 30 x 3 is 90 calls at $0.002, about $0.18. Small, but this is a
 * hand-run tool by decision: it is not on cron, and putting it there is a
 * decision somebody has to make rather than inherit. A dry run prints the exact
 * queries and the exact call count first.
 *
 * WHY THE QUESTIONS COME FROM `lib/merchant-qa.js`. They are the same measured
 * GSC questions the Merchant Center feed answers — real queries that earned this
 * store an impression, ranked by impressions, with paraphrases already collapsed
 * so three runs are not spent on eight spellings of one question. Inventing a
 * probe list would measure our vocabulary rather than buyers'.
 *
 * THREE TRAPS, each established by calling the live API rather than reading docs:
 *
 * 1. **DataForSEO is IP-whitelisted to the production box.** From a laptop every
 *    call returns `Access denied. Your IP is not whitelisted`. Run this over SSH.
 * 2. **`DATAFORSEO_PASSWORD` in `.env` is ALREADY the base64 token.** It is used
 *    verbatim as `Authorization: Basic ${...}`. Encoding it again does not error
 *    — it returns zero items, which reads exactly like a query with no results.
 * 3. **`lib/dataforseo.js`'s `extractSerpPayload` drops the AI Overview.** It
 *    keeps organic, PAA and related searches and ignores `ai_overview` entirely,
 *    so the endpoint is called directly here and parsed by
 *    `lib/ai-overview-citations.js`.
 *
 * AND THE ONE THAT DECIDES THE SAMPLING. AI Overviews are non-deterministic: one
 * pull returned an empty overview for a query that had one minutes earlier. So
 * every query is run N times — and the runs are ROUND-ROBIN by round, all 30
 * queries then all 30 again, never three-in-a-row per query. Three back-to-back
 * calls for one keyword are the case most likely to be served from one upstream
 * cache, which would make n=3 a fiction while looking exactly like n=3.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* a missing .env is only fatal on the spending path */ }
  return env;
}

const {
  extractAiOverview, organicRankOf, summarizeQueryRuns, tallyCitedDomains,
  summarizeReport, renderMarkdown, normalizeDomain,
} = await import('../lib/ai-overview-citations.js');
const { extractQuestions, isUnsuitableQuestion } = await import('../lib/merchant-qa.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const numArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const LIMIT = numArg('--limit', 30);
const RUNS = numArg('--runs', 3);

const SNAPSHOT_DAYS = 28;
const GSC_DIR = join(ROOT, 'data', 'snapshots', 'gsc');
const OUT_DIR = join(ROOT, 'data', 'reports', 'ai-overview-citations');
const COST_PER_CALL = 0.002;
/** Between calls. Courtesy pacing, and it is what puts real minutes between a query's own runs. */
const CALL_SPACING_MS = 1200;

const site = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const TARGET_DOMAIN = normalizeDomain(site.url);

function loadGscQuestions() {
  if (!existsSync(GSC_DIR)) {
    throw new Error(`${GSC_DIR} does not exist. GSC snapshots are server-written and gitignored — run this on the box.`);
  }
  const files = readdirSync(GSC_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-SNAPSHOT_DAYS);
  if (!files.length) throw new Error(`no GSC snapshots in ${GSC_DIR}`);
  const rows = [];
  for (const f of files) {
    try {
      const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
      // `topQueries` is the key a GSC snapshot actually uses — the same one
      // scripts/build-merchant-qa-feed.mjs reads, so both scripts measure the
      // same corpus.
      rows.push(...(snap.topQueries ?? []));
    } catch { /* one unreadable snapshot must not take the corpus with it */ }
  }
  // REFUSE rather than report a rate over nothing. A wrong key here does not
  // error — it yields an empty corpus, and the run then prints "0 questions,
  // $0.00, dry run complete", which is indistinguishable from a clean run and is
  // how this was nearly shipped reading `snap.queries`.
  if (!rows.length) {
    throw new Error(`${files.length} snapshot(s) read but no query rows found — check the snapshot shape (expected \`topQueries\`), not the question filter.`);
  }
  return { questions: extractQuestions(rows), days: files.length, rows: rows.length };
}

async function serp(keyword, auth) {
  const res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      keyword,
      location_code: 2840,
      language_code: 'en',
      depth: 10,
      device: 'desktop',
      // WITHOUT THIS, HALF THE SAMPLE IS UNREADABLE. Google loads many overviews
      // asynchronously; a plain request returns the `ai_overview` item with
      // `markdown`, `items` and `references` all null. Measured on the first live
      // 90-run pull, that was 41 runs — and not at random: 14 queries failed on
      // all 3 rounds, concentrated in toothpaste and long-tail phrasings, so
      // dropping them biases the rate rather than merely thinning it.
      // Costs an extra $0.002 only when it actually loads one, refunded when the
      // element is absent or was synchronous anyway.
      load_async_ai_overview: true,
    }]),
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error(`DataForSEO: ${data.status_message}`);
  const task = data.tasks?.[0];
  if (task?.status_code !== 20000) throw new Error(`DataForSEO task: ${task?.status_message}`);
  return { items: task.result?.[0]?.items ?? [], cost: data.cost ?? 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { questions, days, rows } = loadGscQuestions();
  const selected = questions.slice(0, LIMIT).map((q) => ({
    query: q.query,
    impressions: q.impressions,
    clicks: q.clicks,
    // The feed's withheld classes are RECORDED, never filtered. Whether Google
    // cites us on "how to make natural moisturizer" is a real finding; it is
    // just not a commercial one, so the report rates the two separately rather
    // than averaging a DIY recipe query into a number somebody will quote.
    withheld: isUnsuitableQuestion(q.query),
  }));

  const calls = selected.length * RUNS;
  console.log(`GSC: ${rows} query rows over ${days} snapshots -> ${questions.length} distinct questions`);
  console.log(`Selected top ${selected.length} by impressions · ${RUNS} run(s) each = ${calls} SERP call(s) ≈ $${(calls * COST_PER_CALL).toFixed(2)}`);
  console.log(`Target domain: ${TARGET_DOMAIN}\n`);
  for (const q of selected) {
    console.log(`  ${String(q.impressions).padStart(6)} imp  ${q.withheld ? `[${q.withheld}] ` : ''}${q.query}`);
  }

  if (!APPLY) {
    console.log(`\nDry run — ZERO calls made. Re-run with --apply to spend ~$${(calls * COST_PER_CALL).toFixed(2)}.`);
    return;
  }

  const auth = loadEnv().DATAFORSEO_PASSWORD || process.env.DATAFORSEO_PASSWORD;
  if (!auth) throw new Error('Missing DATAFORSEO_PASSWORD — it is ALREADY the base64 token, do not encode it again.');

  const runsByQuery = new Map(selected.map((q) => [q.query, []]));
  const errors = [];
  let cost = 0;

  // ROUND-ROBIN, not query-at-a-time. See the header: consecutive calls for one
  // keyword are the ones most likely to come back from a single upstream cache,
  // which would make the repeat sampling look like evidence without being any.
  for (let round = 1; round <= RUNS; round++) {
    console.log(`\n── round ${round}/${RUNS}`);
    for (const q of selected) {
      try {
        const { items, cost: c } = await serp(q.query, auth);
        cost += c;
        const aio = extractAiOverview(items);
        const cited = aio.domains.includes(TARGET_DOMAIN);
        runsByQuery.get(q.query).push({
          round,
          at: new Date().toISOString(),
          present: aio.present,
          asynchronous: aio.asynchronous,
          domains: aio.domains,
          references: aio.references,
          organic_rank: organicRankOf(items, TARGET_DOMAIN),
          overview_text: aio.text.slice(0, 2000),
        });
        const mark = !aio.present ? 'no overview' : aio.asynchronous ? 'UNRESOLVED' : cited ? 'CITED' : 'not cited';
        console.log(`   ${mark.padEnd(11)} ${q.query.slice(0, 70)}`);
      } catch (e) {
        // Counted and named. A failed call is not a "not cited" — folding it in
        // would push the rate down with something that was never measured.
        errors.push({ query: q.query, round, error: e.message });
        console.log(`   ERROR       ${q.query.slice(0, 70)} — ${e.message.slice(0, 80)}`);
      }
      await sleep(CALL_SPACING_MS);
    }
  }

  const queries = selected.map((q) => {
    const runs = runsByQuery.get(q.query) ?? [];
    return {
      ...q,
      summary: summarizeQueryRuns(runs, TARGET_DOMAIN),
      cited_domains: tallyCitedDomains(runs),
      runs,
    };
  });
  const report = summarizeReport(queries);

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = {
    generated_at: new Date().toISOString(),
    target_domain: TARGET_DOMAIN,
    runs_per_query: RUNS,
    queries_requested: selected.length,
    gsc: { snapshots: days, rows, distinct_questions: questions.length },
    cost,
    errors,
    report,
    queries,
  };
  const jsonPath = join(OUT_DIR, `${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const notes = [
    `Questions are the top ${selected.length} by GSC impressions over ${days} snapshots, paraphrases collapsed by lib/merchant-qa.js.`,
    'Runs are round-robin by round, not consecutive per query, so a query\'s repeats are minutes apart rather than seconds.',
    'This measures GOOGLE AI OVERVIEW citation. agents/ai-citation-tracker measures a different thing — 75 prompts against LLM APIs at n=1 per cell — and the two numbers are not comparable.',
  ];
  if (errors.length) notes.push(`${errors.length} call(s) errored and are excluded from every denominator rather than counted as "not cited".`);
  const mdPath = join(OUT_DIR, `${stamp}.md`);
  writeFileSync(mdPath, renderMarkdown({ ...payload, queries, notes }));

  console.log(`\ncited, by query: ${report.commercial.queries_ever_cited}/${report.commercial.queries_measurable} commercial`);
  console.log(`cited, by run:   ${report.commercial.cited_runs}/${report.commercial.resolved_runs} commercial overviews`);
  console.log(`cost: $${cost.toFixed(3)}${errors.length ? ` · ${errors.length} error(s)` : ''}`);
  console.log(`\njson: ${jsonPath}\nmd:   ${mdPath}`);
}

main().catch((e) => { console.error('[measure-ai-overview-citations]', e.message); process.exit(1); });
