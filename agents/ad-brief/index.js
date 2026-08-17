// agents/ad-brief/index.js
//
// Generates ad BRIEFS — one per persona angle — before any image is rendered.
//
//   node agents/ad-brief/index.js --product coconut-lotion [--variant coconut-breeze]
//                                [--angles p1a1,p5a3] [--dry-run]
//
// WHY THIS EXISTS. Ad Studio used to write copy and immediately spend ~$0.78 rendering
// it. The copy is the part that decides whether a concept was ever worth rendering, so
// judging it first is roughly a tenth of the cost of finding out from pixels.
//
// WHAT A BRIEF IS. The FINISHED, gate-passed copy for one persona angle, plus the
// evidence behind it and a score. Approving one renders those exact strings with no
// second LLM call — nothing drifts between what was read and what gets baked in.
//
// THE GATES ARE IMPORTED, NEVER REIMPLEMENTED. buildConcept (ad-studio) runs
// assertNoHealthClaims then assertClaimsSourced on every brief, the same modules in the
// same order Ad Studio uses. A second copy that drifts from the first would be the worst
// thing this agent could do.
//
// --dry-run makes ZERO Anthropic calls, unlike Ad Studio's --dry-run (which still burns
// real copy calls and only skips the paid Gemini render). A brief's entire purpose is to
// be the thing judged BEFORE spend, so its own preview mode has to cost nothing too — the
// same "cheapest action is the accidental one" reasoning behind --formats being required
// on Ad Studio. See the README's "Why --dry-run differs from Ad Studio's" section.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { FORMATS } from '../ad-studio/formats.js';
import { buildSourceIndex } from '../ad-studio/claims.js';
import { buildConcept, buildLabelStrings, fetchAdReviews } from '../ad-studio/index.js';
import { scoreBrief } from '../../lib/ad-brief-score.js';
import { writeBrief } from '../../lib/ad-brief.js';
import { SKIN_CLUSTER_HANDLES } from '../../lib/voice-of-customer.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Which product handles each personas.json `cluster` value covers.
 *
 * personas.json carries a top-level `cluster` and NO per-persona product linkage — the
 * only handle list that exists today is voice-of-customer's own SKIN_CLUSTER_HANDLES.
 * Deliberately a closed map: a cluster absent here is a cluster this agent has no
 * evidence for, and it must abort rather than guess. See main()'s cluster guard.
 */
const CLUSTER_HANDLES = {
  skin: SKIN_CLUSTER_HANDLES,
};

/**
 * The awareness join.
 *
 * formats.js tags each format problem|solution|product. Persona angles carry the finer
 * five-level scale. `unaware` and `most-aware` map to NULL because no format covers them
 * — 4 of the 15 angles on file are unrenderable today, and by the headroom argument in
 * lib/ad-brief-score.js those are among the most valuable angles we hold. Null is
 * deliberate: mapping them to the nearest format would silently render a broad angle as
 * a narrow one and hide the gap. See the spec's "Known gap".
 */
export const AWARENESS_TO_FORMAT_AWARENESS = {
  'unaware': null,
  'problem-aware': 'problem',
  'solution-aware': 'solution',
  'product-aware': 'product',
  'most-aware': null,
};

/**
 * Which formats can carry this angle. `proposed` is the first match in FORMATS'
 * declaration order, which is curated rather than arbitrary; the rest are offered as
 * alternatives so the operator can override in one click.
 */
export function formatsForAngle(angle, formats = FORMATS) {
  const want = AWARENESS_TO_FORMAT_AWARENESS[angle?.awareness] ?? null;
  if (!want) return { proposed: null, alternatives: [] };
  const keys = formats.filter(f => f.awareness === want).map(f => f.key);
  return { proposed: keys[0] ?? null, alternatives: keys.slice(1) };
}

/**
 * copy.js's buildCopyPrompt wants { name, angles: [flat strings] } and renders them as
 * "WHAT THEY ALREADY TRIED". Ad Studio passes a persona's WHOLE angle list, which asks
 * the writer to address five things at once. A brief is one angle — this projection is
 * what makes the copy specific to it.
 */
export function personaProjection(persona, angle) {
  const parts = [angle?.label, angle?.objection_addressed, angle?.proof].filter(Boolean);
  return { name: persona?.name || '', angles: [parts.join(' — ')] };
}

const PRODUCT_WORDS = /\b(soap|bar|lotion|cream|deodorant|toothpaste|balm|wash)\b/gi;

/**
 * Is this angle about this product?
 *
 * personas.json is cluster-scoped, so without this a lotion-specific angle ("The first
 * lotion that didn't react") would be briefed against bar soap and produce nonsense — at
 * one Opus call apiece. An angle naming NO product word stays relevant to everything,
 * which is the common case and the safe default.
 */
export function angleRelevance(angle, product) {
  const text = `${angle?.label || ''} ${angle?.proof || ''} ${angle?.objection_addressed || ''}`;
  const named = [...new Set((text.match(PRODUCT_WORDS) || []).map(w => w.toLowerCase()))];
  if (!named.length) return true;
  const target = `${product?.handle || ''} ${product?.title || ''}`.toLowerCase();
  return named.some(w => target.includes(w));
}

export function buildBriefId(product, angleId, now = Date.now()) {
  return `${product}-${angleId}-${now}`;
}

export function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const product = get('--product');
  if (!product) throw new Error('ad-brief: --product is required, e.g. --product coconut-lotion');
  const anglesRaw = get('--angles');
  return {
    product,
    variant: get('--variant') || null,
    angles: anglesRaw ? anglesRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
    dryRun: argv.includes('--dry-run'),
  };
}

// ── env / data loading — mirrors agents/ad-studio/index.js's loadEnv/loadJson exactly ──

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
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

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The live storefront's public product JSON — no Admin API token required.
 *
 * Not exported from agents/ad-studio/index.js, so it is re-implemented here rather than
 * imported. This is plain data fetching, not a gate — rule 1 (gates imported, never
 * reimplemented) is about assertNoHealthClaims/assertClaimsSourced, which ARE imported.
 * Kept byte-for-byte identical to Ad Studio's copy so the two never read the PDP body
 * differently.
 */
async function fetchPdpBody(siteUrl, handle) {
  const url = `${siteUrl}/products/${handle}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ad-brief: failed to fetch PDP body for "${handle}" (${url}): ${res.status}`);
  const data = await res.json();
  return stripHtml(data?.product?.body_html);
}

/**
 * Turn a rejected buildConcept() result into the brief's gates block.
 *
 * buildConcept runs assertNoHealthClaims BEFORE assertClaimsSourced (see its docstring),
 * so on a rejection exactly one of the two ever ran — the other simply never got a
 * chance to fail. The gate that actually rejected is marked false; the other stays
 * true, which is accurate (it did not fail) and is also what the "record what failed"
 * instruction asks for: name the one gate that did.
 *
 * The third branch is the important one under review. buildConcept only ever produces
 * an ok:false result by catching an error whose message starts with one of the two
 * known prefixes ("Health claim gate failed" / "Claim gate failed") — anything else it
 * re-throws uncaught. So in the REAL path this function should only ever see one of the
 * two known shapes. But the match is a plain string-prefix test against hand-authored
 * error text in two OTHER files (health-claims.js, claims.js), and nothing pins that
 * text — a future rename of either message would silently fall through here. Guessing
 * which gate "must have" failed in that case (or worse, assuming neither failed) would
 * launder an unverified brief into looking approvable. So an unrecognised shape marks
 * BOTH gates false rather than picking one to blame or trusting the other: a brief whose
 * gate outcome is unknown must not be approvable, and must not be mistaken for one that
 * passed either check.
 */
export function gatesFromRejection(result) {
  const error = result?.error || '';
  const healthFailed = /^Health claim gate failed/.test(error);
  const claimsFailed = /^Claim gate failed/.test(error);

  if (healthFailed) {
    return {
      health: { ok: false, violations: result.violations || [], error },
      claims: { ok: true, unsourced: [] },
    };
  }
  if (claimsFailed) {
    return {
      health: { ok: true },
      claims: { ok: false, unsourced: result?.violations || [], error },
    };
  }
  const unknownError = error || 'unrecognised rejection shape — buildConcept reported ok:false ' +
    'with an error message matching neither known gate prefix, so it is not possible to tell ' +
    'which gate (if either) actually failed.';
  return {
    health: { ok: false, unresolved: true, error: unknownError },
    claims: { ok: false, unresolved: true, unsourced: [], error: unknownError },
  };
}

/**
 * Flatten every persona's angles into { persona, angle } pairs. personas.json has no
 * cross-persona angle-id collisions (p1a1, p2a1, ... — the persona id is baked into the
 * angle id), so this list is safe to filter by bare angle id.
 */
function allPersonaAngles(personasData) {
  return (personasData.personas || []).flatMap(persona =>
    (persona.angles || []).map(angle => ({ persona, angle }))
  );
}

/**
 * The cluster guard. personas.json carries a single top-level `cluster` and NO
 * per-persona product linkage, so this is the only place "is this product covered by
 * the personas we have evidence for" can be answered. Extracted to a pure, exported
 * function so it is directly testable — main()'s abort message is exactly this error.
 *
 * Never falls back to another cluster's personas and never invents one: fabricated
 * audience reasoning underneath a claim-gated ad is what this whole pipeline exists to
 * prevent.
 */
export function assertClusterCoverage(handle, personasData, clusterHandles = CLUSTER_HANDLES) {
  const cluster = personasData?.cluster;
  const handles = clusterHandles[cluster];
  if (!handles || !handles.includes(handle)) {
    throw new Error(
      `ad-brief: "${handle}" is not covered by the "${cluster || 'unknown'}" cluster's personas ` +
      `(data/context/personas.json covers: ${handles ? handles.join(', ') : '(no handles for this cluster)'}). ` +
      `Run agents/voice-of-customer for "${handle}"'s cluster before briefing it — this agent never ` +
      `falls back to another cluster's personas and never invents one.`
    );
  }
}

/**
 * Resolve a format, score, generate + gate copy, and PERSIST — one angle at a time.
 *
 * Each brief is written via writeBrief() IMMEDIATELY after it is built, inside this
 * loop, rather than accumulated in memory and written in a batch after every angle has
 * been processed. That used to be a real hazard: if anything threw that was not a gate
 * rejection — a transient API error, a malformed copy response out of
 * parseCopyResponse, anything outside buildConcept's own try/catch — the exception
 * would reach main()'s top-level .catch() and discard every brief already generated,
 * including ones that had already passed both gates and cost real Anthropic spend. This
 * agent's entire premise is being the cheap step that is safe to interrupt, and
 * writeBrief is a single atomic file write built exactly for independent per-brief
 * persistence (see lib/ad-brief.js) — there is no reason not to use it per-angle.
 *
 * `buildConceptFn` defaults to the real, imported buildConcept and exists purely so a
 * test can inject a stub that fails partway through a multi-angle batch without making
 * a real Anthropic call — the real path never overrides it.
 *
 * --dry-run never calls buildConceptFn and never writes: it returns the same shape
 * (score, proposed format, state) so main() can print an identical summary, each entry
 * additionally carrying `pending: true`.
 */
export async function generateBriefs({
  selected, product, pdpBody, sourceIndex, reviews, seoImpact, dryRun, anthropic, root,
  now = Date.now(), buildConceptFn = buildConcept,
}) {
  const out = [];
  for (const { persona, angle } of selected) {
    const { proposed, alternatives } = formatsForAngle(angle, FORMATS);
    const score = scoreBrief({ persona, angle, reviews, productHandle: product.handle, seoImpact });
    const briefId = buildBriefId(product.handle, angle.id, now);
    const base = {
      briefId,
      product: product.handle,
      variant: product.variant ?? null,
      personaId: persona.id,
      personaName: persona.name,
      angleId: angle.id,
      angle,
      format: { proposed, alternatives },
      score,
    };

    // Rule 3: an angle with no matching format is still recorded and costs no copy
    // call — never substitute the nearest format, that would render a broad angle as a
    // narrow one and hide exactly the gap this is meant to surface.
    if (!proposed) {
      const brief = { ...base, zones: null, state: 'ready' };
      out.push(dryRun ? { ...brief, pending: true } : writeBrief(root, brief));
      continue;
    }

    if (dryRun) {
      // No copy call, no write — --dry-run only previews the plan.
      out.push({ ...base, zones: null, state: 'ready', pending: true });
      continue;
    }

    const format = FORMATS.find(f => f.key === proposed);
    const result = await buildConceptFn({
      anthropic, format, product, pdpBody,
      persona: personaProjection(persona, angle),
      sourceIndex, reviews,
    });

    const brief = result.ok
      ? {
          ...base,
          zones: result.zones,
          claims: result.claims,
          state: 'ready',
          gates: { health: { ok: true }, claims: { ok: true, unsourced: [] } },
        }
      : {
          ...base,
          zones: null,
          claims: null,
          state: 'needs-evidence',
          gates: gatesFromRejection(result),
        };

    // Persisted before the loop moves to the next angle — see this function's docstring.
    out.push(writeBrief(root, brief));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handle = args.product;

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) throw new Error('ad-brief: missing ANTHROPIC_API_KEY in .env');
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Step 1: personas + the cluster guard. Never fall back to another cluster's personas
  // and never invent one — fabricated audience reasoning underneath a claim-gated ad is
  // what this pipeline exists to prevent.
  const personasData = loadJson(join(ROOT, 'data', 'context', 'personas.json'));
  assertClusterCoverage(handle, personasData);

  // Step 2: product, exactly as Ad Studio loads it.
  const manifest = loadJson(join(ROOT, 'data', 'product-images', 'manifest.json'));
  const manifestEntry = manifest.find(p => p.handle === handle);
  if (!manifestEntry) {
    throw new Error(`ad-brief: no entry for handle "${handle}" in data/product-images/manifest.json`);
  }

  const catalog = loadJson(join(ROOT, 'data', 'brand', 'product-catalog.json'));
  const catalogEntry = catalog.products?.[handle];
  if (!catalogEntry) {
    throw new Error(`ad-brief: no entry for handle "${handle}" in data/brand/product-catalog.json`);
  }

  const brandKit = loadJson(join(ROOT, 'data', 'brand', 'brand-kit.json'));

  // labelStrings is built for parity with Ad Studio's product object, but a brief never
  // renders, so — unlike Ad Studio's main() — an empty result does not abort here: the
  // failure labelStrings guards against (an image model inventing a volume) can only
  // happen at render time, which this agent never reaches.
  const labelStrings = buildLabelStrings({ manifestEntry, variant: args.variant });

  const product = {
    handle,
    title: catalogEntry.title,
    priceLabel: catalogEntry.priceLabel,
    labelStrings,
    variant: args.variant,
  };

  const site = loadJson(join(ROOT, 'config', 'site.json'));
  const pdpBody = await fetchPdpBody(site.url, handle);

  // Step 3: reviews + the claim gate's source index.
  const reviews = await fetchAdReviews(handle, { env });
  if (reviews.length) console.log(`Reviews on file for ${handle}: ${reviews.length}`);
  else console.warn(`No Judge.me reviews for ${handle} — any angle that quotes a customer will be rejected by the claim gate.`);

  const sourceIndex = buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews });

  // Step 4: seo-impact, best-effort. Missing (the common case in a local checkout — see
  // CLAUDE.md's snapshot note) scores neutral rather than blocking.
  let seoImpact = null;
  try {
    seoImpact = loadJson(join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json'));
  } catch { /* neutral commercial score — see scoreCommercial */ }

  // Step 5: select angles — those named by --angles, else every angle passing
  // angleRelevance for this product.
  const all = allPersonaAngles(personasData);
  let selected;
  if (args.angles.length) {
    const byId = new Map(all.map(pa => [pa.angle.id, pa]));
    const missing = args.angles.filter(id => !byId.has(id));
    if (missing.length) {
      throw new Error(`ad-brief: unknown angle id(s): ${missing.join(', ')} — known ids: ${all.map(pa => pa.angle.id).join(', ')}`);
    }
    selected = args.angles.map(id => byId.get(id));
  } else {
    selected = all.filter(({ angle }) => angleRelevance(angle, product));
  }

  if (!selected.length) {
    console.log(`ad-brief: no angles selected for "${handle}" — nothing to do.`);
    return { dryRun: args.dryRun, briefs: [] };
  }

  const now = Date.now();

  // Steps 6-8: resolve a format per angle, generate + gate copy where one exists, score,
  // and (outside --dry-run) persist ONE ANGLE AT A TIME — see generateBriefs' docstring.
  // Each angle is independent — one rejection or an unrelated error must not discard the
  // others' already-generated, already-paid-for briefs.
  const results = await generateBriefs({
    selected, product, pdpBody, sourceIndex, reviews, seoImpact,
    dryRun: args.dryRun, anthropic, root: ROOT, now,
  });

  // Step 9: rank + print, computed from what generateBriefs actually returned (which — on
  // the real path — is exactly what is now on disk) rather than from a separate
  // in-main accumulator that a mid-run exception could leave short of the truth.
  // Highest score first, same ordering listBriefs uses on disk.
  const ranked = [...results].sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1));

  if (args.dryRun) {
    const callCount = ranked.filter(b => b.format.proposed).length;
    console.log(`\nDRY RUN — ${ranked.length} angle(s) for ${product.title} (${handle}${args.variant ? '/' + args.variant : ''})`);
    console.log(`Would make ${callCount} Anthropic copy call(s). No Anthropic calls were made.\n`);
    for (const b of ranked) {
      console.log(
        `── ${b.angleId} (${b.personaName}) — score ${b.score.total} ` +
        `[persona ${b.score.persona} proof ${b.score.proof} commercial ${b.score.commercial} headroom ${b.score.headroom}] ──`
      );
      console.log(`  angle: ${b.angle.label} (${b.angle.awareness})`);
      console.log(
        b.format.proposed
          ? `  format: ${b.format.proposed}${b.format.alternatives.length ? ` (alternatives: ${b.format.alternatives.join(', ')})` : ''}`
          : `  format: none — no format covers "${b.angle.awareness}" yet; brief will be recorded as ready with no render target`
      );
      console.log('');
    }
    return { dryRun: true, briefs: ranked };
  }

  // Already written to disk inside generateBriefs, one at a time — this is a summary of
  // what happened, not the write itself.
  console.log(`\n${ranked.length} brief(s) written for ${product.title} (${handle}${args.variant ? '/' + args.variant : ''}):`);
  for (const b of ranked) {
    console.log(`  ${b.briefId} — score ${b.score.total} — ${b.state}${b.format.proposed ? ` (${b.format.proposed})` : ' (no format)'}`);
  }
  const needsEvidence = ranked.filter(b => b.state === 'needs-evidence');
  if (needsEvidence.length) {
    console.log(`\n${needsEvidence.length} brief(s) need evidence (gate-rejected):`);
    for (const b of needsEvidence) {
      const failed = b.gates.health.ok === false ? 'health' : 'claims';
      console.log(`  ${b.briefId} — ${failed} gate: ${b.gates[failed].error}`);
    }
  }

  return { dryRun: false, briefs: ranked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
