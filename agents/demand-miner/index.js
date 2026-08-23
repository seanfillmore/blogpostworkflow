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
 *   node agents/demand-miner/index.js --limit 5
 *
 * --limit <n> caps how many seeds this run harvests (one paid DataForSEO SERP call
 * each), for a cheap rehearsal of a first/real run — the classification-call and
 * merge failure modes fixed in the 2026-08-21 review (max_tokens truncation, a
 * text-keyed merge) only surface at the ~200-400-question scale a real 40-seed run
 * produces, not at the 1-question scale the test suite uses. It CLAMPS, never
 * raises: a value above SEED_CAP (40, in lib/demand-questions.js) is silently capped
 * at 40 rather than honored, so a mistyped --limit can never spend more than the
 * hard ceiling already allows. The cap itself has no override — this is a per-run
 * CLI flag read here in the shell, not a change to SEED_CAP.
 *
 * The SUCCESS notify (only) carries a metrics block (see renderRunMetrics below)
 * answering two questions this agent shipped with deliberately open, so the first
 * real run settles them from evidence rather than more guessing: how much the
 * skin-cluster leak filter drops and whether the drops look like genuine top-of-funnel
 * phrasing (a dropped-query sample), and whether the LLM stage-classification response
 * ever names the same [n] index twice (a silent Map.set overwrite classifyStages now
 * counts but still does not reject — see its docstring).
 *
 * Spec: docs/superpowers/specs/2026-08-21-demand-miner-design.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { getSerpResults } from '../../lib/dataforseo.js';
import { notify as realNotify } from '../../lib/notify.js';
import { AWARENESS_LEVELS, sanitizePersonas, formatPersonaDrops } from '../../lib/voice-of-customer.js';
import { overlayPersonas } from '../../lib/operator-angles.js';
import {
  SEED_CAP,
  SKIN_LEAK_CLUSTERS,
  deriveSeeds,
  normalizeHarvest,
  validateQuestions,
  renderDemandQuestionsMarkdown,
  filterLeaksToSkinClusterDetailed,
} from '../../lib/demand-questions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONTEXT_DIR = join('data', 'context');
const REPORT_DIR = join('data', 'reports', 'demand-miner');

// The artifact's `clusters` field, sourced from SKIN_LEAK_CLUSTERS rather than
// hardcoded — a single `cluster: "skin"` string used to stand in for this and went
// stale the moment SKIN_LEAK_CLUSTERS grew past lotion+soap (see its docstring).
// IMPORTANT ASYMMETRY: this only bounds GSC-LEAK-origin seeds (filterLeaksToSkinCluster
// below). Persona-objection seeds are scoped separately and more narrowly — always
// lotion+soap, via voice-of-customer's SKIN_CLUSTER_HANDLES — because personas.json
// is voice-of-customer's lotion+soap research, unaffected by this list. A run can
// therefore legitimately contain seed_origin: "gsc_leak" questions about deodorant or
// lip balm alongside seed_origin: "persona_objection" questions that never do. Both
// artifacts (JSON `clusters` and the markdown header) carry a note pointing a reader at
// each question's own `seed_origin` rather than let them assume every cluster listed
// here applies to every question.
const CLUSTERS = SKIN_LEAK_CLUSTERS;
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
 *
 * `index` rather than `text`: the merge used to key on the model's echoed
 * question text (`q.text.trim().toLowerCase()`), which breaks the moment the
 * model keeps the `[1] ` prompt prefix, normalizes a curly apostrophe to a
 * straight one (common in PAA text), or collapses internal whitespace
 * differently than `normalizeHarvest` does. Every one of those is a silent,
 * total miss — the retry produces the same mismatch and the run throws after
 * the 40 paid SERP calls are already spent. The prompt already numbers every
 * question `[n]`, so asking for the number back and merging positionally is
 * both simpler and immune to any text transformation the model applies.
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
        required: ['index', 'stage'],
        properties: {
          index: { type: 'integer' },
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
    '  { "questions": [ { "index": <the question\'s [n] number below>, "stage": "<one of the levels above>" }, ... ] }',
    'Return one entry for every question below, identified by its [n] index number — do NOT echo',
    'the question text back. No prose, no markdown fence.',
    '',
    'QUESTIONS:',
  ];
  records.forEach((r, i) => lines.push(`[${i + 1}] ${r.text}`));
  return lines.join('\n');
}

/**
 * The one LLM call. Sends the deduped question texts, asks for a stage per
 * question, parses the JSON response, and merges each returned `stage` back
 * onto its record POSITIONALLY by the `[n]` index the prompt assigned — never
 * by echoed text (see the CLASSIFY_SCHEMA docstring below for why).
 *
 * Retries exactly once on malformed or schema-violating output (bad JSON, a
 * missing `questions` array, an entry missing `index`/`stage`, an
 * out-of-range index, or a response that doesn't cover every question), then
 * throws. This is a structural
 * check only — it does NOT validate that `stage` is one of the five funnel
 * levels; that is validateQuestions' job, run by the caller straight after,
 * so both checks stay single-purpose and neither silently overlaps the other.
 *
 * The retry is logged so a recurring parse failure is visible in the digest
 * rather than silent.
 *
 * max_tokens is 16000, matching agents/voice-of-customer/index.js:316 on the
 * same model family. A real 40-seed run harvests roughly 200-400 deduped
 * questions (a PAA box yields ~4, a related-searches box ~8), and each
 * response entry costs ~22-25 output tokens plus schema/reasoning overhead —
 * 4000 was sized against a one-question test fixture and would truncate on
 * the first real run, after all 40 paid SERP calls were already spent.
 *
 * stop_reason === 'max_tokens' is checked BEFORE the parse and throws
 * immediately rather than retrying: a truncated response cannot become valid
 * JSON on a second attempt with the same input and the same ceiling, so
 * retrying into the same wall would just spend a second call to fail the
 * same way. This mirrors agents/voice-of-customer/index.js:324-325 and the
 * blog-post-writer checklist in CLAUDE.md, which both treat max_tokens as
 * fatal-not-retryable for the same reason: the alternative is a JSON.parse
 * error that blames the model's formatting instead of naming the real cause.
 *
 * Returns `{ records, duplicateIndexCount }`, not a bare array — demand-miner's
 * second open question is whether the model ever names the same `[n]` index twice
 * in one response. The merge below has always keyed onto a `Map`, so a repeated
 * index has always silently overwritten via `Map.set` (last value wins) rather than
 * being rejected — `validateQuestions` can't catch it because both the earlier and
 * the later entry are individually valid. That merge behavior is UNCHANGED here: this
 * only counts how many times it happened, in the same pass that already walks
 * `parsed.questions` to build `stageByIndex`, so the notify can report whether
 * it ever actually occurs in practice. It does not reject, warn mid-loop, or alter
 * which value wins.
 */
export async function classifyStages({ anthropic, records }) {
  if (records.length === 0) return { records: [], duplicateIndexCount: 0 };
  const prompt = buildClassifyPrompt(records);

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16000,
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

    if (res.stop_reason === 'max_tokens') {
      throw new Error(
        `demand-miner: LLM stage classification hit max_tokens on attempt ${attempt} — output is `
        + 'truncated, not a formatting problem. Not retrying: the same input and ceiling would '
        + 'truncate identically.',
      );
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

    // Merge POSITIONALLY by the [n] index the prompt assigned, never by echoed text —
    // see the CLASSIFY_SCHEMA docstring above for why a text-keyed merge is fragile.
    // Any index outside 1..records.length is treated as shape-invalid too: a real
    // model response never has a reason to name an index that wasn't offered, so
    // tolerating it would just mask the same kind of malformed output text-keying let
    // slip through this schema's predecessor.
    const stageByIndex = new Map();
    let shapeOk = true;
    let duplicateIndexCount = 0;
    for (const q of parsed.questions) {
      if (
        !q
        || typeof q.index !== 'number'
        || !Number.isInteger(q.index)
        || q.index < 1
        || q.index > records.length
        || typeof q.stage !== 'string'
      ) { shapeOk = false; break; }
      // Count BEFORE the overwrite, not after — this must count collisions, not
      // just track "have we seen this index at all" (which stageByIndex.has already
      // does for other purposes). Merge behavior is untouched: the Map.set below
      // still runs unconditionally, so a later duplicate still wins, exactly as
      // before this counter existed.
      if (stageByIndex.has(q.index)) duplicateIndexCount += 1;
      stageByIndex.set(q.index, q.stage);
    }
    if (!shapeOk) {
      lastError = new Error('a question entry was missing "index"/"stage" or carried an out-of-range index');
      console.warn(`  demand-miner: attempt ${attempt} was schema-invalid (missing/out-of-range index or stage) — retrying`);
      continue;
    }

    const missing = [];
    for (let i = 1; i <= records.length; i++) {
      if (!stageByIndex.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      lastError = new Error(`LLM response is missing a stage for ${missing.length} of ${records.length} question(s) (indices: ${missing.join(', ')})`);
      console.warn(`  demand-miner: attempt ${attempt} did not classify every question — retrying`);
      continue;
    }

    return {
      records: records.map((r, i) => ({ ...r, stage: stageByIndex.get(i + 1) })),
      duplicateIndexCount,
    };
  }

  throw new Error(`demand-miner: LLM stage classification failed twice — ${lastError ? lastError.message : 'unknown error'}`);
}

// ── the injectable core ──────────────────────────────────────────────────────

/**
 * The injectable core. Every dependency is a parameter, so the smoke test needs no
 * network, no LLM and no filesystem. main() below wires the real ones.
 *
 * `notify` defaults to the real `lib/notify.js` sender so main() doesn't have to pass
 * it explicitly, but stays overridable — the degraded-harvest guard below sends one,
 * and a test must be able to intercept it without risking a real email.
 *
 * `applyPersonaOverlay` defaults to identity so existing callers/tests that don't care
 * about the overlay are unaffected. main() wires the real one: load
 * data/context/operator-angles.json, overlay it onto personas.json, THEN run
 * sanitizePersonas — the same order the other four personas.json readers use (see
 * lib/operator-angles.js). This agent is a fifth reader; skipping either half means
 * a retired angle can still consume a paid seed while an operator-authored
 * replacement is silently never seeded at all.
 *
 * `limit` defaults to undefined (no rehearsal cap — the full SEED_CAP applies via
 * deriveSeeds as before). When given, it trims the already-derived seed list down
 * to at most `limit` entries, clamped so it can never exceed SEED_CAP — see the
 * --limit docs in this file's header. Applied AFTER deriveSeeds, not by changing
 * the cap it enforces internally, so the reserve-then-top-up split (lib/demand-
 * questions.js) is untouched and this stays a pure "harvest fewer of the same
 * seeds" knob rather than a second cap implementation.
 */
export async function runDemandMiner({
  getSerpResults, anthropic, readJson, writeArtifacts, now, notify = realNotify,
  applyPersonaOverlay = (personasData) => personasData,
  sanitizePersonasStep = (personasData) => personasData,
  limit,
}) {
  const leaksFeed = readJson('data/reports/gsc-query-miner/impression-leaks.json');
  // impression-leaks.json is always written by gsc-query-miner as { leaks: [...] } —
  // buildImpressionLeaksFeed's shape is guaranteed by the agent that writes it, so unlike
  // personas.json below there is no bare-array variant to tolerate here.

  // applyPersonaOverlay (the real one, lib/operator-angles.js's overlayPersonas, wired
  // via realOverlayPersonasOnly below) THROWS on a dangling personaId — an authored
  // angle in operator-angles.json naming a persona that no longer exists in
  // personas.json, typically after a monthly voice-of-customer renumbering. That throw
  // is correct and stays a hard failure for the other four personas.json readers
  // (agents/ad-brief, the dashboard's ad-brief route, agents/ad-studio,
  // agents/creative-packager) — they are copy-facing, and silently dropping an
  // authored angle there would hide the operator's replacement copy, the exact hazard
  // the overlay exists to prevent. demand-miner is different: it only SEEDS
  // persona-objection questions from personas.json, it never quotes it as copy, and it
  // runs unattended monthly from cron alongside voice-of-customer, the very job that
  // causes the renumbering. A stale operator-angles.json killing this whole run for a
  // reason unrelated to its own logic would silence the leak half too — so this is the
  // one reader that degrades: drop personas for this run only, keep mining GSC leaks,
  // and surface the failure through notify() rather than an unhandled throw.
  //
  // The try/catch below is scoped to ONLY the overlay step, deliberately: it must not
  // also swallow a failure from sanitizePersonasStep (health-claim withholding — a
  // completely different subsystem, lib/voice-of-customer.js, with its own failure
  // modes). Catching both here would misreport an unrelated sanitize bug as "operator-
  // angles overlay failed" and point the operator at the wrong file to fix. So
  // sanitizePersonasStep runs AFTER this block, outside the try — if it throws, that
  // propagates uncaught to main()'s own catch-all (an immediate, correctly-labeled
  // "Demand miner FAILED" notify), exactly as it would have before this degradation
  // was added.
  let personasFile;
  let overlayFailed = false;
  try {
    personasFile = applyPersonaOverlay(readJson('data/context/personas.json'));
  } catch (err) {
    console.warn(`  demand-miner: operator-angles overlay failed — continuing leaks-only this run: ${err.message}`);
    await notify({
      subject: 'Demand miner: operator-angles overlay failed — ran leaks-only',
      body: `Applying data/context/operator-angles.json to personas.json threw:\n\n${err.message}\n\n`
        + 'This usually means an authored angle in operator-angles.json names a personaId that no '
        + 'longer exists in personas.json — most often because the monthly voice-of-customer run '
        + 'renumbered the personas. Fix or remove the offending entry in '
        + 'data/context/operator-angles.json, then re-run.\n\n'
        + 'This run continued on GSC impression-leak seeds only; persona-objection seeding was '
        + 'skipped entirely for this cycle.',
      status: 'error',
      category: 'demand-miner',
    });
    personasFile = null;
    overlayFailed = true;
  }
  // Outside the try — a throw here is a different bug (sanitizePersonas/lib/voice-of-
  // customer.js) and must surface as itself, not as an operator-angles.json problem.
  personasFile = sanitizePersonasStep(personasFile);

  // Leaks are unfiltered site-wide GSC queries — filter to SKIN_LEAK_CLUSTERS BEFORE
  // deriveSeeds so a run never spends paid seeds mining an excluded cluster (toothpaste,
  // hair, brand, unclustered). See lib/demand-questions.js's filterLeaksToSkinCluster
  // docstring for why, and the CLUSTERS comment above for what this artifact's
  // `clusters` field does and doesn't cover.
  //
  // The _Detailed variant (not filterLeaksToSkinCluster) is used here on purpose: this
  // run's success notify needs to answer "how much did the filter drop, and is it good
  // top-of-funnel phrasing" (demand-miner's first open question), which needs the
  // dropped rows themselves, not just a smaller survivor array. `leaksAfterFilter` is
  // what actually feeds deriveSeeds below — identical to what
  // filterLeaksToSkinCluster(...) would have returned — so this is a reporting-only
  // change, not a change to which leaks get mined.
  const {
    survivors: leaksAfterFilter,
    dropped: leaksDropped,
    total: leaksIn,
  } = filterLeaksToSkinClusterDetailed(leaksFeed?.leaks ?? null);

  const { seeds: derivedSeeds, partial: seedPartial } = deriveSeeds({
    leaks: leaksAfterFilter,
    personas: personasFile?.personas ?? personasFile ?? null,
  });
  const seeds = (typeof limit === 'number' && limit > 0)
    ? derivedSeeds.slice(0, Math.min(limit, SEED_CAP))
    : derivedSeeds;
  // deriveSeeds already sets `partial` when personas is null/empty (no havePersonas),
  // which covers the overlay-failure path above since personasFile is null there — but
  // overlayFailed is OR'd in explicitly too, so this run is unambiguously marked
  // partial even if deriveSeeds' own partial logic ever changes to be less conservative
  // about a missing source.
  let partial = seedPartial || overlayFailed;

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
  const { records: classified, duplicateIndexCount } = await classifyStages({ anthropic, records });
  const staged = validateQuestions(classified);

  // Assembled here, once, regardless of which return path below is taken — the
  // leak-filter and seed-origin figures are already known by this point in the run,
  // and the zero-question guard right below returns a metrics-shaped result too so a
  // future caller of that path doesn't have to special-case an undefined field. Only
  // main()'s SUCCESS notify actually renders this (via renderRunMetrics below) — the
  // "no seeds available" and "Demand miner FAILED" notifies in main() are unchanged —
  // but it's cheap to compute unconditionally and wrong to compute it twice.
  const seedsByOrigin = { gsc_leak: 0, persona_objection: 0 };
  for (const s of seeds) seedsByOrigin[s.origin] = (seedsByOrigin[s.origin] || 0) + 1;

  const stageDistribution = {};
  for (const level of AWARENESS_LEVELS) stageDistribution[level] = 0;
  for (const q of staged) stageDistribution[q.stage] = (stageDistribution[q.stage] || 0) + 1;

  const metrics = {
    seedsByOrigin,
    leakFilter: {
      in: leaksIn,
      survived: Array.isArray(leaksAfterFilter) ? leaksAfterFilter.length : 0,
      dropped: leaksDropped.length,
      droppedSample: leaksDropped.slice(0, 5).map((l) => l.query),
    },
    stageDistribution,
    personaJoin: {
      withPersona: staged.filter((q) => q.persona_id != null).length,
      withoutPersona: staged.filter((q) => q.persona_id == null).length,
    },
    duplicateIndexCount,
  };

  // A non-empty seed set can still end with zero questions two different ways, and
  // both get the same treatment as the zero-seed guard above for the same reason —
  // writing an empty artifact would overwrite a good one from a previous run with
  // nothing:
  //   1. every seed's SERP call failed — caught above, `partial` is already true.
  //   2. every seed's SERP call SUCCEEDED but came back with no PAA/related-search
  //      items — normal for head keywords, and the more dangerous variant: nothing
  //      set `partial`, so this run looks completely clean while silently wiping the
  //      artifact. Voice-of-customer's writeArtifacts (agents/voice-of-customer/
  //      index.js:383-389) guards the same empty-final-output case; this mirrors it.
  // Notified rather than thrown: the previous artifact survives untouched and next
  // month's run will retry, so this is a degraded cycle, not a failure — hence
  // status: 'error' without immediate: true, so it lands in the 5 AM digest.
  if (staged.length === 0) {
    console.warn(`  demand-miner: harvested 0 questions from ${seeds.length} seed(s) — leaving the existing artifact in place.`);
    await notify({
      subject: 'Demand miner found nothing this cycle',
      body: `${seeds.length} seed(s) were harvested but produced 0 questions`
        + `${partial ? ' (partial — one or more seeds failed).' : ' — every SERP call succeeded but returned no PAA or related-search items.'}\n`
        + 'data/context/demand-questions.{json,md} were left untouched; the previous artifact is preserved.',
      status: 'error',
      category: 'demand-miner',
    });
    return {
      questions: [], partial, seedCount: seeds.length, metrics,
    };
  }

  // Both artifacts render fully in memory BEFORE the first write, so a renderer throw
  // cannot leave one file new and the other stale.
  const payload = {
    generated_at: now,
    clusters: CLUSTERS,
    seed_count: seeds.length,
    partial,
    questions: staged,
  };
  const json = JSON.stringify(payload, null, 2);
  const md = renderDemandQuestionsMarkdown({
    questions: staged, generatedAt: now, clusters: CLUSTERS, seedCount: seeds.length, partial,
  });
  writeArtifacts({ json, md });

  return {
    questions: staged, partial, seedCount: seeds.length, metrics,
  };
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
 * The real personas.json load path, in two SEPARATE steps deliberately — this is
 * what makes runDemandMiner's try/catch scoping possible. `realApplyPersonaOverlay`
 * below still composes both, in the same overlay-FIRST-sanitize-SECOND order
 * lib/operator-angles.js documents and the other four readers (agents/ad-brief, the
 * dashboard's ad-brief route, agents/ad-studio's non-brief path,
 * agents/creative-packager's loadPersonas) all use, and stays the function those
 * tests and any other direct caller should reach for. But runDemandMiner's real
 * wiring (in main() below) uses the two halves separately: only
 * `realOverlayPersonasOnly` is passed as `applyPersonaOverlay`, the argument
 * runDemandMiner's try/catch wraps — a dangling-personaId throw from THAT step is
 * the one this agent is built to survive. `realSanitizePersonasStep` is passed as
 * `sanitizePersonasStep` and runs outside that try, so a health-claim-withholding
 * failure (a bug in lib/voice-of-customer.js, an entirely different subsystem) is
 * never caught by the overlay's handler and misreported as an operator-angles.json
 * problem — it propagates uncaught, exactly as any other unexpected failure here
 * would.
 *
 * A missing/unparseable personas.json is `null` here (realReadJson already
 * degrades that way) and passes straight through at every step — overlayPersonas
 * and sanitizePersonas both no-op on null, matching the pre-existing degradation
 * path this agent's tests already cover (deriveSeeds treats missing personas as a
 * partial run, not a failure).
 */
export function realOverlayPersonasOnly(personasData, root = ROOT) {
  if (!personasData) return personasData;
  return overlayPersonas(personasData, { root });
}

export function realSanitizePersonasStep(personasData) {
  if (!personasData) return personasData;
  const { personas: safe, drops } = sanitizePersonas(personasData?.personas || []);
  if (drops.length) {
    console.warn(`  demand-miner: withheld ${drops.length} health-claim violation(s) from persona seeds:`);
    console.warn(formatPersonaDrops(drops));
  }
  return { ...personasData, personas: safe };
}

/**
 * Composes the two steps above, in order. Kept for direct callers/tests that want
 * the combined overlay-then-sanitize behavior in one call. runDemandMiner's own
 * real wiring does NOT use this — see the docstring above for why it wires the two
 * halves separately instead.
 */
export function realApplyPersonaOverlay(personasData, root = ROOT) {
  return realSanitizePersonasStep(realOverlayPersonasOnly(personasData, root));
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
    clusters: payload.clusters,
    seed_count: payload.seed_count,
    partial: payload.partial,
    question_count: payload.questions.length,
  };
  writeFileSync(join(reportDir, `seeds-${day}.json`), JSON.stringify(runRecord, null, 2), 'utf8');
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify(runRecord, null, 2), 'utf8');
}

// ── run-metrics notify block ────────────────────────────────────────────────

/**
 * Renders `runDemandMiner`'s `metrics` into the plain-text block appended to the
 * SUCCESS notify — a diagnostic block in an email, not a report artifact, so this
 * stays a pure string builder with no I/O rather than a template file or a second
 * JSON shape. Pure and exported so it's testable on a constructed `metrics` object
 * without running the whole agent.
 *
 * Exists to settle demand-miner's two deliberately-deferred open questions from the
 * first real run onward, every month, not just once:
 *   1. how much the skin-cluster leak filter drops, and whether the sample looks like
 *      genuine on-topic top-of-funnel phrasing it shouldn't be dropping.
 *   2. whether the LLM stage-classification response ever names the same `[n]` index
 *      twice — a silent Map.set overwrite that validateQuestions can't catch.
 * Both stay visible even on a clean run ("nothing dropped", "0 collisions") rather
 * than only appearing when something looks wrong — a block that vanishes on a good
 * month reads as "no data" as easily as "nothing happened".
 */
export function renderRunMetrics(metrics) {
  const {
    seedsByOrigin, leakFilter, stageDistribution, personaJoin, duplicateIndexCount,
  } = metrics;

  const lines = [
    '',
    `Seeds by origin: ${seedsByOrigin.gsc_leak || 0} gsc_leak, ${seedsByOrigin.persona_objection || 0} persona_objection.`,
    '',
    `Skin-cluster leak filter: ${leakFilter.in} leak(s) in -> ${leakFilter.survived} survived, ${leakFilter.dropped} dropped.`,
    leakFilter.dropped > 0
      ? `  Dropped sample (up to 5 of ${leakFilter.dropped}): ${leakFilter.droppedSample.map((q) => `"${q}"`).join(', ')}`
      : '  Nothing dropped this run.',
    '',
    `Funnel stage distribution: ${AWARENESS_LEVELS.map((level) => `${level} ${stageDistribution[level] || 0}`).join(', ')}.`,
    '',
    `Persona join: ${personaJoin.withPersona} question(s) carry a persona_id, ${personaJoin.withoutPersona} do not.`,
    '',
    duplicateIndexCount > 0
      ? `LLM duplicate index collisions: ${duplicateIndexCount} — the classify-stage response named the same [n] `
        + 'index more than once; the later value silently won via Map.set (merge behavior unchanged, just now visible).'
      : 'LLM duplicate index collisions: 0.',
  ];

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * Parse `--limit <n>` off argv. Returns undefined when absent (no rehearsal cap).
 * Throws on a non-positive-integer value rather than silently ignoring a typo —
 * a flag that's supposed to make a run cheaper must not fail open into the full
 * 40-seed cost because it was misread as "no limit".
 */
export function parseLimitArg(argv = process.argv) {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`demand-miner: --limit expects a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

async function main() {
  try {
    const e = loadEnv();
    const anthropic = new Anthropic({ apiKey: e.ANTHROPIC_API_KEY });
    const limit = parseLimitArg();

    console.log(`demand-miner: running…${limit ? ` (--limit ${limit}, clamped to SEED_CAP)` : ''}`);
    const result = await runDemandMiner({
      getSerpResults,
      anthropic,
      readJson: (p) => realReadJson(p),
      writeArtifacts: (files) => realWriteArtifacts(files),
      applyPersonaOverlay: (personasData) => realOverlayPersonasOnly(personasData),
      sanitizePersonasStep: (personasData) => realSanitizePersonasStep(personasData),
      limit,
      now: new Date().toISOString(),
    });

    if (result.seedCount === 0) {
      console.log('  demand-miner: no seeds available — skipped this cycle.');
      await realNotify({
        subject: 'Demand miner skipped — no seeds available',
        body: 'Neither GSC impression leaks nor persona objections were available, so there '
          + 'was nothing to harvest. data/context/demand-questions.{json,md} were left untouched.',
        status: 'info',
        category: 'demand-miner',
      });
      return;
    }

    if (result.questions.length === 0) {
      // seeds were harvested but nothing survived — runDemandMiner already sent the
      // degraded-harvest notify() (status: error, deferred to the digest) before
      // returning here, so main() only logs; a second notify would be redundant and
      // a "refreshed — 0 questions" success message would be actively misleading.
      console.log(`  demand-miner: harvested 0 questions from ${result.seedCount} seed(s) this cycle — see the digest, previous artifact preserved.`);
      return;
    }

    console.log(`  demand-miner: ${result.questions.length} questions from ${result.seedCount} seeds`
      + `${result.partial ? ' (PARTIAL)' : ''}`);
    console.log(`  wrote ${join(CONTEXT_DIR, 'demand-questions.json')}`);
    console.log(`  wrote ${join(CONTEXT_DIR, 'demand-questions.md')}`);

    await realNotify({
      subject: `Demand miner refreshed — ${result.questions.length} questions`,
      body: `Seeds harvested: ${result.seedCount}${result.partial ? ' (PARTIAL — a source was unavailable or a seed failed)' : ''}.\n`
        + `Questions written: ${result.questions.length}.\n`
        + renderRunMetrics(result.metrics)
        + '\n\n'
        + 'Open data/context/demand-questions.md to see what changed — it is tracked but '
        + 'never committed by cron, so `git diff` shows nothing; `git status --short data/context/` '
        + 'will list it.',
      status: 'success',
      category: 'demand-miner',
    });
  } catch (err) {
    console.error(`demand-miner failed: ${err.message}`);
    await realNotify({
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
