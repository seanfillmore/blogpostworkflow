// agents/ad-studio/index.js
//
// Ad Studio — publish-ready static ad creatives for Meta and Google Demand Gen.
//
// Usage:
//   node agents/ad-studio/index.js --product coconut-lotion [--variant coconut-breeze]
//                                 [--formats us-vs-them,manifesto] [--variations 3] [--dry-run]
//
// Stages: angle → copy (+ claim gate) → single-pass render → verify → package.
// See docs/superpowers/specs/2026-08-14-ad-studio-design.md

import { GoogleGenAI } from '@google/genai';
import Anthropic from '../../lib/anthropic.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATIVE_MODELS } from '../../config/creative-models.js';
import { renderVariation, buildRenderPrompt, selectReferencePhotos } from './render.js';
import { buildVerifyPrompt, parseVerifyResponse, verdictFor } from './verify.js';
import { selectFormats } from './formats.js';
import { buildSourceIndex, assertClaimsSourced } from './claims.js';
import { buildCopyPrompt, parseCopyResponse, enforceZoneCapacity, expectedStrings } from './copy.js';
import { PLATFORM_TARGETS, variationDir, artifactName, buildDemandGenAssets, renderRatioFor, cropToRatio } from './packaging.js';
import { notify } from '../../lib/notify.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function slugify(s) {
  return String(s || '')
    .replace(/[‘’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function textOf(msg) {
  return (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// Magic-byte signatures. Gemini's response carries no reliable content-type of its
// own (renderVariation only ever reads the base64 payload), and it returns JPEG on
// some calls and PNG on others — assuming PNG produced a live 400 from the
// Anthropic API ("the image was specified using the image/png media type, but the
// image appears to be a image/jpeg image"). Every verify call failed until this was
// fixed, which means every render was paid for and then thrown away. No silent
// default: an unrecognized signature throws rather than guessing.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export function sniffImageMediaType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error(`ad-studio: image buffer too short to identify a type (${buf?.length ?? 0} byte(s))`);
  }
  if (PNG_SIGNATURE.every((byte, i) => buf[i] === byte)) return 'image/png';
  if (JPEG_SIGNATURE.every((byte, i) => buf[i] === byte)) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';

  const hex = [...buf.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  throw new Error(`ad-studio: unrecognized image type — first 8 bytes: ${hex}`);
}

/**
 * Render one variation, verifying after each attempt. Stops at maxAttempts.
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, mediaType:string|null, attempts:number, proof:object}>}
 */
export async function renderWithRetry({ gemini, anthropic, prompt, photoPaths, ratio, expected, format, maxAttempts = 3 }) {
  let attempts = 0;
  let lastProof = { ok: false, reasons: ['no attempt made'], missing: [], mismatchedPairs: [] };
  let lastBuffer = null;
  let lastMediaType = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    lastBuffer = await renderVariation(gemini, { prompt, photoPaths, ratio });
    // Sniff on every attempt — nothing guarantees Gemini returns the same format twice.
    lastMediaType = sniffImageMediaType(lastBuffer);

    const msg = await anthropic.messages.create({
      model: CREATIVE_MODELS.adStudio.verify,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: lastMediaType, data: lastBuffer.toString('base64') } },
          { type: 'text', text: buildVerifyPrompt({ expected, format }) },
        ],
      }],
    });

    const { transcript, pairings } = parseVerifyResponse(textOf(msg));
    lastProof = verdictFor({ expected, transcript, pairings, format });
    lastProof.transcript = transcript;
    if (lastProof.ok) return { ok: true, buffer: lastBuffer, mediaType: lastMediaType, attempts, proof: lastProof };
  }

  return { ok: false, buffer: lastBuffer, mediaType: lastMediaType, attempts, proof: lastProof };
}

export function buildRunReport({ runId, product, results }) {
  let accepted = 0;
  let rejected = 0;
  const conceptsWithNoAcceptedVariation = [];

  for (const c of results) {
    const okCount = c.variations.filter(v => v.ok).length;
    accepted += okCount;
    rejected += c.variations.length - okCount;
    if (okCount === 0) conceptsWithNoAcceptedVariation.push(c.conceptSlug);
  }

  return {
    runId,
    generatedAt: new Date().toISOString(),
    product: { handle: product.handle, title: product.title },
    models: CREATIVE_MODELS.adStudio,
    totals: { accepted, rejected, concepts: results.length },
    conceptsWithNoAcceptedVariation,
    results,
  };
}

// ── argv / env / data loading ──────────────────────────────────────────────

export function parseArgs(argv) {
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const product = getFlag('--product');
  if (!product) throw new Error('ad-studio: --product is required, e.g. --product coconut-lotion');
  const variant = getFlag('--variant') || null;
  const formatsRaw = getFlag('--formats');
  const formats = formatsRaw ? formatsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const variationsRaw = getFlag('--variations');
  const variations = variationsRaw === undefined ? 3 : parseInt(variationsRaw, 10);
  if (!Number.isInteger(variations) || variations < 1) {
    throw new Error(`ad-studio: --variations must be a positive integer, got "${variationsRaw}"`);
  }
  const dryRun = argv.includes('--dry-run');
  return { product, variant, formats, variations, dryRun };
}

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

// artifactName() (packaging.js) always ends in ".png" — that suffix is pinned by
// Task 7's tests and is a placement-format label, not a promise about file bytes.
// Gemini can return JPEG, so the artifact actually written to disk must carry the
// real extension or we ship JPEG bytes inside a file named "*.png".
const EXTENSION_BY_MEDIA_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

function artifactFilename(baseName, mediaType) {
  const ext = EXTENSION_BY_MEDIA_TYPE[mediaType];
  if (!ext) throw new Error(`ad-studio: no known file extension for media type "${mediaType}"`);
  return baseName.replace(/\.png$/, ext);
}

/**
 * Render, crop and package ONE platform target.
 *
 * Everything that spends money — renderWithRetry and cropToRatio — is caught: a
 * render/verify failure on a single target (Anthropic error, a corrupt image,
 * anything) must not abort the rest of the run, because earlier targets, variations
 * and concepts already cost money. Callers write `buffer` to disk (null on failure)
 * and merge `proofEntry` into that variation's proof.json under `artifact`.
 *
 * renderRatioFor is the one exception and is deliberately called OUTSIDE the
 * try/catch: an unmapped delivery ratio is a code/config bug in RENDER_RATIO_MAP,
 * not a transient render failure. It's pure, free, and identical on every call for
 * a given ratio — every remaining target/variation/concept that shares that ratio
 * would fail the exact same way, so swallowing it as "one target failed, keep
 * going" would just mean paying for every other target while quietly producing no
 * plates at all. Fails the whole run immediately instead, before anything is spent.
 * @returns {Promise<{ok:boolean, artifact:string, buffer:Buffer|null, proofEntry:object}>}
 */
export async function renderTarget({ gemini, anthropic, target, format, zones, product, brandKit, photoPaths, expectedFinished, expectedPlate }) {
  const { requestRatio, needsCrop } = renderRatioFor(target.ratio);
  const artifactBase = artifactName(target.platform, target.ratio, target.mode);

  try {
    const prompt = buildRenderPrompt({ format, zones, product, brandKit, mode: target.mode });
    const expected = target.mode === 'finished' ? expectedFinished : expectedPlate;
    const r = await renderWithRetry({ gemini, anthropic, prompt, photoPaths, ratio: requestRatio, expected, format });

    const buffer = needsCrop ? await cropToRatio(r.buffer, target.ratio) : r.buffer;
    const artifact = artifactFilename(artifactBase, r.mediaType);

    return {
      ok: r.ok,
      artifact,
      buffer,
      proofEntry: {
        platform: target.platform,
        ratio: target.ratio,
        requestRatio,
        cropped: needsCrop,
        mode: target.mode,
        mediaType: r.mediaType,
        attempts: r.attempts,
        ok: r.proof.ok,
        reasons: r.proof.reasons,
        missing: r.proof.missing,
        mismatchedPairs: r.proof.mismatchedPairs,
        transcript: r.proof.transcript,
      },
    };
  } catch (err) {
    return {
      ok: false,
      artifact: artifactBase,
      buffer: null,
      proofEntry: {
        platform: target.platform,
        ratio: target.ratio,
        requestRatio,
        cropped: needsCrop,
        mode: target.mode,
        ok: false,
        error: err.message,
        attempts: null,
      },
    };
  }
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

/** The live storefront's public product JSON — no Admin API token required. */
async function fetchPdpBody(siteUrl, handle) {
  const url = `${siteUrl}/products/${handle}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ad-studio: failed to fetch PDP body for "${handle}" (${url}): ${res.status}`);
  const data = await res.json();
  return stripHtml(data?.product?.body_html);
}

// Quoted label text the manifest prose attributes to a BADGE (a seal/emblem/roundel) is
// excluded. Badge inscriptions are decorative micro-copy set on a curved arc at roughly
// 8px — they carry no product spec, so nothing about them is falsifiable, and the verify
// gate's vision model cannot transcribe them reliably at plate resolution (it read the
// coconut-lotion badge as ["ORGANIC","COCONUT","ESSENTIAL OIL"], dropping a word and
// singularising another, on a plate that was in fact correct). Requiring text that cannot
// be read back is a gate that burns three paid renders per target and buys nothing.
//
// Scoped to the badge CUE in the prose, not to the string's content or length: a rule
// keyed on either of those could swallow the volume marking or the variant name, which
// are the whole reason labelStrings exists.
// The manifest names the element on one side of the quote or the other, consistently:
//   coconut-lotion            ...a small circular badge noting "Organic Coconut Oil + ..."
//   foam-soap-*, coconut-soap ...a small circular "Organic Coconut Oil & ..." badge, a...
// so both sides are checked. No spec-bearing string in any manifest entry sits next to
// one of these nouns — verified across all 21 entries.
// BOTH patterns are anchored hard against the quote. An earlier, looser version matched
// the noun anywhere in the preceding segment and silently ate "hand soap" and
// "toothpaste" — product-type strings, which ARE spec-bearing — because a segment starts
// immediately after the *previous* quote, so a badge named there reached forward into the
// next string. Keep these anchored; widening them is how this guard gets gutted.
const BADGE_NOUNS = 'badge|seal|emblem|roundel|medallion';
// noun directly precedes the quote: ...a small circular badge noting "..."
const BADGE_BEFORE_RE = new RegExp(`\\b(?:${BADGE_NOUNS})\\b(?:\\s+(?:noting|reading|stating|saying|that reads))?[\\s,]*$`, 'i');
// noun directly follows the quote: ..."..." badge, a botanical illustration...
const BADGE_AFTER_RE = new RegExp(`^[\\s,]*\\b(?:${BADGE_NOUNS})\\b`, 'i');

function extractQuotedLabelText(text) {
  const prose = String(text || '');
  const out = [];
  for (const m of prose.matchAll(/"([^"]+)"/g)) {
    // Only the prose since the previous quote closed / until the next one opens, so a
    // badge mentioned elsewhere in the sentence cannot suppress an unrelated string.
    const lead = prose.slice(0, m.index).split('"').pop();
    const trail = prose.slice(m.index + m[0].length).split('"')[0];
    if (BADGE_BEFORE_RE.test(lead) || BADGE_AFTER_RE.test(trail)) continue;
    const s = m[1].replace(/,\s*$/, '').trim();
    if (s) out.push(s);
  }
  return out;
}

// "2 fl oz (60ml)" / "8 fl. oz. (236ml)" / "4 fl. oz • 118ml" — the manifest's prose
// states these with inconsistent punctuation, and not always inside quotes even when
// the quoted label text nearby makes clear it IS printed on the product.
const VOLUME_RE = /\d+(?:\.\d+)?\s*fl\.?\s*oz\.?(?:\s*[•(]\s*\d+(?:\.\d+)?\s*m?l\)?)?/gi;

function extractVolumeMarkings(text) {
  return [...String(text || '').matchAll(VOLUME_RE)].map(m => m[0].trim());
}

/**
 * Every SPEC-BEARING string physically printed on the product's label, pulled from two
 * sources:
 *   - quoted label text inside the manifest's productDescription, EXCEPT badge
 *     inscriptions — see BADGE_CUE_RE above for why decorative arc micro-copy is
 *     excluded (Task 9 fix round 5, controller ruling)
 *   - the volume marking in that same prose, in or out of quotes
 *   - the --variant name, humanized — productDescription is written generically across
 *     a product's scents/variants and does not name the specific one being rendered,
 *     so without this the scent name would never appear here at all
 *
 * Deliberately does NOT include the catalog title (data/brand/product-catalog.json).
 * That title is marketing/SEO copy, not label text — for coconut-lotion it's
 * "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients", never printed on the
 * bottle. Including it broke in two directions at once: render.js's fidelity block
 * tells the image model "the label carries exactly these strings and no others", so
 * it would try to print that sentence on the bottle; and main() folds labelStrings
 * into the verify gate's expected text for finished frames, so the gate would then
 * REQUIRE that sentence to appear, rejecting a correctly-rendered bottle and burning
 * every retry attempt. (Task 9 fix round 1 — controller review caught this from the
 * dry-run output before any paid render ran.)
 *
 * Load-bearing, not defensive boilerplate: main() aborts if this comes back empty,
 * because an empty list is exactly how the image model invents a volume that was
 * never on the bottle (design probe: "6 fl. oz." rendered on a 2 fl oz bottle).
 */
export function buildLabelStrings({ manifestEntry, variant }) {
  const set = new Set();
  for (const s of extractQuotedLabelText(manifestEntry?.productDescription)) set.add(s);
  for (const s of extractVolumeMarkings(manifestEntry?.productDescription)) set.add(s);
  if (variant) set.add(variant.replace(/-/g, ' '));
  return [...set];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) throw new Error('ad-studio: missing ANTHROPIC_API_KEY in .env');
  if (!args.dryRun && !env.GEMINI_API_KEY) throw new Error('ad-studio: missing GEMINI_API_KEY in .env');

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const gemini = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;

  const handle = args.product;

  const manifest = loadJson(join(ROOT, 'data', 'product-images', 'manifest.json'));
  const manifestEntry = manifest.find(p => p.handle === handle);
  if (!manifestEntry) {
    throw new Error(`ad-studio: no entry for handle "${handle}" in data/product-images/manifest.json`);
  }

  const catalog = loadJson(join(ROOT, 'data', 'brand', 'product-catalog.json'));
  const catalogEntry = catalog.products?.[handle];
  if (!catalogEntry) {
    throw new Error(`ad-studio: no entry for handle "${handle}" in data/brand/product-catalog.json`);
  }

  const brandKit = loadJson(join(ROOT, 'data', 'brand', 'brand-kit.json'));

  const personasData = loadJson(join(ROOT, 'data', 'context', 'personas.json'));
  const rawPersona = personasData.personas?.[0] || null;
  // copy.js's buildCopyPrompt expects persona.angles as flat strings ("WHAT THEY
  // ALREADY TRIED"); personas.json's angles are objects, so project the field that
  // best matches that label.
  const persona = rawPersona
    ? {
        name: rawPersona.name,
        angles: (rawPersona.angles || []).map(a => a.objection_addressed || a.label).filter(Boolean),
      }
    : null;

  const site = loadJson(join(ROOT, 'config', 'site.json'));
  const pdpBody = await fetchPdpBody(site.url, handle);

  const labelStrings = buildLabelStrings({ manifestEntry, variant: args.variant });
  // ABORT — see buildLabelStrings' docstring. Not recoverable, no override flag.
  if (labelStrings.length === 0) {
    throw new Error(
      `ad-studio: labelStrings is empty for "${handle}" — refusing to render. An empty list ` +
      `is exactly how the image model invents a volume that was never on the bottle. Add ` +
      `quoted label text and a volume marking to this product's productDescription in ` +
      `data/product-images/manifest.json before running again.`
    );
  }

  const product = {
    handle,
    title: catalogEntry.title,
    priceLabel: catalogEntry.priceLabel,
    labelStrings,
  };

  const sourceIndex = buildSourceIndex({ pdpBody, brandKit, catalogEntry });

  const formats = selectFormats(args.formats.length ? args.formats : undefined);

  // Stage 2: copy + the claim gate. Runs regardless of --dry-run — the dry run's whole
  // purpose is proving the gate fires against real generated copy before anything costs
  // money on the render side.
  const concepts = [];
  for (const format of formats) {
    console.log(`Copy: ${format.key} (${format.name})...`);
    const prompt = buildCopyPrompt({ format, product, pdpBody, persona });
    const msg = await anthropic.messages.create({
      model: CREATIVE_MODELS.adStudio.copy,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    const { zones: rawZones, claims: rawClaims } = parseCopyResponse(textOf(msg));

    // Hard cap — a backstop for when the model ignores buildCopyPrompt's capacity
    // hint (or the capacity hint doesn't apply, e.g. no zoneCapacity declared). Must
    // run BEFORE the claim gate: the gate has to see the copy that will actually
    // render, not the pre-truncation draft.
    const { zones, dropped } = enforceZoneCapacity(rawZones, format);

    // A claim whose text was just truncated away must not reach the gate either — it
    // will never render, so sourcing it (or failing to) proves nothing, and running
    // the gate against text that no longer exists is exactly the "validate a claim we
    // then dropped" bug this fix exists to close.
    const droppedTexts = new Set(dropped.flatMap(d => d.items));
    const claims = droppedTexts.size ? rawClaims.filter(c => !droppedTexts.has(c.text)) : rawClaims;

    // Hard stop — never wrapped in try/catch, no override flag. An unsourced factual
    // claim must not reach the render stage. Runs on the TRUNCATED copy above.
    assertClaimsSourced(claims, sourceIndex);

    concepts.push({ format, zones, claims });
  }

  if (args.dryRun) {
    console.log(`\nDRY RUN — ${concepts.length} concept(s) for ${product.title} (${handle}${args.variant ? '/' + args.variant : ''})`);
    console.log(`labelStrings: ${JSON.stringify(labelStrings)}\n`);
    for (const c of concepts) {
      console.log(`── ${c.format.key} — ${c.format.name} ──`);
      console.log('zones:');
      for (const [zone, value] of Object.entries(c.zones)) {
        console.log(`  ${zone}: ${JSON.stringify(value)}`);
      }
      console.log('claims:');
      if (!c.claims.length) console.log('  (none)');
      for (const claim of c.claims) {
        console.log(
          claim.factual
            ? `  [${claim.zone}] "${claim.text}" — sourced: ${claim.sourceId} ("${claim.evidence}")`
            : `  [${claim.zone}] "${claim.text}" — persuasion (not factual)`
        );
      }
      console.log('');
    }
    console.log('Dry run complete — the claim gate passed for every concept above. No Gemini calls were made.');
    return { dryRun: true, concepts };
  }

  // Stage 3-5: single-pass render → verify → package, one variation directory per N.
  const runId = `${handle}${args.variant ? '-' + args.variant : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(ROOT, 'data', 'creatives', 'ad-studio', runId);
  mkdirSync(runDir, { recursive: true });

  const photoDir = args.variant
    ? join(ROOT, 'data', 'product-images', manifestEntry.imageDir, args.variant)
    : join(ROOT, 'data', 'product-images', manifestEntry.imageDir);
  const photoPaths = selectReferencePhotos(photoDir);
  if (photoPaths.length === 0) {
    console.warn(`ad-studio: no reference photos found under ${photoDir} — rendering with zero product photos.`);
  }

  const results = [];
  for (const concept of concepts) {
    const { format, zones, claims } = concept;
    const conceptSlug = format.key;
    const conceptDir = join(runDir, conceptSlug);
    mkdirSync(conceptDir, { recursive: true });
    writeFileSync(join(conceptDir, 'copy.json'), JSON.stringify({ zones, claims }, null, 2));
    writeFileSync(join(conceptDir, 'demand-gen-assets.json'), JSON.stringify(buildDemandGenAssets(zones), null, 2));

    // Finished (Meta) frames must reproduce the ad copy AND the product's real label —
    // this is where the labelStrings guard actually pays off: an invented volume shows
    // up as a "missing expected string" the same way a misspelled headline would.
    // Plates (Demand Gen) carry no ad copy at all, only the product's own label.
    const expectedFinished = [...expectedStrings(zones), ...product.labelStrings];
    const expectedPlate = [...product.labelStrings];

    const variationsOut = [];
    for (let n = 1; n <= args.variations; n++) {
      const dir = variationDir(ROOT, runId, conceptSlug, n);
      mkdirSync(dir, { recursive: true });

      const proofByArtifact = {};
      let allOk = true;

      for (const target of PLATFORM_TARGETS) {
        // renderTarget never throws — a render/verify failure on ONE target (an
        // Anthropic error, an unsupported-ratio 400, a corrupt image) must not
        // discard the rest of the run, because earlier targets/variations/concepts
        // already cost money. Reuses buildRunReport's existing rejected-variation
        // path via allOk=false below rather than adding a new one.
        const result = await renderTarget({ gemini, anthropic, target, format, zones, product, brandKit, photoPaths, expectedFinished, expectedPlate });

        if (result.buffer) writeFileSync(join(dir, result.artifact), result.buffer);
        proofByArtifact[result.artifact] = result.proofEntry;
        if (!result.ok) allOk = false;

        console.log(
          result.buffer
            ? `  ${conceptSlug} v${n} ${result.artifact}: ${result.ok ? 'OK' : 'FAILED'} (${result.proofEntry.attempts} attempt(s))`
            : `  ${conceptSlug} v${n} ${result.artifact}: ERROR — ${result.proofEntry.error}`
        );
      }

      writeFileSync(join(dir, 'proof.json'), JSON.stringify(proofByArtifact, null, 2));
      variationsOut.push({ n, ok: allOk });
    }

    results.push({ conceptSlug, format: format.key, variations: variationsOut });
  }

  const report = buildRunReport({ runId, product, results });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(report, null, 2));
  console.log(`\nRun complete: ${report.totals.accepted} accepted / ${report.totals.rejected} rejected. Output: data/creatives/ad-studio/${runId}/`);

  return { report };
}

// Guard: importing this module must not run the agent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(async (result) => {
      if (result?.dryRun) return; // a proving run, not a production run — no digest noise
      const { report } = result || {};
      const hasGaps = (report?.conceptsWithNoAcceptedVariation?.length || 0) > 0;
      const body = report
        ? `${report.totals.accepted} accepted / ${report.totals.rejected} rejected across ${report.totals.concepts} concept(s).` +
          (hasGaps ? `\nNo accepted variation: ${report.conceptsWithNoAcceptedVariation.join(', ')}` : '') +
          `\nOutput: data/creatives/ad-studio/${report.runId}/`
        : 'Ad Studio run complete.';
      await notify({
        subject: `Ad Studio run complete — ${report?.product?.title || ''}`,
        body,
        status: hasGaps ? 'error' : 'success',
        category: 'ads',
      }).catch(() => {});
    })
    .catch(async (err) => {
      await notify({ subject: 'Ad Studio failed', body: err.message || String(err), status: 'error', category: 'ads' }).catch(() => {});
      console.error(err);
      process.exit(1);
    });
}
