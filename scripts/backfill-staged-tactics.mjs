#!/usr/bin/env node
/**
 * Reclassify already-rejected tactics that were only ever blocked by timing.
 *
 * Before staging existed, a tactic that was sound for this business but gated behind
 * the operating sequence (Tracking -> CRO -> Offer/AOV -> Traffic) was rejected. That
 * put it in data/reports/marketing-learner/<sourceId>.json, which nothing reads again
 * — so reaching the gate meant re-deriving the tactic, or paying to re-learn the video.
 *
 * This walks the saved reports, asks the model which rejects were timing-only, and
 * writes the survivors to a review file. It does NOT edit skills: promoting a tactic
 * into a skill is a merge, and merging 200 candidates unattended would rewrite every
 * curated file in one unreviewable pass. Feed the output back through the normal
 * adopt path instead.
 *
 * Costs LLM tokens but no transcript credits — it reads saved JSON, never re-fetches.
 *
 * Usage:
 *   node scripts/backfill-staged-tactics.mjs            # write the review file
 *   node scripts/backfill-staged-tactics.mjs --limit 40 # cap the candidates scored
 *   node scripts/backfill-staged-tactics.mjs --promote  # merge the reviewed file into skills
 *
 * --promote is the second, deliberate step. It routes each parked tactic to a skill
 * and merges it in with its stage marker, using the same writeSkill path a normal
 * learner run uses — so the same guards apply (no duplication, no lost graveyard, no
 * silent unparking). Run it only after reading the review file.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '../lib/anthropic.js';
import {
  STAGES, EXTRACTION_MODEL, buildConstraintBlock, scanSkillInventory,
} from '../lib/marketing-learner.js';
import { writeSkill, syncMirrorIfTouched } from '../agents/marketing-learner/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'data', 'reports', 'marketing-learner');
const OUT = join(ROOT, 'data', 'reports', 'marketing-learner', 'staged-backfill.json');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');

/** Repo convention: read .env directly. There is no dotenv import anywhere here. */
function loadEnv() {
  try {
    const env = {};
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i !== -1) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const argv = process.argv.slice(2);
const limitFlag = argv.indexOf('--limit');
const LIMIT = limitFlag === -1 ? Infinity : Number(argv[limitFlag + 1]);

/**
 * Rejects worth re-scoring.
 *
 * Two exclusions, both deliberate. A duplicate is dead no matter which phase we reach
 * — the claim already lives in a skill, and re-adopting it degrades triggering, which
 * is the failure the reject existed to prevent. A 0-2 score means the model found no
 * mechanism or no honest translation to this business; timing was not what stopped it,
 * so a gate opening changes nothing.
 */
function candidates() {
  const out = [];
  for (const f of readdirSync(REPORTS)) {
    if (!f.endsWith('.json') || f === 'staged-backfill.json') continue;
    let report;
    try { report = JSON.parse(readFileSync(join(REPORTS, f), 'utf8')); } catch { continue; }
    for (const t of report.tactics ?? []) {
      if (t.verdict !== 'reject') continue;
      const score = t.rscFit?.score ?? 0;
      if (score < 3) continue;
      const blob = `${t.rejectReason ?? ''} ${t.rscFit?.reasoning ?? ''}`;
      if (/duplicat|already (own|cover)|restates|redundant|existing skill/i.test(blob)) continue;
      out.push({
        sourceId: f.replace(/\.json$/, ''),
        creator: report.creator ?? null,
        title: report.title ?? null,
        claim: t.claim,
        mechanism: t.mechanism,
        evidence: t.evidence ?? null,
        score,
        reasoning: t.rscFit?.reasoning ?? '',
        rejectReason: t.rejectReason ?? '',
      });
    }
  }
  return out;
}

const SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'timingOnly'],
        properties: {
          index: { type: 'integer' },
          timingOnly: { type: 'boolean' },
          stage: { type: ['string', 'null'], enum: [...STAGES, null] },
          revisedScore: { type: ['integer', 'null'] },
          reasoning: { type: 'string' },
        },
      },
    },
  },
};

function buildPrompt(batch) {
  const items = batch.map((c, i) => (
    `${i}. Claim: ${c.claim}\n   Mechanism: ${c.mechanism}\n   Scored: ${c.score}/10\n` +
    `   Original fit reasoning: ${c.reasoning}\n   Rejected because: ${c.rejectReason}`
  )).join('\n\n');

  return `${buildConstraintBlock({ sourceType: 'video' })}

These tactics were REJECTED before the pipeline could park a tactic behind a stage
gate. Some of them were rejected purely because this business had not reached the
phase where the tactic applies. Those should have been parked, not discarded.

For each one, decide: was TIMING the only thing wrong with it?

Answer true only when the tactic would be genuinely worth doing at this business once
the named gate opens. Answer false when anything else is also wrong with it — no
stated mechanism, no honest translation to a solo-operator ecommerce catalog, a
platform we have no plan to be on, or duplication of an existing skill. Being
expensive or hard is not the same as being blocked by a phase.

When timingOnly is true, set "stage" to the gate that unblocks it (${STAGES.join(', ')})
and set "revisedScore" to what it is worth ON ITS MERITS once that gate opens — not
the depressed score it got for being unrunnable today.

Be strict. A false positive here promotes a bad tactic into a curated skill file.

${items}

Return ONLY JSON:
{ "verdicts": [ { "index": 0, "timingOnly": true, "stage": "traffic", "revisedScore": 7, "reasoning": "..." } ] }`;
}

async function score(client, batch) {
  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: buildPrompt(batch) }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('Backfill scoring hit max_tokens.');
  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (m ? m[1] : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(start, end + 1));
}

const ROUTE_SCHEMA_HINT = `{ "routes": [ { "index": 0, "skill": "marketing-product-image-stack", "action": "edit", "description": "<only when action is create>" } ] }`;

/**
 * Route each parked tactic to the skill that should own it. Mirrors the routing the
 * normal extraction does, but as its own pass because these tactics were extracted
 * before staging existed and carry no targetSkill.
 */
async function route(client, parked, inventory) {
  const skills = inventory.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  const items = parked.map((p, i) => `${i}. ${p.claim}\n   Mechanism: ${p.mechanism}\n   Parked until: ${p.stage}`).join('\n\n');
  const prompt = `Route each tactic below into the marketing skill that should own it.

Existing skills:
${skills}

Prefer "edit" into an existing skill — a new skill fragments coverage and degrades
triggering. Choose "create" only when no existing skill plausibly owns the subject,
and then give a description stating when to use it (not just restating the title).

Tactics:

${items}

Return ONLY JSON:
${ROUTE_SCHEMA_HINT}`;

  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (m ? m[1] : text).trim();
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).routes ?? [];
}

async function promote() {
  if (!existsSync(OUT)) throw new Error(`No review file at ${OUT}. Run without --promote first.`);
  const { parked } = JSON.parse(readFileSync(OUT, 'utf8'));
  if (!parked?.length) { console.log('Nothing parked to promote.'); return; }

  const apiKey = loadEnv().ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.');
  const client = new Anthropic({ apiKey });

  const inventory = scanSkillInventory(SKILLS_DIR);
  const routes = await route(client, parked, inventory);
  console.log(`Routed ${routes.length} of ${parked.length}.`);

  // Group by target so a skill with two incoming tactics is merged once, not twice —
  // two sequential merges of the same file would have the second one rewriting the
  // first one's output from a stale read.
  const bySkill = new Map();
  for (const r of routes) {
    const p = parked[r.index];
    if (!p || !r.skill) continue;
    if (!bySkill.has(r.skill)) bySkill.set(r.skill, { route: r, tactics: [] });
    bySkill.get(r.skill).tactics.push({
      claim: p.claim,
      mechanism: p.mechanism,
      evidence: p.evidence ?? 'assertion only',
      rscFit: { score: p.revisedScore ?? p.score, reasoning: p.verdictReasoning || p.reasoning },
      stage: p.stage,
      source: { creator: p.creator ?? 'unknown', title: p.title ?? 'untitled', locator: p.sourceId },
    });
  }

  for (const [name, { route: r, tactics }] of bySkill) {
    const existing = inventory.find((s) => s.name === name);
    process.stdout.write(`  ${name} (${existing ? 'edit' : 'create'}, ${tactics.length} tactic(s))… `);
    const { path, action } = await writeSkill({
      name,
      description: r.description ?? existing?.description ?? '',
      tactics,
      existing,
      client,
    });
    console.log(action === 'edit' ? 'merged' : 'created');
    if (!existsSync(path)) throw new Error(`writeSkill reported success but ${path} does not exist.`);
    // Per-write, matching processVideo: a later merge can throw on a guard, and the
    // mirror must still agree with whatever already landed on disk.
    syncMirrorIfTouched([path], [{ name, action }]);
  }

  console.log('\n✓ skills updated and mirror regenerated.');
  console.log('Parked tactics are in the skill files but hidden from the fleet projection until their gate opens.');
}

async function main() {
  if (argv.includes('--promote')) { await promote(); return; }
  if (!existsSync(REPORTS)) throw new Error(`No reports at ${REPORTS}`);
  const all = candidates();
  const pool = Number.isFinite(LIMIT) ? all.slice(0, LIMIT) : all;
  console.log(`${all.length} re-scorable rejects; scoring ${pool.length}.`);
  if (!pool.length) return;

  const apiKey = loadEnv().ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.');
  const client = new Anthropic({ apiKey });
  const BATCH = 15;
  const parked = [];

  for (let i = 0; i < pool.length; i += BATCH) {
    const batch = pool.slice(i, i + BATCH);
    process.stdout.write(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(pool.length / BATCH)}… `);
    const { verdicts } = await score(client, batch);
    let kept = 0;
    for (const v of verdicts ?? []) {
      const c = batch[v.index];
      if (!c || !v.timingOnly || !v.stage) continue;
      if (!STAGES.includes(v.stage)) continue;
      parked.push({ ...c, stage: v.stage, revisedScore: v.revisedScore ?? c.score, verdictReasoning: v.reasoning ?? '' });
      kept++;
    }
    console.log(`${kept} parked`);
  }

  parked.sort((a, b) => (b.revisedScore ?? 0) - (a.revisedScore ?? 0));
  mkdirSync(dirname(OUT), { recursive: true });
  // No timestamp field: Date.now() would make the file churn on every run and make
  // two runs over identical inputs look like different results in a diff.
  writeFileSync(OUT, JSON.stringify({ scanned: all.length, scored: pool.length, parked }, null, 2));

  console.log(`\n${parked.length} of ${pool.length} were timing-only.`);
  const byStage = new Map();
  for (const p of parked) byStage.set(p.stage, (byStage.get(p.stage) ?? 0) + 1);
  for (const s of STAGES) if (byStage.has(s)) console.log(`  ${s}: ${byStage.get(s)}`);
  console.log(`\nWritten to ${OUT.replace(ROOT + '/', '')}`);
  console.log('Review it, then feed the keepers through the normal adopt path — this script never edits skills.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
