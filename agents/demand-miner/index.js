#!/usr/bin/env node
/**
 * Demand Miner
 *
 * Seeds Google People Also Ask + related-search harvesting from two empirical
 * sources — GSC impression leaks (data/reports/gsc-query-miner/impression-leaks.json)
 * and persona objections (data/context/personas.json) — then classifies every
 * harvested question by funnel stage so it can join against personas.json on
 * `stage` + `persona_id`. Writes:
 *   data/context/demand-questions.json   machine-readable artifact
 *   data/context/demand-questions.md     human-readable, greppable artifact
 *   data/reports/demand-miner/seeds-<date>.json + latest.json   run record
 *
 * Usage:
 *   node agents/demand-miner/index.js
 *
 * Spec: docs/superpowers/specs/2026-08-21-demand-miner-design.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { getSerpResults } from '../../lib/dataforseo.js';
import { notify } from '../../lib/notify.js';
import { AWARENESS_LEVELS } from '../../lib/voice-of-customer.js';
import {
  deriveSeeds,
  normalizeHarvest,
  validateQuestions,
  renderDemandQuestionsMarkdown,
} from '../../lib/demand-questions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONTEXT_DIR = join('data', 'context');
const REPORT_DIR = join('data', 'reports', 'demand-miner');

const CLUSTER = 'skin';
const MODEL = 'claude-haiku-4-5-20251001';

// ── .env loader (same pattern as the other agents) ───────────────────────────

function loadEnv(root = ROOT) {
  try {
    const lines = readFileSync(join(root, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

// ── LLM stage classification ────────────────────────────────────────────────

/**
 * Structural shape only — `stage` is a free-form string here, not constrained to
 * AWARENESS_LEVELS. Schema-enforcing the enum too would make it impossible for a
 * production model response to ever reach validateQuestions with a bad value, but
 * that check exists as a second, independent line of defense (see the docstring
 * below) and stays meaningful only if it can actually fire on real output.
 */
const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'stage'],
        properties: {
          text: { type: 'string' },
          stage: { type: 'string' },
        },
      },
    },
  },
};

function buildClassifyPrompt(records) {
  const lines = [
    'You are classifying customer search questions for Real Skin Care, a natural',
    'body-care brand, by funnel awareness stage.',
    '',
    'For EACH question below, choose exactly one stage from: ' + AWARENESS_LEVELS.join(', ') + '.',
    '  unaware         — no idea they have this problem yet',
    '  problem-aware    — knows the problem, does not know solutions exist',
    '  solution-aware   — knows solutions exist, has not picked one',
    '  product-aware    — knows about products like ours, has not decided',
    '  most-aware       — knows our product specifically, needs a final push',
    '',
    'Respond with ONLY a JSON object of the exact shape:',
    '  { "questions": [ { "text": "<question, verbatim>", "stage": "<one of the levels above>" }, ... ] }',
    'Return one entry for every question below, using its exact text. No prose, no markdown fence.',
    '',
    'QUESTIONS:',
  ];
  records.forEach((r, i) => lines.push(`[${i + 1}] ${r.text}`));
  return lines.join('\n');
}

/**
 * The one LLM call. Sends the deduped question texts, asks for a stage per
 * question, parses the JSON response, and merges each returned `stage` back
 * onto its record by text.
 *
 * Retries exactly once on malformed or schema-violating output (bad JSON, a
 * missing `questions` array, an entry missing `text`/`stage`, or a response
 * that doesn't cover every question), then throws. This is a structural
 * check only — it does NOT validate that `stage` is one of the five funnel
 * levels; that is validateQuestions' job, run by the caller straight after,
 * so both checks stay single-purpose and neither silently overlaps the other.
 *
 * The retry is logged so a recurring parse failure is visible in the digest
 * rather than silent.
 */
export async function classifyStages({ anthropic, records }) {
  if (records.length === 0) return [];
  const prompt = buildClassifyPrompt(records);

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4000,
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: CLASSIFY_SCHEMA },
        },
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      lastError = err;
      console.warn(`  demand-miner: LLM call failed on attempt ${attempt}: ${err.message} — retrying`);
      continue;
    }

    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      lastError = new Error(`JSON.parse failed: ${err.message}`);
      console.warn(`  demand-miner: attempt ${attempt} returned unparsable JSON — retrying`);
      continue;
    }

    if (!parsed || !Array.isArray(parsed.questions)) {
      lastError = new Error('response is missing a "questions" array');
      console.warn(`  demand-miner: attempt ${attempt} was schema-invalid (no questions array) — retrying`);
      continue;
    }

    const stageByText = new Map();
    let shapeOk = true;
    for (const q of parsed.questions) {
      if (!q || typeof q.text !== 'string' || typeof q.stage !== 'string') { shapeOk = false; break; }
      stageByText.set(q.text.trim().toLowerCase(), q.stage);
    }
    if (!shapeOk) {
      lastError = new Error('a question entry was missing "text" or "stage"');
      console.warn(`  demand-miner: attempt ${attempt} was schema-invalid (missing text/stage) — retrying`);
      continue;
    }

    const missing = records.filter((r) => !stageByText.has(r.text.trim().toLowerCase()));
    if (missing.length > 0) {
      lastError = new Error(`LLM response is missing a stage for ${missing.length} of ${records.length} question(s)`);
      console.warn(`  demand-miner: attempt ${attempt} did not classify every question — retrying`);
      continue;
    }

    return records.map((r) => ({ ...r, stage: stageByText.get(r.text.trim().toLowerCase()) }));
  }

  throw new Error(`demand-miner: LLM stage classification failed twice — ${lastError ? lastError.message : 'unknown error'}`);
}

// ── the injectable core ──────────────────────────────────────────────────────

/**
 * The injectable core. Every dependency is a parameter, so the smoke test needs no
 * network, no LLM and no filesystem. main() below wires the real ones.
 */
export async function runDemandMiner({ getSerpResults, anthropic, readJson, writeArtifacts, now }) {
  const leaksFeed = readJson('data/reports/gsc-query-miner/impression-leaks.json');
  const personasFile = readJson('data/context/personas.json');

  const { seeds, partial: seedPartial } = deriveSeeds({
    leaks: leaksFeed?.leaks ?? null,
    personas: personasFile?.personas ?? personasFile ?? null,
  });
  let partial = seedPartial;

  // No seeds is not an error — log and leave every artifact untouched. Writing an
  // empty artifact would overwrite a good one from a previous run with nothing.
  if (seeds.length === 0) {
    console.log('  demand-miner: no seeds available from either source — nothing to harvest, leaving artifacts untouched.');
    return { questions: [], partial, seedCount: 0 };
  }

  // Per-seed degradation, as the VOC agent does: one bad SERP must not lose the run.
  const harvest = [];
  for (const seed of seeds) {
    try {
      const { paa = [], relatedSearches = [] } = await getSerpResults(seed.text);
      harvest.push({ seed, paa, relatedSearches });
    } catch (err) {
      console.warn(`  seed "${seed.text}" failed: ${err.message} — skipping`);
      partial = true;
    }
  }

  const records = normalizeHarvest(harvest);
  const staged = validateQuestions(await classifyStages({ anthropic, records }));

  // Both artifacts render fully in memory BEFORE the first write, so a renderer throw
  // cannot leave one file new and the other stale.
  const payload = {
    generated_at: now,
    cluster: CLUSTER,
    seed_count: seeds.length,
    partial,
    questions: staged,
  };
  const json = JSON.stringify(payload, null, 2);
  const md = renderDemandQuestionsMarkdown({
    questions: staged, generatedAt: now, cluster: CLUSTER, seedCount: seeds.length, partial,
  });
  writeArtifacts({ json, md });

  return { questions: staged, partial, seedCount: seeds.length };
}

// ── real dependency wiring ───────────────────────────────────────────────────

function realReadJson(relativePath, root = ROOT) {
  try {
    const raw = readFileSync(join(root, relativePath), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Writes both context artifacts plus a dated run record. Takes only the two
 * already-rendered strings the injectable core produces — it parses `json`
 * back out for the metadata the run record needs (date, seed/question counts)
 * rather than accepting a second, separately-shaped argument, so there is
 * exactly one place the envelope shape is assembled.
 */
function realWriteArtifacts({ json, md }, root = ROOT) {
  const contextDir = join(root, CONTEXT_DIR);
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, 'demand-questions.json'), json, 'utf8');
  writeFileSync(join(contextDir, 'demand-questions.md'), md, 'utf8');

  const payload = JSON.parse(json);
  const day = (payload.generated_at && String(payload.generated_at).slice(0, 10)) || 'unknown-date';

  const reportDir = join(root, REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  const runRecord = {
    generated_at: payload.generated_at,
    cluster: payload.cluster,
    seed_count: payload.seed_count,
    partial: payload.partial,
    question_count: payload.questions.length,
  };
  writeFileSync(join(reportDir, `seeds-${day}.json`), JSON.stringify(runRecord, null, 2), 'utf8');
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify(runRecord, null, 2), 'utf8');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const e = loadEnv();
    const anthropic = new Anthropic({ apiKey: e.ANTHROPIC_API_KEY });

    console.log('demand-miner: running…');
    const result = await runDemandMiner({
      getSerpResults,
      anthropic,
      readJson: (p) => realReadJson(p),
      writeArtifacts: (files) => realWriteArtifacts(files),
      now: new Date().toISOString(),
    });

    if (result.seedCount === 0) {
      console.log('  demand-miner: no seeds available — skipped this cycle.');
      await notify({
        subject: 'Demand miner skipped — no seeds available',
        body: 'Neither GSC impression leaks nor persona objections were available, so there '
          + 'was nothing to harvest. data/context/demand-questions.{json,md} were left untouched.',
        status: 'info',
        category: 'demand-miner',
      });
      return;
    }

    console.log(`  demand-miner: ${result.questions.length} questions from ${result.seedCount} seeds`
      + `${result.partial ? ' (PARTIAL)' : ''}`);
    console.log(`  wrote ${join(CONTEXT_DIR, 'demand-questions.json')}`);
    console.log(`  wrote ${join(CONTEXT_DIR, 'demand-questions.md')}`);

    await notify({
      subject: `Demand miner refreshed — ${result.questions.length} questions`,
      body: `Seeds harvested: ${result.seedCount}${result.partial ? ' (PARTIAL — a source was unavailable or a seed failed)' : ''}.\n`
        + `Questions written: ${result.questions.length}.\n`
        + `Review data/context/demand-questions.md, then git diff data/context/ to see what changed.`,
      status: 'success',
      category: 'demand-miner',
    });
  } catch (err) {
    console.error(`demand-miner failed: ${err.message}`);
    await notify({
      subject: 'Demand miner FAILED',
      body: err.stack || err.message,
      status: 'error',
      category: 'demand-miner',
      immediate: true,
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('demand-miner/index.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
