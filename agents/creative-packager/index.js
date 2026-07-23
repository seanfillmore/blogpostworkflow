// agents/creative-packager/index.js
/**
 * Creative Packager
 *
 * Triggered on-demand by dashboard POST /api/generate-creative.
 * Reads job spec, generates Gemini creatives, writes ZIP to data/creative-packages/.
 *
 * Usage:
 *   node agents/creative-packager/index.js --job-id <jobId>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATIVE_MODELS } from '../../config/creative-models.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

const PLACEMENT_MAP = {
  instagram: [
    { name: 'instagram-feed-1080x1080',    width: 1080, height: 1080, label: 'Instagram Feed (Square)' },
    { name: 'instagram-feed-1080x1350',    width: 1080, height: 1350, label: 'Instagram Feed (Portrait)' },
    { name: 'instagram-stories-1080x1920', width: 1080, height: 1920, label: 'Instagram Stories / Reels' },
  ],
  facebook: [
    { name: 'facebook-feed-1200x628',    width: 1200, height: 628,  label: 'Facebook Feed (Landscape)' },
    { name: 'facebook-feed-1080x1080',   width: 1080, height: 1080, label: 'Facebook Feed (Square)' },
    { name: 'facebook-stories-1080x1920', width: 1080, height: 1920, label: 'Facebook Stories' },
  ],
};

export function placementSizes(publisherPlatforms) {
  const sizes = [];
  for (const platform of publisherPlatforms) {
    if (PLACEMENT_MAP[platform]) sizes.push(...PLACEMENT_MAP[platform]);
  }
  return sizes;
}

export function formatCopyFile(variations) {
  const lines = ['META AD COPY VARIATIONS', '========================', ''];
  variations.forEach((v, i) => {
    lines.push(`Variation ${i + 1} — ${v.placement || 'General'}`);
    lines.push(`Headline: ${v.headline}`);
    lines.push(`Body: ${v.body}`);
    lines.push(`CTA: ${v.cta}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function formatSpecsFile(sizes) {
  const lines = ['AD PLACEMENT SPECIFICATIONS', '==========================', ''];
  for (const s of sizes) {
    lines.push(`${s.label}`);
    lines.push(`  Size: ${s.width} × ${s.height} px`);
    lines.push(`  File: ${s.name}.webp`);
    lines.push(`  Headline limit: 40 characters`);
    lines.push(`  Body limit: 125 characters`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildStylePrompt(ad) {
  return `You are a creative director preparing a brief for Gemini image generation.

Analyze this Meta ad and write a detailed image generation prompt that captures its visual style for a new ad creative.

Ad copy:
- Body: ${ad.adCreativeBody || '(none)'}
- Title: ${ad.adCreativeLinkTitle || '(none)'}
- Messaging angle: ${ad.analysis?.messagingAngle || 'unknown'}
- Why effective: ${ad.analysis?.whyEffective || 'unknown'}

Write a Gemini image generation prompt that:
1. Describes the mood and aesthetic (e.g., "clean, minimal, bright natural light")
2. Describes the color palette
3. Describes the composition and how the product should be featured
4. Describes the background and setting
5. Describes the lighting style
6. Specifies NOT to include any text, logos, or labels in the generated image

Return only the image prompt as plain text — no JSON, no explanation.`;
}

/**
 * Build a copy brief from a competitor ad (legacy Ad Intelligence path).
 * Session jobs supply their copyBrief directly from the route.
 */
export function buildCopyBrief(ad) {
  return {
    product: ad.pageName || ad.pageSlug || 'Real Skin Care',
    angle: ad.analysis?.messagingAngle || '',
    destinationUrl: ad.landingUrl || '',
    competitorBody: ad.adCreativeBody || '',
    copyInsights: ad.analysis?.copyInsights || '',
  };
}

/** Prompt for Claude to write 3 ad-copy variations from a copy brief. */
export function buildCopyPrompt(brief) {
  const lines = [
    'Write 3 ad copy variations for Real Skin Care (realskincare.com).',
    '',
    `Product: ${brief.product}`,
    `Angle: ${brief.angle || 'natural skincare'}`,
  ];
  if (brief.destinationUrl) lines.push(`Landing page: ${brief.destinationUrl}`);
  if (brief.competitorBody) lines.push(`Reference competitor copy: ${brief.competitorBody}`);
  if (brief.copyInsights) lines.push(`What works about it: ${brief.copyInsights}`);
  lines.push(
    '',
    'Our brand makes natural skincare products. Make it authentic to Real Skin Care and lead with a benefit tied to the angle.',
    '',
    'Return ONLY valid JSON (no markdown):',
    '[',
    '  { "headline": "max 40 chars", "body": "max 125 chars", "cta": "2-4 words", "placement": "general" },',
    '  { "headline": "...", "body": "...", "cta": "...", "placement": "instagram-feed" },',
    '  { "headline": "...", "body": "...", "cta": "...", "placement": "facebook-feed" }',
    ']',
  );
  return lines.join('\n');
}

/** Serialize a manifest.json describing the ad set and its conversion path. */
export function formatManifest(brief, sizes, generatedAt = null) {
  return JSON.stringify({
    product: brief.product,
    angle: brief.angle || '',
    destinationUrl: brief.destinationUrl || null,
    placements: sizes.map(s => s.name),
    generatedAt,
  }, null, 2);
}

// ── Job file helpers ───────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

function writeJobStatus(jobPath, updates) {
  const current = existsSync(jobPath)
    ? JSON.parse(readFileSync(jobPath, 'utf8')) : {};
  writeFileSync(jobPath, JSON.stringify({ ...current, ...updates }, null, 2));
}

async function generateImage(gemini, prompt, productImagePaths, referenceImages = []) {
  const contents = [];

  // Add product reference images (the actual product to feature).
  for (const imgPath of productImagePaths) {
    const imageData = readFileSync(imgPath).toString('base64');
    const ext = imgPath.endsWith('.png') ? 'image/png' : 'image/webp';
    contents.push({ inlineData: { data: imageData, mimeType: ext } });
  }
  // Add web-grounded reference images (real-world category photography).
  // These steer Gemini toward authentic product-ad aesthetics rather than
  // generic AI compositions.
  for (const ref of referenceImages) {
    contents.push({
      inlineData: { data: ref.buffer.toString('base64'), mimeType: ref.mimeType },
    });
  }
  contents.push({ text: prompt });

  const response = await gemini.models.generateContent({
    model: CREATIVE_MODELS.imageGen,
    contents: [{ role: 'user', parts: contents }],
    config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: {} },
  });

  const imgPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imgPart) throw new Error('Gemini returned no image');
  return Buffer.from(imgPart.inlineData.data, 'base64');
}

/**
 * Build the Tavily query used to fetch reference photography for this ad.
 * Pure — exported for tests. Pulls from the job spec when available, falls
 * back to deriving from the ad's pageSlug + messaging angle.
 */
export function buildReferenceQuery(ad, job = {}) {
  if (job.referenceQuery) return String(job.referenceQuery);
  const slug = (ad.pageSlug || '').replace(/-/g, ' ').trim();
  const angle = ad.analysis?.messagingAngle ? ` ${ad.analysis.messagingAngle}` : '';
  const base = slug ? `${slug}${angle}` : 'natural skincare';
  return `${base} lifestyle product photography ad`;
}

async function createZip(zipPath, files) {
  const { default: archiver } = await import('archiver');
  const { createWriteStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const { name, content } of files) archive.append(content, { name });
    archive.finalize();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const jobIdArg = process.argv.includes('--job-id')
    ? process.argv[process.argv.indexOf('--job-id') + 1] : null;
  if (!jobIdArg) throw new Error('--job-id required');

  const JOBS_DIR = join(ROOT, 'data', 'creative-jobs');
  const jobPath = join(JOBS_DIR, `${jobIdArg}.json`);
  if (!existsSync(jobPath)) throw new Error(`Job file not found: ${jobPath}`);

  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  writeJobStatus(jobPath, { status: 'running' });

  const env = loadEnv();
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  if (!geminiKey) throw new Error('Missing GEMINI_API_KEY');

  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const { GoogleGenAI } = await import('@google/genai');
  const { default: sharp } = await import('sharp');
  const client = new Anthropic({ apiKey });
  const gemini = new GoogleGenAI({ apiKey: geminiKey });

  const source = job.source || 'ad';
  let brief;
  let sizes;
  let slug;
  const generatedImages = [];

  if (source === 'session') {
    // Session path: one approved hero → resize to every placement (no ad lookup).
    brief = job.copyBrief || { product: 'Real Skin Care', angle: '', destinationUrl: '' };
    sizes = placementSizes(job.placements && job.placements.length ? job.placements : ['instagram', 'facebook']);
    slug = (brief.product || 'creative').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'creative';

    const CREATIVES_DIR = join(ROOT, 'data', 'creatives');
    const heroPath = join(CREATIVES_DIR, job.heroImagePath || '');
    if (!existsSync(heroPath)) throw new Error(`Hero image not found: ${heroPath}`);
    const heroBuffer = readFileSync(heroPath);
    for (const size of sizes) {
      process.stdout.write(`  Resizing ${size.name}... `);
      const buffer = await sharp(heroBuffer).resize(size.width, size.height, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
      generatedImages.push({ size, buffer });
      console.log('done');
    }
  } else {
    // Legacy ad path: resolve the competitor ad and generate one image per placement.
    const { adId, productImages = [] } = job;
    const insightsDir = join(ROOT, 'data', 'meta-ads-insights');
    const insightFiles = readdirSync(insightsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    if (!insightFiles.length) throw new Error('No insights files found');
    const insights = JSON.parse(readFileSync(join(insightsDir, insightFiles[0]), 'utf8'));
    const ad = insights.ads.find(a => a.id === adId);
    if (!ad) throw new Error(`Ad ${adId} not found in latest insights`);

    brief = buildCopyBrief(ad);
    sizes = placementSizes(ad.publisherPlatforms || ['instagram', 'facebook']);
    slug = ad.pageSlug || 'creative';

    process.stdout.write('  Extracting style... ');
    const styleResponse = await client.messages.create({
      model: CREATIVE_MODELS.styleBrief, max_tokens: 512,
      messages: [{ role: 'user', content: buildStylePrompt(ad) }],
    });
    const stylePrompt = styleResponse.content[0].text.trim();
    console.log('done');

    const PRODUCT_IMAGES_DIR = join(ROOT, 'data', 'product-images');
    const productImagePaths = productImages
      .map(f => join(PRODUCT_IMAGES_DIR, f))
      .filter(p => existsSync(p));

    for (const size of sizes) {
      process.stdout.write(`  Generating ${size.name}... `);
      let imgBuffer = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await generateImage(gemini, `${stylePrompt}\n\nGenerate as ${size.width}x${size.height} pixel image. No text, logos, or labels.`, productImagePaths, []);
          imgBuffer = await sharp(raw).resize(size.width, size.height, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
          break;
        } catch (e) {
          if (attempt === 1) throw new Error(`Gemini failed for ${size.name}: ${e.message}`);
          console.warn('  retry...');
        }
      }
      generatedImages.push({ size, buffer: imgBuffer });
      console.log('done');
    }
  }

  // Copy generation (both paths) — flagship model, revenue-critical.
  process.stdout.write('  Generating copy... ');
  const copyResponse = await client.messages.create({
    model: CREATIVE_MODELS.adCopy, max_tokens: 1024,
    messages: [{ role: 'user', content: buildCopyPrompt(brief) }],
  });
  const copyVariations = JSON.parse(copyResponse.content[0].text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim());
  console.log('done');

  // Package ZIP
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const zipName = `${slug}-${today}.zip`;
  const PACKAGES_DIR = join(ROOT, 'data', 'creative-packages');
  mkdirSync(PACKAGES_DIR, { recursive: true });
  const zipPath = join(PACKAGES_DIR, zipName);

  const zipFiles = [
    { name: 'copy.txt', content: formatCopyFile(copyVariations) },
    { name: 'specs.txt', content: formatSpecsFile(sizes) },
    { name: 'manifest.json', content: formatManifest(brief, sizes, new Date().toISOString()) },
  ];
  for (const { size, buffer } of generatedImages) {
    zipFiles.push({ name: `images/${size.name}.webp`, content: buffer });
  }

  process.stdout.write('  Packaging ZIP... ');
  await createZip(zipPath, zipFiles);
  console.log(`done → ${zipName}`);

  writeJobStatus(jobPath, { status: 'complete', downloadUrl: `/api/creative-packages/download/${jobIdArg}`, zipPath });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { notify } = await import('../../lib/notify.js');
  const { readdirSync } = await import('node:fs');
  const JOBS_DIR = join(ROOT, 'data', 'creative-jobs');
  const jobIdArg = process.argv.includes('--job-id')
    ? process.argv[process.argv.indexOf('--job-id') + 1] : null;
  const jobPath = jobIdArg ? join(JOBS_DIR, `${jobIdArg}.json`) : null;

  let jobError = null;
  try {
    await main();
  } catch (err) {
    jobError = err;
    console.error('Error:', err.message);
    await notify({ subject: 'Creative Packager failed', body: err.message, status: 'error' }).catch(() => {});
  } finally {
    if (jobError && jobPath && existsSync(jobPath)) {
      try { writeJobStatus(jobPath, { status: 'error', error: jobError.message }); } catch {}
    }
  }
  if (jobError) process.exit(1);
}
