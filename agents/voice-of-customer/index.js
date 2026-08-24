#!/usr/bin/env node
/**
 * Voice-of-Customer Agent
 *
 * Mines Judge.me reviews and Zigpoll on-site survey verbatims, plus Reddit/SERP
 * friction, into three durable context artifacts that agents and humans read:
 *   data/context/voice-of-customer.md   objections, phrases, triggers, not-for
 *   data/context/personas.md            human-readable persona deck
 *   data/context/personas.json          machine-readable, rank-ordered
 *
 * Scope: the skin cluster only (see SKIN_CLUSTER_HANDLES in lib/voice-of-customer.js).
 * Zigpoll records carry a product TITLE and no handle, so they are scoped by
 * their order through ZIGPOLL_CLUSTERS instead — see lib/zigpoll.js.
 *
 * All four sources are best-effort: any one of them failing sets partial=true
 * on the corpus rather than failing the run.
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
  fetchResponses as fetchZigpollResponses,
  responseText as zigpollResponseText,
  lineItemTitles as zigpollLineItemTitles,
} from '../../lib/zigpoll.js';
import {
  AWARENESS_LEVELS,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  normalizeZigpollResponse,
  zigpollOrderInScope,
  dedupeRecords,
  filterSkinCluster,
  validateAnalysis,
  findUnsourcedQuotes,
  rankPersonas,
  sanitizePersonas,
  formatPersonaDrops,
  renderPersonasMarkdown,
  renderVoiceOfCustomerMarkdown,
} from '../../lib/voice-of-customer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORT_DIR = join('data', 'reports', 'voice-of-customer');
const CONTEXT_DIR = join('data', 'context');

const MODEL = 'claude-opus-5';

/**
 * Where the objections actually live — our own reviews are 4.68 stars.
 *
 * These run against Tavily scoped to REDDIT_DOMAINS. The queries used to carry
 * a literal "reddit " prefix instead, which is a search term and not a filter:
 * it pulled back the Reddit Wikipedia article, the Reddit iOS App Store page
 * and YouTube videos, all of which the analysis prompt then weighted as forum
 * friction. Broad-web coverage comes from the DataForSEO SERP pass below.
 */
export const REDDIT_DOMAINS = ['reddit.com'];

export const EXTERNAL_QUERIES = [
  'natural deodorant coconut oil lotion does it actually work',
  'coconut oil lotion clogged pores breakout',
  'sensitive skin natural lotion eczema what worked',
  'natural bar soap dry skin stripping',
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
export async function collectCorpus({ env, root = ROOT, deps = {} } = {}) {
  const {
    fetchReviews = fetchAllReviews,
    searchTavily = searchWeb,
    fetchSerp = getSerpResults,
    fetchZigpoll = fetchZigpollResponses,
  } = deps;
  const e = env || loadEnv(root);
  const records = [];
  let partial = false;

  const shop = e.JUDGEME_SHOP_DOMAIN || 'realskincare-com.myshopify.com';
  const reviews = await fetchReviews(shop, e.JUDGEME_API_TOKEN);
  console.log(`  judge.me: ${reviews.length} reviews with bodies`);
  records.push(...reviews.map(normalizeJudgemeReview));

  // Zigpoll — the only first-party source that hears from a buyer who did NOT
  // write a review, and the only one carrying acquisition context ("how did you
  // hear about us?") in the customer's own words. Judge.me is retention voice;
  // this is closer to acquisition voice.
  //
  // Best-effort like every other external source: a missing key or a failed
  // request degrades the corpus to partial rather than failing the run, matching
  // how Tavily and DataForSEO are already handled.
  const zigpollKey = e.ZIGPOLL_API_TOKEN || process.env.ZIGPOLL_API_TOKEN;
  if (!zigpollKey) {
    console.warn('  no ZIGPOLL_API_TOKEN — skipping survey responses');
    partial = true;
  } else {
    try {
      const responses = await fetchZigpoll({
        apiKey: zigpollKey,
        accountId: e.ZIGPOLL_ACCOUNT_ID || undefined,
      });
      let kept = 0;
      let outOfScope = 0;
      let unscoped = 0;
      for (const r of responses) {
        const text = zigpollResponseText(r);
        if (!text) continue;
        const titles = zigpollLineItemTitles(r);
        // Counted separately because they mean different things: "bought a
        // product we don't cover" is a real exclusion, "no order attached" is a
        // limitation of scoping by order (see zigpollOrderInScope). Collapsing
        // them into one number would hide the exit-intent corpus growing.
        if (titles.length === 0) { unscoped++; continue; }
        if (!zigpollOrderInScope(titles)) { outOfScope++; continue; }
        records.push(normalizeZigpollResponse(r, text));
        kept++;
      }
      console.log(
        `  zigpoll: ${kept} in-scope verbatims `
        + `(${outOfScope} other-cluster, ${unscoped} no order attached, ${responses.length} fetched)`,
      );
    } catch (err) {
      console.warn(`  zigpoll failed: ${err.message}`);
      partial = true;
    }
  }

  const tavilyKey = e.TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    console.warn('  no TAVILY_API_KEY — skipping Reddit collection');
    partial = true;
  } else {
    // lib/tavily.js swallows every failure and returns [] — a bad key, a 401 or
    // a network outage all look like "no results". So the honest signal is the
    // record count, not an exception. The try/catch stays for a future
    // implementation that throws.
    let tavilyRecords = 0;
    for (const query of EXTERNAL_QUERIES) {
      try {
        const results = await searchTavily(tavilyKey, query, {
          maxResults: 6,
          includeDomains: REDDIT_DOMAINS,
        });
        const mapped = (results || []).map(normalizeTavilyResult);
        tavilyRecords += mapped.length;
        records.push(...mapped);
      } catch (err) {
        console.warn(`  tavily "${query}" failed: ${err.message}`);
        partial = true;
      }
    }
    if (tavilyRecords === 0) {
      console.warn('  tavily returned 0 records across all queries — treating the corpus as partial');
      partial = true;
    }
  }

  for (const keyword of SERP_KEYWORDS) {
    try {
      const result = await fetchSerp(keyword, 10);
      records.push(...((result && result.organic) || []).map(normalizeSerpItem));
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
    '  zigpoll — free text a buyer typed into our own on-site survey, most of it',
    '            answering "how did you hear about us?" right after checkout. Short,',
    '            unpolished and often a bare channel name — that is the format, not a',
    '            weak signal. It is the best evidence for trigger_points and for how',
    '            buyers FIND us, and it is thin evidence for objections, because these',
    '            people had already bought when they wrote it.',
    '  reddit  — an outside discussion thread on reddit.com (where the real objections live)',
    '  web     — another outside page returned by the same search; weigh it on its merits',
    '  serp    — a Google page-1 result a first-time buyer would hit',
    '',
    'Produce:',
    '  1. personas — 3 to 5 distinct buyer personas, each with 2-3 angles.',
    '  2. objections — what stops people buying. Weight the outside records (reddit, web, serp)',
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
    '  HEALTH-CLAIM RULE — this one is enforced, not advisory. personas.json is copy input:',
    '  its persona `name`/`summary` and its angle `label`/`objection_addressed`/`proof`/',
    '  `hook_examples` are pasted straight into ad-copy prompts for a COSMETIC brand. Any of',
    '  those fields that names a disease (eczema, psoriasis, dermatitis, rosacea, acne,',
    '  infection, wound...), names a drug or prescription treatment (steroids, cortisone,',
    '  prescription, medicated, over-the-counter...), claims to heal/cure/treat/prevent/remedy,',
    '  or asserts clinical, dermatologist or FDA backing WILL BE DELETED before the file is',
    '  written — the angle, or the whole persona if it is the name or summary. Say the same',
    '  thing in cosmetic terms instead: "already tried everything and nothing worked",',
    '  "chronically dry, itchy, cracked skin", "went from reapplying hourly to twice a day".',
    '  `source_quotes` is the ONE exception and stays verbatim — it is the evidence record,',
    '  not copy, so quote the reviewer exactly there and never launder a quote to survive',
    '  this rule.',
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
    if (check.ok) {
      // Provenance is structural, not a matter of the model having obeyed the
      // prompt: every quote must be findable in the corpus we handed it.
      const unsourced = findUnsourcedQuotes(parsed, corpus);
      if (unsourced.length === 0) return { analysis: parsed, partial: corpus.partial };
      lastErrors = unsourced.map((u) => `unsourced quote at ${u.location}: "${u.quote}"`);
      console.warn(`  attempt ${attempt} produced ${unsourced.length} unsourced quote(s):`);
      unsourced.forEach((u) => console.warn(`    ${u.location}: "${u.quote}"`));
      continue;
    }
    lastErrors = check.errors;
    console.warn(`  attempt ${attempt} failed validation: ${check.errors.slice(0, 3).join('; ')}`);
  }

  throw new Error(`voice-of-customer: analysis failed validation twice — ${lastErrors.join('; ')}`);
}

// ── artifacts ────────────────────────────────────────────────────────────────

/**
 * WHY THE SANITIZE IS HERE AND NOT A RETRY.
 *
 * runAnalysis retries on invalid or unsourced output, but the retry sends the SAME
 * prompt with no feedback about what went wrong — it is a re-roll, not a correction.
 * Health claims in the persona fields are not a random slip: the corpus is full of
 * reviewers saying "eczema" and "steroids", so the model reaching for that language is
 * systematic and a re-roll at Opus prices has no particular reason to come back clean.
 * So prevention goes in the prompt (see buildAnalysisPrompt's HEALTH-CLAIM RULE) and
 * enforcement is deterministic here: remove, never rewrite. Rewriting a violating angle
 * — by a second LLM call or by snipping the offending clause — would have this agent
 * inventing research to fill the hole, which is worse than losing an angle. The loss is
 * loud: it is printed, notified, and recorded in personas.json itself.
 *
 * Applied to `analysis.personas` ONCE, before either renderer runs, so personas.json and
 * personas.md cannot disagree about what survived.
 */
export function writeArtifacts({ analysis, corpus, root = ROOT }) {
  const contextDir = join(root, CONTEXT_DIR);
  mkdirSync(contextDir, { recursive: true });

  const { personas: safePersonas, drops } = sanitizePersonas(analysis.personas || []);
  if (drops.length) {
    console.warn(`  ${drops.length} health-claim violation(s) removed from the persona set:`);
    console.warn(formatPersonaDrops(drops));
  }
  if (!safePersonas.length) {
    throw new Error(
      `voice-of-customer: every persona carried a health claim in a copy-facing field, so nothing ` +
      `is safe to write. Refusing to overwrite data/context/ with an empty persona set — last ` +
      `month's artifacts stay in place.\n${formatPersonaDrops(drops)}`
    );
  }
  // Both renderers read the sanitized set. renderPersonasMarkdown takes the whole
  // analysis object, so hand it a shallow copy with the personas swapped rather than
  // mutating the caller's analysis.
  const safeAnalysis = { ...analysis, personas: safePersonas };

  const day = corpus.generated_at.slice(0, 10);
  const personasJson = {
    generated_at: corpus.generated_at,
    corpus_ref: `corpus-${day}.json`,
    cluster: corpus.cluster,
    partial: corpus.partial,
    // Recorded in the artifact, not only in the log: a month from now the only evidence
    // that an angle existed and was removed is this file. Additive key — every consumer
    // reads `.personas` and `.cluster` and ignores the rest.
    health_claim_drops: drops,
    personas: rankPersonas(safePersonas),
  };

  const personasJsonPath = join(contextDir, 'personas.json');
  const personasMdPath = join(contextDir, 'personas.md');
  const vocMdPath = join(contextDir, 'voice-of-customer.md');

  // Render everything before writing anything. A throw inside the second
  // renderer used to leave personas.json fresh and the two markdown files from
  // last month — three artifacts that are supposed to agree, silently skewed.
  const personasJsonBody = JSON.stringify(personasJson, null, 2);
  const personasMdBody = renderPersonasMarkdown(safeAnalysis);
  const vocMdBody = renderVoiceOfCustomerMarkdown(safeAnalysis, { partial: corpus.partial });

  writeFileSync(personasJsonPath, personasJsonBody, 'utf8');
  writeFileSync(personasMdPath, personasMdBody, 'utf8');
  writeFileSync(vocMdPath, vocMdBody, 'utf8');

  const reportDir = join(root, REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify({
    generated_at: corpus.generated_at,
    partial: corpus.partial,
    record_count: corpus.records.length,
    persona_count: personasJson.personas.length,
    objection_count: (analysis.objections || []).length,
    health_claim_drops: drops.length,
  }, null, 2), 'utf8');

  return { personasJsonPath, personasMdPath, vocMdPath, personaCount: personasJson.personas.length, drops };
}

// ── failure detection ────────────────────────────────────────────────────────

/**
 * An empty review corpus is a failure, not a quiet no-op.
 *
 * fetchAllReviews warns and returns [] on an HTTP error, so an expired
 * JUDGEME_API_TOKEN is indistinguishable from "the store has no reviews".
 * Returning quietly there meant exit 0, a "✓ complete" line in the scheduler
 * log, no notify() at all, and three context artifacts silently frozen for
 * however many months it took someone to notice.
 *
 * Returned as data rather than sent from here so it is testable without
 * touching Resend.
 *
 * @returns {{subject: string, body: string}|null} null when the corpus is fine
 */
export function emptyCorpusFailure(corpus) {
  const reviews = ((corpus && corpus.records) || []).filter((r) => r.source === 'judgeme').length;
  if (reviews > 0) return null;
  return {
    subject: 'Voice-of-customer FAILED — empty review corpus',
    body: 'The corpus came back with ZERO Judge.me reviews. That is almost certainly a '
      + 'credential or API failure — check JUDGEME_API_TOKEN and the Judge.me API — not a '
      + 'store without reviews. Skipping the LLM call; data/context/voice-of-customer.md, '
      + 'personas.md and personas.json were NOT refreshed and are now stale.',
  };
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

    const emptyFailure = emptyCorpusFailure(corpus);
    if (emptyFailure) {
      console.error(`  ${emptyFailure.body}`);
      await notify({ ...emptyFailure, status: 'error', category: 'voice-of-customer', immediate: true });
      process.exitCode = 1;
      return;
    }

    console.log('voice-of-customer: analyzing…');
    const { analysis } = await runAnalysis({ corpus });
    const paths = writeArtifacts({ analysis, corpus });
    console.log(`  wrote ${paths.personasJsonPath}`);
    console.log(`  wrote ${paths.personasMdPath}`);
    console.log(`  wrote ${paths.vocMdPath}`);

    await notify({
      subject: `Voice-of-customer refreshed — ${paths.personaCount} personas`,
      body: `Corpus: ${corpus.records.length} records${corpus.partial ? ' (PARTIAL — external sources incomplete)' : ''}.\n`
          + `Personas: ${paths.personaCount} written of ${analysis.personas.length} produced. `
          + `Objections: ${(analysis.objections || []).length}.\n`
          // Never a silent loss: an angle removed here is an angle the ad pipeline can
          // never brief, and the whole persona can go with it.
          + (paths.drops.length
            ? `\nHEALTH-CLAIM REMOVALS — ${paths.drops.length}. A cosmetic may not name a disease, a\n`
              + `drug, or claim to treat/heal/cure/prevent, so these were deleted before writing:\n`
              + `${formatPersonaDrops(paths.drops)}\n\n`
            : '')
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
      immediate: true,
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('voice-of-customer/index.js')) {
  main();
}
