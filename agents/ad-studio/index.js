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
import { buildCopyPrompt, parseCopyResponse, expectedStrings } from './copy.js';
import { PLATFORM_TARGETS, variationDir, artifactName, buildDemandGenAssets } from './packaging.js';
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

/**
 * Render one variation, verifying after each attempt. Stops at maxAttempts.
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, attempts:number, proof:object}>}
 */
export async function renderWithRetry({ gemini, anthropic, prompt, photoPaths, ratio, expected, format, maxAttempts = 3 }) {
  let attempts = 0;
  let lastProof = { ok: false, reasons: ['no attempt made'], missing: [], mismatchedPairs: [] };
  let lastBuffer = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    lastBuffer = await renderVariation(gemini, { prompt, photoPaths, ratio });

    const msg = await anthropic.messages.create({
      model: CREATIVE_MODELS.adStudio.verify,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: lastBuffer.toString('base64') } },
          { type: 'text', text: buildVerifyPrompt({ expected, format }) },
        ],
      }],
    });

    const { transcript, pairings } = parseVerifyResponse(textOf(msg));
    lastProof = verdictFor({ expected, transcript, pairings, format });
    lastProof.transcript = transcript;
    if (lastProof.ok) return { ok: true, buffer: lastBuffer, attempts, proof: lastProof };
  }

  return { ok: false, buffer: lastBuffer, attempts, proof: lastProof };
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

function extractQuotedLabelText(text) {
  return [...String(text || '').matchAll(/"([^"]+)"/g)]
    .map(m => m[1].replace(/,\s*$/, '').trim())
    .filter(Boolean);
}

// "2 fl oz (60ml)" / "8 fl. oz. (236ml)" / "4 fl. oz • 118ml" — the manifest's prose
// states these with inconsistent punctuation, and not always inside quotes even when
// the quoted label text nearby makes clear it IS printed on the product.
const VOLUME_RE = /\d+(?:\.\d+)?\s*fl\.?\s*oz\.?(?:\s*[•(]\s*\d+(?:\.\d+)?\s*m?l\)?)?/gi;

function extractVolumeMarkings(text) {
  return [...String(text || '').matchAll(VOLUME_RE)].map(m => m[0].trim());
}

/**
 * Every string physically printed on the product's label, pulled from two sources:
 *   - quoted label text inside the manifest's productDescription
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
    const { zones, claims } = parseCopyResponse(textOf(msg));

    // Hard stop — never wrapped in try/catch, no override flag. An unsourced factual
    // claim must not reach the render stage.
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
        const prompt = buildRenderPrompt({ format, zones, product, brandKit, mode: target.mode });
        const expected = target.mode === 'finished' ? expectedFinished : expectedPlate;
        const r = await renderWithRetry({ gemini, anthropic, prompt, photoPaths, ratio: target.ratio, expected, format });

        const artifact = artifactName(target.platform, target.ratio, target.mode);
        writeFileSync(join(dir, artifact), r.buffer);
        proofByArtifact[artifact] = {
          platform: target.platform,
          ratio: target.ratio,
          mode: target.mode,
          attempts: r.attempts,
          ok: r.proof.ok,
          reasons: r.proof.reasons,
          missing: r.proof.missing,
          mismatchedPairs: r.proof.mismatchedPairs,
          transcript: r.proof.transcript,
        };
        if (!r.ok) allOk = false;
        console.log(`  ${conceptSlug} v${n} ${artifact}: ${r.ok ? 'OK' : 'FAILED'} (${r.attempts} attempt(s))`);
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
