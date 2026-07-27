#!/usr/bin/env node
/**
 * Voice-of-Customer Agent
 *
 * Mines Judge.me reviews plus Reddit/SERP friction into three durable context
 * artifacts that agents and humans read:
 *   data/context/voice-of-customer.md   objections, phrases, triggers, not-for
 *   data/context/personas.md            human-readable persona deck
 *   data/context/personas.json          machine-readable, rank-ordered
 *
 * Scope: the skin cluster only (see SKIN_CLUSTER_HANDLES in lib/voice-of-customer.js).
 *
 * Usage:
 *   node agents/voice-of-customer/index.js              # collect + analyze
 *   node agents/voice-of-customer/index.js --collect    # refresh the corpus only
 *   node agents/voice-of-customer/index.js --analyze    # re-synthesize from cache
 *
 * Spec: docs/superpowers/specs/2026-07-26-voice-of-customer-agent-design.md
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { fetchAllReviews } from '../../lib/judgeme.js';
import { searchWeb } from '../../lib/tavily.js';
import { getSerpResults } from '../../lib/dataforseo.js';
import { notify } from '../../lib/notify.js';
import {
  AWARENESS_LEVELS,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  dedupeRecords,
  filterSkinCluster,
  validateAnalysis,
  rankPersonas,
  renderPersonasMarkdown,
  renderVoiceOfCustomerMarkdown,
} from '../../lib/voice-of-customer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORT_DIR = join('data', 'reports', 'voice-of-customer');
const CONTEXT_DIR = join('data', 'context');

const MODEL = 'claude-opus-5';

/** Where the objections actually live — our own reviews are 4.68 stars. */
export const EXTERNAL_QUERIES = [
  'reddit natural deodorant coconut oil lotion does it actually work',
  'reddit coconut oil lotion clogged pores breakout',
  'reddit sensitive skin natural lotion eczema what worked',
  'reddit natural bar soap dry skin stripping',
  'is coconut oil lotion worth it review complaints',
  'natural body lotion greasy absorbs slowly problem',
];

const SERP_KEYWORDS = [
  'coconut oil lotion',
  'natural body lotion sensitive skin',
  'natural bar soap dry skin',
];

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

// ── collect ──────────────────────────────────────────────────────────────────

/**
 * Build the corpus. External sources are best-effort: if Tavily or DataForSEO
 * fail we degrade to Judge.me-only and set partial=true rather than silently
 * shipping a thin corpus as a full one.
 */
export async function collectCorpus({ env, root = ROOT } = {}) {
  const e = env || loadEnv(root);
  const records = [];
  let partial = false;

  const shop = e.JUDGEME_SHOP_DOMAIN || 'realskincare-com.myshopify.com';
  const reviews = await fetchAllReviews(shop, e.JUDGEME_API_TOKEN);
  console.log(`  judge.me: ${reviews.length} reviews with bodies`);
  records.push(...reviews.map(normalizeJudgemeReview));

  const tavilyKey = e.TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    console.warn('  no TAVILY_API_KEY — skipping Reddit collection');
    partial = true;
  } else {
    for (const query of EXTERNAL_QUERIES) {
      try {
        const results = await searchWeb(tavilyKey, query, { maxResults: 6 });
        records.push(...(results || []).map(normalizeTavilyResult));
      } catch (err) {
        console.warn(`  tavily "${query}" failed: ${err.message}`);
        partial = true;
      }
    }
  }

  for (const keyword of SERP_KEYWORDS) {
    try {
      const items = await getSerpResults(keyword, 10);
      records.push(...(items || []).map(normalizeSerpItem));
    } catch (err) {
      console.warn(`  dataforseo "${keyword}" failed: ${err.message}`);
      partial = true;
    }
  }

  const clean = filterSkinCluster(dedupeRecords(records)).filter((r) => r.text);
  console.log(`  corpus: ${clean.length} records (partial=${partial})`);

  return {
    generated_at: new Date().toISOString(),
    cluster: 'skin',
    partial,
    records: clean,
  };
}

export function writeCorpus(corpus, { root = ROOT } = {}) {
  const dir = join(root, REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const day = corpus.generated_at.slice(0, 10);
  const path = join(dir, `corpus-${day}.json`);
  writeFileSync(path, JSON.stringify(corpus, null, 2), 'utf8');
  return path;
}

export function readLatestCorpus({ root = ROOT } = {}) {
  const dir = join(root, REPORT_DIR);
  if (!existsSync(dir)) throw new Error(`No corpus cached in ${REPORT_DIR} — run with --collect first.`);
  const files = readdirSync(dir).filter((f) => f.startsWith('corpus-') && f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No corpus cached in ${REPORT_DIR} — run with --collect first.`);
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
}

// ── analyze ──────────────────────────────────────────────────────────────────

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['personas', 'objections', 'golden_nugget_phrases', 'trigger_points', 'not_for'],
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'summary', 'evidence_count', 'emotional_intensity', 'angles'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          summary: { type: 'string' },
          evidence_count: { type: 'integer' },
          emotional_intensity: { type: 'number' },
          angles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'awareness', 'objection_addressed', 'proof', 'hook_examples', 'source_quotes'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                awareness: { type: 'string', enum: AWARENESS_LEVELS },
                objection_addressed: { type: 'string' },
                proof: { type: 'string' },
                hook_examples: { type: 'array', items: { type: 'string' } },
                source_quotes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    ...Object.fromEntries(
      ['objections', 'golden_nugget_phrases', 'trigger_points', 'not_for'].map((key) => [
        key,
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'evidence_count', 'quote'],
            properties: {
              text: { type: 'string' },
              evidence_count: { type: 'integer' },
              quote: { type: 'string' },
            },
          },
        },
      ]),
    ),
  },
};

export function buildAnalysisPrompt(corpus) {
  const lines = [
    'You are a creative strategist doing voice-of-customer research for Real Skin Care,',
    'a natural body-care brand (realskincare.com). Below is the complete research corpus',
    'for the skin cluster: coconut lotion, body lotion, coconut moisturizer, coconut bar',
    'soap, and organic foaming hand soap.',
    '',
    'Each record is labelled with its source:',
    '  judgeme — one of our own verified customer reviews (survivor-biased, 4.68 avg)',
    '  reddit  — an outside discussion thread (where the real objections live)',
    '  serp    — a Google page-1 result a first-time buyer would hit',
    '',
    'Produce:',
    '  1. personas — 3 to 5 distinct buyer personas, each with 2-3 angles.',
    '  2. objections — what stops people buying. Weight the reddit and serp records',
    '     heavily here; our own reviews are from people who already bought and stayed.',
    '  3. golden_nugget_phrases — striking customer language worth putting in an ad verbatim.',
    '  4. trigger_points — what makes someone finally buy.',
    '  5. not_for — who this product genuinely is not for.',
    '',
    'Rules:',
    '  - Every quote you output must be VERBATIM from a record below. Never invent,',
    '    paraphrase, or compose a quote. If you cannot find a real quote, omit the entry.',
    '  - evidence_count is how many records support that entry.',
    '  - emotional_intensity (0-10) rates how affect-laden the persona\'s source language is,',
    '    independently of how often it appears. A persona voiced by 12 people in anguished',
    '    terms scores higher than one voiced by 40 people flatly.',
    '  - Each angle gets an awareness level from: ' + AWARENESS_LEVELS.join(', ') + '.',
    '  - Write every entry so it stands alone: someone reading that one line, with no',
    '    surrounding context, should understand it. Do not refer to a previous entry.',
    '',
    `CORPUS (${corpus.records.length} records${corpus.partial ? ', PARTIAL — external sources incomplete' : ''}):`,
    '',
  ];

  corpus.records.forEach((r, i) => {
    const meta = [r.source, r.handle, r.rating ? `${r.rating}star` : null].filter(Boolean).join(' | ');
    lines.push(`[${i + 1}] (${meta}) ${r.text}`);
  });

  return lines.join('\n');
}

/**
 * One Claude call over the whole corpus. Validates, retries once, then throws.
 * A max_tokens stop means the JSON is truncated — fatal, never save.
 */
export async function runAnalysis({ corpus, client, root = ROOT }) {
  const e = loadEnv(root);
  const anthropic = client || new Anthropic({ apiKey: e.ANTHROPIC_API_KEY });
  const prompt = buildAnalysisPrompt(corpus);

  let lastErrors = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
      messages: [{ role: 'user', content: prompt }],
    });

    if (res.stop_reason === 'max_tokens') {
      throw new Error('voice-of-customer: response hit max_tokens — output is truncated, not saving.');
    }

    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      lastErrors = [`JSON.parse failed: ${err.message}`];
      continue;
    }

    const check = validateAnalysis(parsed);
    if (check.ok) return { analysis: parsed, partial: corpus.partial };
    lastErrors = check.errors;
    console.warn(`  attempt ${attempt} failed validation: ${check.errors.slice(0, 3).join('; ')}`);
  }

  throw new Error(`voice-of-customer: analysis failed validation twice — ${lastErrors.join('; ')}`);
}

// ── artifacts ────────────────────────────────────────────────────────────────

export function writeArtifacts({ analysis, corpus, root = ROOT }) {
  const contextDir = join(root, CONTEXT_DIR);
  mkdirSync(contextDir, { recursive: true });

  const day = corpus.generated_at.slice(0, 10);
  const personasJson = {
    generated_at: corpus.generated_at,
    corpus_ref: `corpus-${day}.json`,
    cluster: corpus.cluster,
    partial: corpus.partial,
    personas: rankPersonas(analysis.personas),
  };

  const personasJsonPath = join(contextDir, 'personas.json');
  const personasMdPath = join(contextDir, 'personas.md');
  const vocMdPath = join(contextDir, 'voice-of-customer.md');

  writeFileSync(personasJsonPath, JSON.stringify(personasJson, null, 2), 'utf8');
  writeFileSync(personasMdPath, renderPersonasMarkdown(analysis), 'utf8');
  writeFileSync(vocMdPath, renderVoiceOfCustomerMarkdown(analysis, { partial: corpus.partial }), 'utf8');

  const reportDir = join(root, REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify({
    generated_at: corpus.generated_at,
    partial: corpus.partial,
    record_count: corpus.records.length,
    persona_count: personasJson.personas.length,
    objection_count: (analysis.objections || []).length,
  }, null, 2), 'utf8');

  return { personasJsonPath, personasMdPath, vocMdPath };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const collectOnly = args.includes('--collect');
  const analyzeOnly = args.includes('--analyze');

  try {
    let corpus;
    if (analyzeOnly) {
      corpus = readLatestCorpus();
      console.log(`  reusing cached corpus from ${corpus.generated_at}`);
    } else {
      console.log('voice-of-customer: collecting…');
      corpus = await collectCorpus();
      console.log(`  corpus written to ${writeCorpus(corpus)}`);
    }

    if (collectOnly) return;

    if (corpus.records.filter((r) => r.source === 'judgeme').length === 0) {
      console.log('  no reviews in corpus — skipping the LLM call.');
      return;
    }

    console.log('voice-of-customer: analyzing…');
    const { analysis } = await runAnalysis({ corpus });
    const paths = writeArtifacts({ analysis, corpus });
    console.log(`  wrote ${paths.personasJsonPath}`);
    console.log(`  wrote ${paths.personasMdPath}`);
    console.log(`  wrote ${paths.vocMdPath}`);

    await notify({
      subject: `Voice-of-customer refreshed — ${analysis.personas.length} personas`,
      body: `Corpus: ${corpus.records.length} records${corpus.partial ? ' (PARTIAL — external sources incomplete)' : ''}.\n`
          + `Personas: ${analysis.personas.length}. Objections: ${(analysis.objections || []).length}.\n`
          + `Review data/context/personas.md, then git diff data/context/ to see what changed.`,
      status: 'success',
      category: 'voice-of-customer',
    });
  } catch (err) {
    console.error(`voice-of-customer failed: ${err.message}`);
    await notify({
      subject: 'Voice-of-customer FAILED',
      body: err.stack || err.message,
      status: 'error',
      category: 'voice-of-customer',
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('voice-of-customer/index.js')) {
  main();
}
