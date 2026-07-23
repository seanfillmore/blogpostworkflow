# Creatives Two Pathways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Creatives tab into two operator pathways — Studio (one-off images) and Ad Builder (product+angle → hero → placement-sized static ad set + copy ZIP) — over one shared image canvas, fixing the dead package pipeline and refreshing models and UI.

**Architecture:** One dashboard tab with a Studio/Ad Builder mode toggle sharing the same image-canvas JS. The `creative-packager` agent becomes source-agnostic: a job carries a hero image + copy brief + placements (no `adId`). Model IDs are centralized in one config module.

**Tech Stack:** Node.js ESM, `node --test`, plain-HTTP dashboard routes (`agents/dashboard`), `@google/genai` (Gemini image), `lib/anthropic.js` (Claude), `sharp`, `archiver`.

## Global Constraints

- Work on branch `feature/creatives-two-pathways` (already created); never commit to `main`; merge via PR. Copy verbatim from spec: rules #1–#5.
- Test a fix on ONE session end-to-end before any bulk/batch behavior (rule #4).
- Dashboard browser JS lives in `agents/dashboard/public/` and is edited directly (no template-literal escaping rules), EXCEPT strings inside the `index.html` template literal where `\n` must be `\\n` — the creatives markup is static HTML in `index.html`, not inside a template literal, so normal HTML applies.
- Model IDs (exact strings): ad copy `claude-opus-4-8`; style-brief, template-vision, session-name `claude-haiku-4-5`; image generation `gemini-2.5-flash-image`.
- Test runner: `node --test 'tests/**/*.test.js'`. Test files are plain ESM scripts using `import { strict as assert } from 'node:assert'` with top-level assertion blocks (see `tests/agents/creative-packager.test.js`).
- Node built-in `node:` imports; project `type: "module"`.

---

### Task 1: Centralized creative model config

**Files:**
- Create: `config/creative-models.js`
- Test: `tests/config/creative-models.test.js`

**Interfaces:**
- Produces: `export const CREATIVE_MODELS` — object with string fields `adCopy`, `styleBrief`, `templateVision`, `sessionName`, `imageGen`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/config/creative-models.test.js
import { strict as assert } from 'node:assert';
import { CREATIVE_MODELS } from '../../config/creative-models.js';

assert.equal(CREATIVE_MODELS.adCopy, 'claude-opus-4-8', 'ad copy uses the flagship');
assert.equal(CREATIVE_MODELS.styleBrief, 'claude-haiku-4-5');
assert.equal(CREATIVE_MODELS.templateVision, 'claude-haiku-4-5');
assert.equal(CREATIVE_MODELS.sessionName, 'claude-haiku-4-5');
assert.equal(CREATIVE_MODELS.imageGen, 'gemini-2.5-flash-image');

console.log('✓ creative-models config tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config/creative-models.test.js`
Expected: FAIL — `Cannot find module '.../config/creative-models.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// config/creative-models.js
// Single source of truth for models used across the creatives pipeline.
// Ad copy is revenue-critical → flagship. Everything else is a short,
// mechanical task → Haiku. Image generation is unified on one Gemini model.
export const CREATIVE_MODELS = {
  adCopy: 'claude-opus-4-8',
  styleBrief: 'claude-haiku-4-5',
  templateVision: 'claude-haiku-4-5',
  sessionName: 'claude-haiku-4-5',
  imageGen: 'gemini-2.5-flash-image',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config/creative-models.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add config/creative-models.js tests/config/creative-models.test.js
git commit -m "feat(creatives): centralize creative model IDs in config"
```

---

### Task 2: Packager pure helpers (copy brief, copy prompt, manifest)

**Files:**
- Modify: `agents/creative-packager/index.js` (add three exported pure functions after `buildStylePrompt`, ~line 86)
- Test: `tests/agents/creative-packager.test.js` (append blocks)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `buildCopyBrief(ad)` → `{ product, angle, destinationUrl, competitorBody, copyInsights }` (all strings).
  - `buildCopyPrompt(brief)` → string prompt for Claude; tolerates missing optional fields.
  - `formatManifest(brief, sizes, generatedAt = null)` → JSON string with `product`, `angle`, `destinationUrl` (null if empty), `placements` (array of `size.name`), `generatedAt`.

- [ ] **Step 1: Write the failing tests (append to existing test file)**

```javascript
// --- append to tests/agents/creative-packager.test.js ---
import {
  buildCopyBrief,
  buildCopyPrompt,
  formatManifest,
} from '../../agents/creative-packager/index.js';

// buildCopyBrief — maps ad fields
{
  const ad = {
    pageName: 'Sensitive Skin Set',
    landingUrl: 'https://www.realskincare.com/products/sensitive-skin-set',
    adCreativeBody: 'Gentle for reactive skin',
    analysis: { messagingAngle: 'gentle', copyInsights: 'social proof' },
  };
  const b = buildCopyBrief(ad);
  assert.equal(b.product, 'Sensitive Skin Set');
  assert.equal(b.angle, 'gentle');
  assert.equal(b.destinationUrl, 'https://www.realskincare.com/products/sensitive-skin-set');
  assert.equal(b.competitorBody, 'Gentle for reactive skin');
  assert.equal(b.copyInsights, 'social proof');
}

// buildCopyBrief — falls back safely
{
  const b = buildCopyBrief({});
  assert.equal(b.product, 'Real Skin Care');
  assert.equal(typeof b.angle, 'string');
  assert.equal(b.destinationUrl, '');
}

// buildCopyPrompt — includes product/angle and JSON instruction; tolerates missing fields
{
  const p = buildCopyPrompt({ product: 'Coconut Lotion', angle: 'dry skin', destinationUrl: '' });
  assert.ok(p.includes('Coconut Lotion'));
  assert.ok(p.includes('dry skin'));
  assert.ok(p.includes('JSON'));
  assert.ok(!p.includes('undefined'));
}

// formatManifest — shape + empty destinationUrl becomes null
{
  const sizes = placementSizes(['instagram']);
  const brief = { product: 'X', angle: 'a', destinationUrl: '' };
  const m = JSON.parse(formatManifest(brief, sizes, '2026-07-23T00:00:00Z'));
  assert.equal(m.product, 'X');
  assert.equal(m.destinationUrl, null);
  assert.ok(Array.isArray(m.placements) && m.placements.length === sizes.length);
  assert.equal(m.generatedAt, '2026-07-23T00:00:00Z');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/creative-packager.test.js`
Expected: FAIL — `buildCopyBrief` (and siblings) are not exported.

- [ ] **Step 3: Write minimal implementation (insert after `buildStylePrompt` in `agents/creative-packager/index.js`, ~line 86)**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/creative-packager.test.js`
Expected: PASS (existing blocks still pass)

- [ ] **Step 5: Commit**

```bash
git add agents/creative-packager/index.js tests/agents/creative-packager.test.js
git commit -m "feat(creatives): add source-agnostic copy-brief and manifest helpers"
```

---

### Task 3: Packager `main()` — source branch, unified Gemini, config models, manifest in ZIP

**Files:**
- Modify: `agents/creative-packager/index.js` — top import, `generateImage()` (~line 109-137), `main()` (~line 168-301)

**Interfaces:**
- Consumes: `CREATIVE_MODELS` (Task 1); `buildCopyBrief`/`buildCopyPrompt`/`formatManifest` (Task 2); existing `placementSizes`, `formatCopyFile`, `formatSpecsFile`, `createZip`, `writeJobStatus`.
- Produces: a packager that handles `job.source === 'session'` (resize one hero image to all placements) and `'ad'`/legacy (per-size Gemini generation), writes `images/*.webp`, `copy.txt`, `specs.txt`, `manifest.json` to the ZIP, and sets `status: 'complete'`.

This task has no unit test (it orchestrates spawned processes and external APIs); it is verified end-to-end in Task 9. Keep the pure helpers (Task 2) as the tested surface.

- [ ] **Step 1: Add the config import at the top of `agents/creative-packager/index.js` (after the existing `node:url` import, ~line 14)**

```javascript
import { CREATIVE_MODELS } from '../../config/creative-models.js';
```

- [ ] **Step 2: Update `generateImage()` to the unified Gemini model + `config.imageConfig` shape**

Replace the `gemini.models.generateContent({...})` call inside `generateImage` (~line 128-132) with:

```javascript
  const response = await gemini.models.generateContent({
    model: CREATIVE_MODELS.imageGen,
    contents: [{ role: 'user', parts: contents }],
    config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: {} },
  });
```

- [ ] **Step 3: Replace `main()` with the source-branched version**

Replace the whole `async function main() { ... }` body (lines ~168-301) with:

```javascript
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
```

- [ ] **Step 4: Verify the file still parses and unit tests pass**

Run: `node --check agents/creative-packager/index.js && node --test tests/agents/creative-packager.test.js`
Expected: no syntax error; PASS

- [ ] **Step 5: Commit**

```bash
git add agents/creative-packager/index.js
git commit -m "feat(creatives): source-agnostic packager (session hero + legacy ad), unified Gemini, config models, manifest"
```

---

### Task 4: `/api/creatives/package` route → session job

**Files:**
- Modify: `agents/dashboard/routes/creatives.js` — the `POST /api/creatives/package` handler (lines ~624-656)

**Interfaces:**
- Consumes: `ctx.CREATIVE_SESSIONS_DIR`, `ctx.CREATIVE_JOBS_DIR`, `ctx.ROOT`, `ctx.ensureDir`; session file shape `{ name, versions: [{ version, imagePath }] }`.
- Produces: writes a `source: "session"` job `{ jobId, source, heroImagePath, productImages: [], copyBrief: { product, angle, destinationUrl }, placements, status, createdAt }`; returns `{ jobId }`.

- [ ] **Step 1: Replace the `POST /api/creatives/package` handler body**

Replace the handler (inside the object whose `match: '/api/creatives/package'`) with:

```javascript
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const { sessionId, product, angle, destinationUrl, placements } = payload;
        const version = parseInt(payload.version, 10);
        if (!sessionId || !version) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId and version are required' }));
          return;
        }
        try {
          const sessionPath = join(ctx.CREATIVE_SESSIONS_DIR, sessionId + '.json');
          if (!existsSync(sessionPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
          }
          const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
          const verObj = (session.versions || []).find(v => v.version === version);
          if (!verObj) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Version not found' }));
            return;
          }
          const jobId = 'pkg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          ctx.ensureDir(ctx.CREATIVE_JOBS_DIR);
          const jobData = {
            jobId,
            source: 'session',
            heroImagePath: verObj.imagePath,
            productImages: [],
            copyBrief: {
              product: product || session.name || 'Real Skin Care',
              angle: angle || '',
              destinationUrl: destinationUrl || '',
            },
            placements: Array.isArray(placements) && placements.length ? placements : ['instagram', 'facebook'],
            status: 'pending',
            createdAt: new Date().toISOString(),
          };
          writeFileSync(join(ctx.CREATIVE_JOBS_DIR, jobId + '.json'), JSON.stringify(jobData, null, 2));
          spawn('node', [join(ctx.ROOT, 'agents/creative-packager/index.js'), '--job-id', jobId], {
            detached: true,
            stdio: 'ignore',
            cwd: ctx.ROOT,
          }).unref();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jobId }));
        } catch (err2) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err2.message }));
        }
      });
    },
```

- [ ] **Step 2: Verify the route file parses**

Run: `node --check agents/dashboard/routes/creatives.js`
Expected: no syntax error

- [ ] **Step 3: Manual smoke — job is written with the right shape**

Start the dashboard locally (`node agents/dashboard/index.js` or per project runbook), then in another shell:

```bash
curl -s -X POST localhost:4242/api/creatives/package \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<an existing session id>","version":1,"product":"Test","angle":"gentle","destinationUrl":"https://www.realskincare.com/products/x"}'
```
Expected: `{"jobId":"pkg-..."}`; the file `data/creative-jobs/pkg-*.json` exists with `"source":"session"` and a `heroImagePath`.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/routes/creatives.js
git commit -m "feat(creatives): package route builds session hero job (no adId)"
```

---

### Task 5: Generate route — custom aspect ratio + persist source paths; refine carries frame

**Files:**
- Modify: `agents/dashboard/routes/creatives.js` — `POST /api/creatives/generate` (~lines 280-484) and `POST /api/creatives/refine` (~lines 486-622)

**Interfaces:**
- Consumes: existing `productImagePaths`/`historyImagePaths` parsing in generate.
- Produces: generate persists `productImagePaths`, `historyImagePaths`, and (when custom) resizes the output to `customWidth`×`customHeight`; refine reads those from the previous version and re-attaches them plus the prior `aspectRatio`.

- [ ] **Step 1: Add `sharp` + model config imports at the top of `agents/dashboard/routes/creatives.js`**

Add after the existing imports (line ~6):

```javascript
import sharp from 'sharp';
import { CREATIVE_MODELS } from '../../../config/creative-models.js';
```

Then replace the template-from-image model (`model: 'claude-sonnet-4-6'`, ~line 56) with:

```javascript
            model: CREATIVE_MODELS.templateVision,
```

- [ ] **Step 2: In `/api/creatives/generate`, read custom dimensions and resize when custom**

After the block that writes the image to disk (after `writeFileSync(absImagePath, Buffer.from(imagePart.inlineData.data, 'base64'));`, ~line 433), insert:

```javascript
          // Honor a custom aspect ratio: Gemini can't target arbitrary WxH,
          // so resize the returned image to the requested pixel box.
          if (aspectRatio === 'custom') {
            const cw = parseInt(req.body.customWidth, 10);
            const ch = parseInt(req.body.customHeight, 10);
            if (cw > 0 && ch > 0) {
              const resized = await sharp(readFileSync(absImagePath))
                .resize(cw, ch, { fit: 'cover' }).toBuffer();
              writeFileSync(absImagePath, resized);
            }
          }
```

- [ ] **Step 3: Persist source image paths on the version object**

In the same handler, extend the `version` object (the one pushed to `session.versions`, ~line 439-447) to include the source paths so refine can re-attach them:

```javascript
          const version = {
            version: versionNum,
            imagePath,
            prompt,
            negativePrompt,
            model,
            aspectRatio,
            productImagePaths,
            historyImagePaths,
            createdAt: new Date().toISOString()
          };
```

- [ ] **Step 4: In `/api/creatives/refine`, carry the prior frame + product images**

In the refine handler, replace the Gemini `generateContent` call (~lines 548-561) with a version that re-attaches the previous version's product/history images and preserves aspect ratio:

```javascript
          // Re-attach the source product/history images so a refine keeps the
          // product in frame and doesn't drift the composition.
          const refineParts = [];
          const mimeMapRefine = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
          for (const relPath of (prevVersion.productImagePaths || [])) {
            const abs = join(ctx.PRODUCT_IMAGES_DIR, relPath);
            if (existsSync(abs)) {
              refineParts.push({ inlineData: { mimeType: mimeMapRefine[extname(abs).toLowerCase()] || 'image/jpeg', data: readFileSync(abs).toString('base64') } });
            }
          }
          refineParts.push({ inlineData: { mimeType: prevMimeType, data: prevImageData.toString('base64') } });
          refineParts.push({ text: 'Edit this image with the following changes: ' + refinement });

          const refineImageConfig = {};
          if (prevVersion.aspectRatio && prevVersion.aspectRatio !== 'custom') refineImageConfig.aspectRatio = prevVersion.aspectRatio;

          const result = await ctx.geminiClient.models.generateContent({
            model: geminiModel,
            contents: [{ role: 'user', parts: refineParts }],
            config: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: refineImageConfig,
            }
          });
```

- [ ] **Step 5: Carry source paths onto the refined version too**

In the refine handler, extend the `newVersion` object (~line 600-610) to inherit source paths:

```javascript
          const newVersion = {
            version: newVersionNum,
            imagePath,
            prompt: prevVersion.prompt,
            negativePrompt: prevVersion.negativePrompt,
            refinement,
            model: geminiModel,
            aspectRatio: prevVersion.aspectRatio,
            productImagePaths: prevVersion.productImagePaths || [],
            historyImagePaths: prevVersion.historyImagePaths || [],
            basedOnVersion: version,
            createdAt: new Date().toISOString()
          };
```

- [ ] **Step 6: Verify parse**

Run: `node --check agents/dashboard/routes/creatives.js`
Expected: no syntax error

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/routes/creatives.js
git commit -m "fix(creatives): honor custom aspect ratio; refine keeps frame + product images"
```

---

### Task 6: Frontend contract fix — Ad Set generation + polling

**Files:**
- Modify: `agents/dashboard/public/js/dashboard.js` — `packageCreative()` (~3361), `pollCreativePackage()` (~3381), `resetPackageBtn()` (~3398)

**Interfaces:**
- Consumes: `creativesState.sessionId`, `creativesState.currentVersion`, plus new `creativesState.adBuilder` fields `{ product, angle, destinationUrl }` (populated in Task 7; default to empty strings until then).
- Produces: `generateAdSet()` (replaces `packageCreative`) that checks `data.jobId` and calls `pollAdSet()`; `pollAdSet()` treats `status === 'complete'` as success and downloads via `/api/creatives/package/download/<jobId>`.

- [ ] **Step 1: Replace `packageCreative` with `generateAdSet`**

```javascript
async function generateAdSet() {
  if (!creativesState.sessionId || !creativesState.currentVersion) return;
  var btn = document.getElementById('creatives-package-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating ad set...'; }
  var ab = creativesState.adBuilder || {};
  try {
    var res = await fetch('/api/creatives/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        sessionId: creativesState.sessionId,
        version: creativesState.currentVersion,
        product: ab.product || '',
        angle: ab.angle || '',
        destinationUrl: ab.destinationUrl || ''
      })
    });
    var data = await res.json();
    if (!data.jobId) { resetPackageBtn(); showCreativesError(data.error || 'Ad set failed'); return; }
    pollAdSet(data.jobId);
  } catch (e) {
    resetPackageBtn();
    showCreativesError('Ad set failed: ' + e.message);
  }
}
```

- [ ] **Step 2: Replace `pollCreativePackage` with `pollAdSet`**

```javascript
function pollAdSet(jobId) {
  fetch('/api/creatives/package/' + encodeURIComponent(jobId), { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === 'complete') {
        resetPackageBtn();
        window.open('/api/creatives/package/download/' + encodeURIComponent(jobId), '_blank');
      } else if (data.status === 'error') {
        resetPackageBtn();
        showCreativesError(data.error || 'Ad set failed');
      } else {
        setTimeout(function() { pollAdSet(jobId); }, 3000);
      }
    })
    .catch(function(e) { resetPackageBtn(); showCreativesError('Polling failed: ' + e.message); });
}
```

- [ ] **Step 3: Update `resetPackageBtn` label**

```javascript
function resetPackageBtn() {
  var btn = document.getElementById('creatives-package-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '&#128230; Generate Ad Set'; }
}
```

- [ ] **Step 4: Manual verify (deferred to Task 9 full e2e)**

Run: `node --check agents/dashboard/public/js/dashboard.js`
Expected: no syntax error. (Behavioral verification happens in Task 9 once the button is wired in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/public/js/dashboard.js
git commit -m "fix(creatives): ad-set generation checks jobId and polls 'complete'"
```

---

### Task 7: Mode toggle + Ad Builder view; remove Studio Package button

**Files:**
- Modify: `agents/dashboard/public/index.html` — creatives top bar (~167-188) and package wrap (~291-293)
- Modify: `agents/dashboard/public/js/dashboard.js` — `creativesState` (~2814), add mode + Ad Builder functions

**Interfaces:**
- Consumes: `generateCreativeImage()`, `generateAdSet()`, `creativesState`, `document.getElementById('creatives-prompt')`.
- Produces: `switchCreativesMode(mode)`, `creativesState.mode`, `creativesState.adBuilder`, `generateHero()`, `syncModeUI()`. Studio's Package button becomes Ad Builder's step-3 button, shown only in Ad Builder mode.

- [ ] **Step 1: Add the mode toggle to the top bar**

In `index.html`, immediately inside the top-bar `<div ...border-bottom...>` (after line ~167 opening), add as the first children:

```html
    <div id="creatives-mode-toggle" style="display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-right:0.5rem">
      <button id="mode-studio-btn" onclick="switchCreativesMode('studio')" class="creatives-mode-btn active" style="padding:0.3rem 0.8rem;border:none;background:var(--accent);color:#fff;font-size:0.82rem;cursor:pointer">Studio</button>
      <button id="mode-adbuilder-btn" onclick="switchCreativesMode('adbuilder')" class="creatives-mode-btn" style="padding:0.3rem 0.8rem;border:none;background:var(--surface);color:var(--fg);font-size:0.82rem;cursor:pointer">Ad Builder</button>
    </div>
```

- [ ] **Step 2: Add the Ad Builder step panel to the LEFT panel**

In `index.html`, inside the LEFT panel `<div ...border-right...>` (~line 192), add as its first child (before Product Context, ~line 193):

```html
      <div id="adbuilder-panel" style="display:none;border:1px solid var(--accent);border-radius:7px;padding:0.75rem;background:var(--card)">
        <div style="font-size:0.82rem;font-weight:700;margin-bottom:0.5rem">Ad Builder</div>
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.2rem">PRODUCT</label>
        <input id="adbuilder-product" type="text" placeholder="e.g. Sensitive Skin Set" style="width:100%;box-sizing:border-box;padding:0.4rem;border:1px solid var(--border);border-radius:5px;font-size:0.82rem;margin-bottom:0.5rem">
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.2rem">ANGLE / OFFER</label>
        <input id="adbuilder-angle" type="text" placeholder="e.g. gentle for reactive skin" style="width:100%;box-sizing:border-box;padding:0.4rem;border:1px solid var(--border);border-radius:5px;font-size:0.82rem;margin-bottom:0.5rem">
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.2rem">DESTINATION URL (PDP / collection)</label>
        <input id="adbuilder-desturl" type="text" placeholder="https://www.realskincare.com/products/..." style="width:100%;box-sizing:border-box;padding:0.4rem;border:1px solid var(--border);border-radius:5px;font-size:0.82rem;margin-bottom:0.5rem">
        <button onclick="generateHero()" style="width:100%;padding:0.55rem;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:0.88rem;font-weight:700;cursor:pointer">Generate Hero</button>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:0.4rem">Then approve/refine the hero on the right, and Generate Ad Set.</div>
      </div>
```

- [ ] **Step 3: Relabel the package button (it becomes the Ad Builder step-3 action) and default it hidden**

In `index.html`, replace the package wrap block (~lines 291-293) with:

```html
      <div id="creatives-package-wrap" style="display:none;border-top:1px solid var(--border);padding-top:0.75rem">
        <button id="creatives-package-btn" onclick="generateAdSet()" style="padding:0.6rem 1.25rem;background:#0f172a;color:white;border:none;border-radius:7px;font-size:0.88rem;font-weight:600;cursor:pointer">&#128230; Generate Ad Set</button>
      </div>
```

- [ ] **Step 4: Add mode state + functions in `dashboard.js`**

Find the `creativesState` object (~line 2815) and add `mode` and `adBuilder`:

```javascript
// inside the creativesState initializer object, add:
  mode: 'studio',
  adBuilder: { product: '', angle: '', destinationUrl: '' },
```

Then add these functions near `renderCreativesTab` (~line 2827):

```javascript
function switchCreativesMode(mode) {
  creativesState.mode = mode;
  syncModeUI();
}

function syncModeUI() {
  var isAd = creativesState.mode === 'adbuilder';
  var studioBtn = document.getElementById('mode-studio-btn');
  var adBtn = document.getElementById('mode-adbuilder-btn');
  if (studioBtn) { studioBtn.style.background = isAd ? 'var(--surface)' : 'var(--accent)'; studioBtn.style.color = isAd ? 'var(--fg)' : '#fff'; }
  if (adBtn) { adBtn.style.background = isAd ? 'var(--accent)' : 'var(--surface)'; adBtn.style.color = isAd ? '#fff' : 'var(--fg)'; }
  var adPanel = document.getElementById('adbuilder-panel');
  if (adPanel) adPanel.style.display = isAd ? 'block' : 'none';
  // Studio's free-prompt fields hide in Ad Builder (hero prompt is generated).
  var promptEl = document.getElementById('creatives-prompt');
  var promptWrap = promptEl ? promptEl.closest('div') : null;
  if (promptWrap) promptWrap.style.display = isAd ? 'none' : 'block';
  // Package/Ad-Set action only in Ad Builder.
  var pkgWrap = document.getElementById('creatives-package-wrap');
  if (pkgWrap) pkgWrap.style.display = isAd ? 'block' : 'none';
}

function generateHero() {
  creativesState.adBuilder = {
    product: (document.getElementById('adbuilder-product') || {}).value || '',
    angle: (document.getElementById('adbuilder-angle') || {}).value || '',
    destinationUrl: (document.getElementById('adbuilder-desturl') || {}).value || ''
  };
  if (!creativesState.adBuilder.product.trim()) { showCreativesError('Enter a product for the hero.'); return; }
  // Seed the studio prompt with a product+angle hero brief, then reuse generate.
  var promptEl = document.getElementById('creatives-prompt');
  if (promptEl) {
    promptEl.value = 'Clean, bright product photography of ' + creativesState.adBuilder.product
      + (creativesState.adBuilder.angle ? ', conveying: ' + creativesState.adBuilder.angle : '')
      + '. Natural light, minimal on-brand background, product as hero. No text, logos, or labels.';
  }
  generateCreativeImage();
}
```

- [ ] **Step 5: Call `syncModeUI()` when the tab renders**

In `renderCreativesTab` (after it loads models/templates/sessions, near the end of the try block ~line 2847), add:

```javascript
    syncModeUI();
```

- [ ] **Step 6: Verify parse and manual UI smoke**

Run: `node --check agents/dashboard/public/js/dashboard.js`
Expected: no syntax error. Load the dashboard, open Creatives: the Studio/Ad Builder toggle switches the left panel and shows/hides the Ad Set button.

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js
git commit -m "feat(creatives): Studio/Ad Builder mode toggle + hero flow; ad-set button gated to Ad Builder"
```

---

### Task 8: UI cohesion — CSS variables, shared classes, `--accent`

**Files:**
- Modify: `agents/dashboard/public/dashboard.css` — add `--accent` var + `.creatives-*` classes
- Modify: `agents/dashboard/public/index.html` — swap the most-repeated inline styles for classes

**Interfaces:**
- Consumes: existing CSS vars `--border`, `--surface`, `--card`, `--fg`, `--muted`, `--bg`.
- Produces: `--accent` (light + dark), `.creatives-select`, `.creatives-primary-btn`, `.ar-btn` styling, used by both pathways.

- [ ] **Step 1: Add `--accent` and shared classes to `dashboard.css`**

Append:

```css
/* Creatives — shared tokens + component classes (both pathways) */
:root { --accent: #6c5ce7; }
:root[data-theme="dark"] { --accent: #8b7cf0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --accent: #8b7cf0; } }

.creatives-select {
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 5px;
  font-size: 0.82rem;
  background: var(--surface);
  color: var(--fg);
}
.creatives-primary-btn {
  padding: 0.65rem;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 7px;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
}
.ar-btn {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
}
.ar-btn.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
```

- [ ] **Step 2: Apply the classes to the highest-churn elements in `index.html`**

- Replace each of the four `<select id="creatives-*-select" ... style="padding:0.3rem 0.6rem;border:1px solid var(--border);border-radius:5px;font-size:0.82rem;background:var(--surface)">` openings so they use `class="creatives-select"` and drop the duplicated inline `style` (keep any `margin-left` inline if present).
- Replace the Generate Image button's inline style (`onclick="generateCreativeImage()" style="padding:0.65rem;background:#6c5ce7;...flex:1"`) with `class="creatives-primary-btn" style="flex:1"`.
- The `.ar-btn` buttons already carry the class; remove their now-redundant inline `border`/`background` so the CSS class drives them (keep `padding`/`border-radius`/`font-size` inline or move to `.ar-btn` — your call, but no hardcoded `#6c5ce7`).

- [ ] **Step 3: Grep to confirm the accent hex is no longer hardcoded in the creatives markup**

Run: `grep -n "#6c5ce7" agents/dashboard/public/index.html`
Expected: no matches inside the `#tab-creatives` block (the toggle/panel added in Task 7 already use `var(--accent)`; update any that don't).

- [ ] **Step 4: Verify dashboard still loads**

Load the dashboard; confirm Creatives renders correctly in both light and dark theme and both pathways look identical in styling.

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/public/dashboard.css agents/dashboard/public/index.html
git commit -m "style(creatives): CSS variables + shared component classes; single --accent token"
```

---

### Task 9: End-to-end verification on one session + legacy regression

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `node --test 'tests/**/*.test.js'`
Expected: PASS (includes `config/creative-models.test.js` and `agents/creative-packager.test.js`).

- [ ] **Step 2: Studio pathway e2e**

Load the dashboard → Creatives → Studio. Enter a prompt, add a product reference image, Generate. Confirm the image renders, Refine works, and Download returns the image. Confirm there is no Package button in Studio.

- [ ] **Step 3: Ad Builder pathway e2e (single session — project rule #4)**

Switch to Ad Builder. Enter product, angle, and a real PDP URL. Generate Hero → approve (or Regenerate once). Click **Generate Ad Set**. Confirm: the button shows progress, a ZIP downloads containing `images/*.webp` at the placement sizes, `copy.txt`, `specs.txt`, and `manifest.json` whose `destinationUrl` matches what you entered.

- [ ] **Step 4: Legacy Ad Intelligence regression**

From the Ad Intelligence tab, use an existing "Generate Creative" button on an ad; confirm it still produces a downloadable ZIP (the `source: 'ad'` packager branch).

- [ ] **Step 5: Confirm no stale model IDs remain**

Run: `grep -rn "claude-opus-4-6\|claude-sonnet-4-6\|gemini-2.0-flash-preview-image-generation" agents/creative-packager agents/dashboard/routes/creatives.js`
Expected: no matches (template-from-image and packager now use the config). Note: `agents/dashboard/routes/ads.js` and `chat.js` still reference `claude-sonnet-4-6` and are out of scope for this plan — leave them.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feature/creatives-two-pathways
gh pr create --title "Creatives: two pathways (Studio + Ad Builder), fixed packaging, model + UI refresh" --body "Implements docs/superpowers/specs/2026-07-23-creatives-two-pathways-design.md. See plan docs/superpowers/plans/2026-07-23-creatives-two-pathways.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review

**Spec coverage:**
- Two pathways over shared canvas → Tasks 6–7. ✔
- Mode toggle in one tab → Task 7. ✔
- Source-agnostic packager (no adId), session hero → placements → Tasks 2–4. ✔
- Frontend contract fix (jobId + 'complete') → Task 6. ✔
- Manifest with destination URL → Tasks 2–4 (route supplies `copyBrief.destinationUrl`, packager writes `manifest.json`). ✔
- Custom aspect ratio + refine carries frame → Task 5. ✔
- Centralized models (Opus 4.8 copy, Haiku elsewhere, unified Gemini) → Tasks 1–3, 5 (template-vision in Task 5 note). ✔
- UI cohesion (CSS vars, classes, --accent) → Task 8. ✔
- Legacy Ad Intelligence flow preserved → Task 3 (`source: 'ad'` branch), Task 9 regression. ✔

**Placeholder scan:** No TBD/TODO/"handle edge cases" — all steps carry concrete code or exact commands. ✔

**Type consistency:** `generateAdSet`/`pollAdSet`/`resetPackageBtn`, `CREATIVE_MODELS.{adCopy,styleBrief,templateVision,sessionName,imageGen}`, job fields `{source, heroImagePath, copyBrief, placements}`, and version fields `{productImagePaths, historyImagePaths, aspectRatio}` are used identically across tasks. ✔
