# Ad Builder Reference-Driven Variations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape Ad Builder into a reference-driven flow — upload an ad you like → generate style-inspired variations featuring our products → select → output a placement ZIP with clean plates, low-res layout guides, a full-res master, and copy.

**Architecture:** Extends the already-merged two-pathways build. New thin vision endpoint extracts a style brief from the uploaded ad; the existing generate endpoint (extended to take reference-image paths) produces N variations as session versions; the source-agnostic packager (extended with size-by-name selection, a full-res master, and programmatic guide images) outputs the ZIP.

**Tech Stack:** Node.js ESM, `node --test`, plain-HTTP dashboard routes, `@google/genai`, `lib/anthropic.js`, `sharp` (resize + SVG composite), `archiver`.

## Global Constraints

- Branch `feature/ad-builder-variations` (already created off main); never commit to `main`; merge via PR. Test one flow end-to-end before bulk (rules #1–#5).
- Model IDs (exact, from `config/creative-models.js`): ad copy `claude-opus-4-8`; style/vision + template + session-name `claude-haiku-4-5`; image `gemini-2.5-flash-image`.
- The six Meta static placements (exact `name`s): `instagram-feed-1080x1080`, `instagram-feed-1080x1350`, `instagram-stories-1080x1920`, `facebook-feed-1200x628`, `facebook-feed-1080x1080`, `facebook-stories-1080x1920`.
- No baked-in text in generated images. Guides are drawn programmatically (SVG→PNG via sharp), low-res.
- Studio behavior unchanged; only Ad Builder changes.
- ESM; `node --test 'tests/**/*.test.js'`; test files are plain scripts using `import { strict as assert } from 'node:assert'` with top-level assertion blocks.
- Dashboard browser JS in `public/` is normal JS (no template-literal escaping); the creatives markup is static HTML in `index.html`.

---

### Task 1: Add `styleVision` model to config

**Files:**
- Modify: `config/creative-models.js`
- Modify: `tests/config/creative-models.test.js`

**Interfaces:**
- Produces: `CREATIVE_MODELS.styleVision === 'claude-haiku-4-5'`.

- [ ] **Step 1: Add the failing assertion (append inside the existing test file, before the final `console.log`)**

```javascript
assert.equal(CREATIVE_MODELS.styleVision, 'claude-haiku-4-5', 'reference-ad style extraction uses Haiku vision');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config/creative-models.test.js`
Expected: FAIL — `styleVision` is undefined.

- [ ] **Step 3: Add the field to `config/creative-models.js`**

Add inside the `CREATIVE_MODELS` object (after `templateVision`):

```javascript
  styleVision: 'claude-haiku-4-5',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config/creative-models.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add config/creative-models.js tests/config/creative-models.test.js
git commit -m "feat(ad-builder): add styleVision model for reference-ad analysis"
```

---

### Task 2: Packager pure helpers — size selection + guide rendering

**Files:**
- Modify: `agents/creative-packager/index.js` (add exports near the other pure exports, after `formatManifest`)
- Modify: `tests/agents/creative-packager.test.js` (append)

**Interfaces:**
- Consumes: the existing `PLACEMENT_MAP`.
- Produces:
  - `ALL_PLACEMENTS` — flattened array of all six size objects (`{name,width,height,label}`).
  - `sizesByName(names)` → the size objects whose `name` is in `names`, in `ALL_PLACEMENTS` order.
  - `safeZonesFor(sizeName)` → `{top,bottom,left,right}` px insets (stories get large top/bottom UI margins; feed sizes get ~6%).
  - `buildGuideSvg(size, copy)` → SVG string (`size` = `{name,width,height}`, `copy` = `{headline,body,cta}`) containing the copy text, a SAFE ZONE marker, and correct `width`/`height`.

- [ ] **Step 1: Write the failing tests (append to `tests/agents/creative-packager.test.js`)**

```javascript
import { ALL_PLACEMENTS, sizesByName, safeZonesFor, buildGuideSvg } from '../../agents/creative-packager/index.js';

// ALL_PLACEMENTS has all six
{
  assert.equal(ALL_PLACEMENTS.length, 6);
  const names = ALL_PLACEMENTS.map(s => s.name);
  assert.ok(names.includes('instagram-stories-1080x1920'));
  assert.ok(names.includes('facebook-feed-1200x628'));
}

// sizesByName filters to requested, in ALL_PLACEMENTS order, ignoring unknowns
{
  const got = sizesByName(['facebook-feed-1200x628', 'instagram-feed-1080x1080', 'bogus']);
  assert.equal(got.length, 2);
  assert.ok(got.every(s => typeof s.width === 'number'));
  assert.ok(got.some(s => s.name === 'instagram-feed-1080x1080'));
}

// safeZonesFor: stories get big top/bottom; feed gets ~6% margins
{
  const story = safeZonesFor('instagram-stories-1080x1920');
  assert.ok(story.top >= 200 && story.bottom >= 300, 'story reserves UI margins');
  const feed = safeZonesFor('facebook-feed-1080x1080');
  assert.ok(feed.top > 0 && feed.top < 200);
  const unknown = safeZonesFor('nope');
  assert.deepEqual(unknown, { top: 0, bottom: 0, left: 0, right: 0 });
}

// buildGuideSvg: contains copy text, safe-zone marker, correct dims
{
  const size = { name: 'instagram-stories-1080x1920', width: 1080, height: 1920 };
  const svg = buildGuideSvg(size, { headline: 'Fresh All Day', body: 'Coconut clean', cta: 'Shop Now' });
  assert.ok(svg.includes('width="1080"') && svg.includes('height="1920"'));
  assert.ok(svg.includes('Fresh All Day'));
  assert.ok(svg.includes('Coconut clean'));
  assert.ok(svg.includes('Shop Now'));
  assert.ok(svg.includes('SAFE ZONE'));
  assert.ok(svg.trim().startsWith('<svg'));
}

// buildGuideSvg escapes XML-special chars in copy
{
  const size = { name: 'facebook-feed-1080x1080', width: 1080, height: 1080 };
  const svg = buildGuideSvg(size, { headline: 'Tom & Jerry', body: '<b>', cta: 'Go' });
  assert.ok(svg.includes('Tom &amp; Jerry'));
  assert.ok(!svg.includes('<b>'));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/creative-packager.test.js`
Expected: FAIL — the four exports are undefined.

- [ ] **Step 3: Add the implementations to `agents/creative-packager/index.js` (after `formatManifest`)**

```javascript
export const ALL_PLACEMENTS = [...PLACEMENT_MAP.instagram, ...PLACEMENT_MAP.facebook];

/** Return the size objects matching the given names, in ALL_PLACEMENTS order. */
export function sizesByName(names) {
  const want = new Set(names || []);
  return ALL_PLACEMENTS.filter(s => want.has(s.name));
}

/** Safe-area insets (px) per placement. Stories reserve platform-UI margins. */
export function safeZonesFor(sizeName) {
  const s = ALL_PLACEMENTS.find(p => p.name === sizeName);
  if (!s) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (sizeName.includes('stories')) {
    return { top: 250, bottom: 340, left: 60, right: 60 };
  }
  return {
    top: Math.round(s.height * 0.06),
    bottom: Math.round(s.height * 0.06),
    left: Math.round(s.width * 0.06),
    right: Math.round(s.width * 0.06),
  };
}

/** Build a layout-guide SVG: border, dashed safe zone, and copy placed in it. */
export function buildGuideSvg(size, copy) {
  const z = safeZonesFor(size.name);
  const W = size.width, H = size.height;
  const safeW = W - z.left - z.right, safeH = H - z.top - z.bottom;
  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cx = W / 2;
  const headlineY = z.top + safeH * 0.62;
  const bodyY = z.top + safeH * 0.74;
  const ctaY = z.top + safeH * 0.86;
  const fs = Math.max(12, Math.round(W * 0.045));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ff2d55" stroke-width="4"/>
  <rect x="${z.left}" y="${z.top}" width="${safeW}" height="${safeH}" fill="none" stroke="#00c2ff" stroke-width="3" stroke-dasharray="16 12"/>
  <text x="${z.left + 8}" y="${z.top + Math.round(W * 0.035)}" font-family="Arial, sans-serif" font-size="${Math.round(W * 0.028)}" fill="#00c2ff">SAFE ZONE</text>
  <text x="${cx}" y="${headlineY}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#111">${esc(copy && copy.headline)}</text>
  <text x="${cx}" y="${bodyY}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.round(fs * 0.6)}" fill="#333">${esc(copy && copy.body)}</text>
  <rect x="${cx - W * 0.16}" y="${ctaY - fs * 0.7}" width="${W * 0.32}" height="${fs * 1.1}" rx="${fs * 0.2}" fill="#111"/>
  <text x="${cx}" y="${ctaY}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="${Math.round(fs * 0.55)}" fill="#fff">${esc(copy && copy.cta)}</text>
</svg>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/creative-packager.test.js`
Expected: PASS (existing blocks still pass)

- [ ] **Step 5: Commit**

```bash
git add agents/creative-packager/index.js tests/agents/creative-packager.test.js
git commit -m "feat(ad-builder): size-by-name selection + layout-guide SVG helpers"
```

---

### Task 3: Packager main() — size selection, master.webp, guides/*.png

**Files:**
- Modify: `agents/creative-packager/index.js` — `main()` (size selection + zip assembly)

**Interfaces:**
- Consumes: `sizesByName`, `buildGuideSvg` (Task 2); existing `sharp`, `createZip`.
- Produces: for a `source: 'session'` job, uses `job.sizes` (size names) when present; the ZIP gains `master.webp` (full-res hero, webp q92) and `guides/<size>.png` (low-res composite of downscaled hero + guide SVG) for each size. Guide generation is best-effort (a per-size failure is logged and skipped, never fails the ZIP).

No unit test (orchestration); verified e2e in Task 7.

- [ ] **Step 1: Update the size resolution in `main()`**

Where `sizes` is computed in the session branch, replace with a `job.sizes` preference. In the session branch (`if (source === 'session')`), change the `sizes = placementSizes(...)` line to:

```javascript
    sizes = (job.sizes && job.sizes.length)
      ? sizesByName(job.sizes)
      : placementSizes(job.placements && job.placements.length ? job.placements : ['instagram', 'facebook']);
    if (!sizes.length) sizes = placementSizes(['instagram', 'facebook']);
```

- [ ] **Step 2: Add master.webp + guides to the zip assembly**

In `main()`, after `generatedImages` is built and `copyVariations` is parsed, and after the base `zipFiles` array is created (the one with copy.txt/specs.txt/manifest.json), insert BEFORE the `for (const { size, buffer } of generatedImages)` loop:

```javascript
  // Full-resolution clean master (max canvas for compositing).
  try {
    const master = await (await import('sharp')).default(heroBufferForMaster).webp({ quality: 92 }).toBuffer();
    zipFiles.push({ name: 'master.webp', content: master });
  } catch (e) { console.warn('  master.webp skipped:', e.message); }

  // Low-res layout guides: downscaled background + copy placed in safe zones.
  const guideCopy = (copyVariations && copyVariations[0]) || { headline: '', body: '', cta: '' };
  const sharpLib = (await import('sharp')).default;
  for (const size of sizes) {
    try {
      const bg = await sharpLib(heroBufferForMaster).resize(size.width, size.height, { fit: 'cover' }).toBuffer();
      const svg = buildGuideSvg(size, guideCopy);
      const composited = await sharpLib(bg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
      const scale = Math.min(1, 540 / Math.max(size.width, size.height));
      const lowres = await sharpLib(composited)
        .resize(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)))
        .png().toBuffer();
      zipFiles.push({ name: `guides/${size.name}.png`, content: lowres });
    } catch (e) { console.warn(`  guide ${size.name} skipped:`, e.message); }
  }
```

- [ ] **Step 3: Make the hero buffer available for master/guides in BOTH branches**

The session branch already reads `heroBuffer`. The legacy branch generates per-size images and has no single hero. Add, right after `sizes` is finalized in each branch, a `heroBufferForMaster`:
- In the **session** branch, after loading `heroBuffer`: `const heroBufferForMaster = heroBuffer;` (hoist this variable to `main()` scope with `let heroBufferForMaster = null;` declared near the top alongside `let brief; let sizes;`).
- In the **legacy** branch, set `heroBufferForMaster = generatedImages[0] && generatedImages[0].buffer` after the per-size loop (use the first generated image as the master source).

Guard the master/guide blocks with `if (heroBufferForMaster) { ... }` so a legacy job with zero images doesn't throw.

- [ ] **Step 4: Verify syntax + existing tests**

Run: `node --check agents/creative-packager/index.js && node --test tests/agents/creative-packager.test.js`
Expected: no syntax error; PASS

- [ ] **Step 5: Commit**

```bash
git add agents/creative-packager/index.js
git commit -m "feat(ad-builder): master.webp + low-res layout guides; job.sizes selection"
```

---

### Task 4: Routes — analyze-reference, generate referenceImagePaths, package sizes

**Files:**
- Modify: `agents/dashboard/routes/creatives.js`

**Interfaces:**
- Produces:
  - `POST /api/creatives/analyze-reference` — body `{ referenceImage: <filename in REFERENCE_IMAGES_DIR> }` → `{ stylePrompt }` (Claude `CREATIVE_MODELS.styleVision` vision; style only, no product/text/layout).
  - `POST /api/creatives/generate` also reads `referenceImagePaths` (JSON array of filenames in `REFERENCE_IMAGES_DIR`) and adds them as Gemini inlineData parts.
  - `POST /api/creatives/package` also reads `sizes` (JSON array of size names) → `job.sizes`.

- [ ] **Step 1: Add the analyze-reference route (place near the other exact-match POST routes, e.g. after `templates/from-image`)**

```javascript
  // POST /api/creatives/analyze-reference
  {
    method: 'POST',
    match: '/api/creatives/analyze-reference',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }
        const filename = payload.referenceImage;
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'referenceImage required' })); return;
        }
        const absPath = join(ctx.REFERENCE_IMAGES_DIR, filename);
        if (!existsSync(absPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Reference image not found' })); return;
        }
        try {
          const imgData = readFileSync(absPath);
          const ext = extname(absPath).toLowerCase();
          const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
          const client = new Anthropic();
          const message = await client.messages.create({
            model: CREATIVE_MODELS.styleVision,
            max_tokens: 400,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mimeMap[ext] || 'image/jpeg', data: imgData.toString('base64') } },
                { type: 'text', text: 'Analyze this ad’s visual STYLE only — mood, lighting, composition, color palette, and setting. Write a concise image-generation prompt that recreates this AESTHETIC for a NEW product photo of a different product. Do NOT describe the specific product shown, any brand, logos, or text. Return ONLY the prompt, no preamble.' }
              ]
            }]
          });
          const stylePrompt = (message.content[0] && message.content[0].text || '').trim();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stylePrompt }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  },
```

- [ ] **Step 2: Add referenceImagePaths to the generate handler**

In `POST /api/creatives/generate`, after the block that adds `historyImagePaths`, add a symmetric block:

```javascript
          // Add reference-ad images from REFERENCE_IMAGES_DIR (style cue, not re-uploaded per call)
          let referenceImagePaths = [];
          try {
            const rawRef = req.body.referenceImagePaths;
            if (rawRef) referenceImagePaths = Array.isArray(rawRef) ? rawRef : JSON.parse(rawRef);
          } catch {}
          for (const relPath of referenceImagePaths) {
            const absPath = join(ctx.REFERENCE_IMAGES_DIR, relPath);
            if (existsSync(absPath)) {
              const imgData = readFileSync(absPath);
              const ext = extname(absPath).toLowerCase();
              const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
              parts.push({ inlineData: { mimeType: mimeMap[ext] || 'image/jpeg', data: imgData.toString('base64') } });
            }
          }
```

Also persist them on the version object (alongside `productImagePaths`/`historyImagePaths`): add `referenceImagePaths,` to the `version` object.

- [ ] **Step 3: Add sizes to the package handler**

In `POST /api/creatives/package`, extend the destructure and the job:
- Change `const { sessionId, product, angle, destinationUrl, placements } = payload;` to also pull `sizes`:
  `const { sessionId, product, angle, destinationUrl, placements, sizes } = payload;`
- In `jobData`, add: `sizes: Array.isArray(sizes) ? sizes : [],`

- [ ] **Step 4: Verify syntax**

Run: `node --check agents/dashboard/routes/creatives.js`
Expected: no syntax error

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/routes/creatives.js
git commit -m "feat(ad-builder): analyze-reference route; generate reference paths; package sizes"
```

---

### Task 5: Frontend — reference-driven Ad Builder panel + variation generation

**Files:**
- Modify: `agents/dashboard/public/index.html` — replace the `#adbuilder-panel` inner markup
- Modify: `agents/dashboard/public/js/dashboard.js` — Ad Builder state + functions

**Interfaces:**
- Consumes: existing `/api/creatives/reference-images` (upload), `/api/creatives/analyze-reference`, `/api/creatives/generate`, `openProductImageModal`/product picker, `showCreativesSpinner`/`hideCreativesSpinner`/`showCreativesError`, `creativesState`.
- Produces: `creativesState.adBuilder = { referenceAd, products, variationCount, destinationUrl, sizes, variationVersions }`; functions `uploadAdBuilderReference(input)`, `pickAdBuilderProducts()`, `generateVariations()`, `renderVariationGrid()`, `selectVariation(version)`.

- [ ] **Step 1: Replace the `#adbuilder-panel` markup in `index.html`**

Replace the inner content of `<div id="adbuilder-panel" ...>` with:

```html
        <div style="font-size:0.82rem;font-weight:700;margin-bottom:0.5rem">Ad Builder</div>
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.2rem">1. REFERENCE AD YOU LIKE</label>
        <input type="file" id="adbuilder-ref-input" accept="image/*" onchange="uploadAdBuilderReference(this)" style="display:none">
        <button onclick="document.getElementById('adbuilder-ref-input').click()" style="width:100%;padding:0.5rem;border:1px dashed var(--border);border-radius:6px;background:var(--surface);cursor:pointer;font-size:0.82rem;margin-bottom:0.35rem">Upload reference ad</button>
        <div id="adbuilder-ref-thumb" style="margin-bottom:0.5rem"></div>
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.2rem">2. OUR PRODUCT(S) TO FEATURE</label>
        <button onclick="pickAdBuilderProducts()" style="width:100%;padding:0.45rem;border:1px solid var(--accent);border-radius:6px;background:var(--surface);color:var(--accent);cursor:pointer;font-size:0.82rem;font-weight:600;margin-bottom:0.35rem">+ Add products</button>
        <div id="adbuilder-products-thumb" style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.5rem"></div>
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.2rem">DESTINATION URL (PDP / collection)</label>
        <input id="adbuilder-desturl" type="text" placeholder="https://www.realskincare.com/products/..." style="width:100%;box-sizing:border-box;padding:0.4rem;border:1px solid var(--border);border-radius:5px;font-size:0.82rem;margin-bottom:0.5rem">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
          <label style="font-size:0.75rem;color:var(--muted)">Variations</label>
          <select id="adbuilder-count" class="creatives-select"><option>2</option><option selected>4</option><option>6</option></select>
        </div>
        <button onclick="generateVariations()" class="creatives-primary-btn" style="width:100%">Generate Variations</button>
```

- [ ] **Step 2: Extend `creativesState` and add the Ad Builder functions in `dashboard.js`**

Replace `adBuilder: { product: '', angle: '', destinationUrl: '' }` in the `creativesState` initializer with:

```javascript
  adBuilder: { referenceAd: null, products: [], variationCount: 4, destinationUrl: '', sizes: [], variationVersions: [] },
```

Add these functions near `generateHero` (which you will remove — see Step 4):

```javascript
async function uploadAdBuilderReference(input) {
  if (!input.files || !input.files.length) return;
  var fd = new FormData();
  fd.append('image', input.files[0]);
  try {
    var res = await fetch('/api/creatives/reference-images', { method: 'POST', credentials: 'same-origin', body: fd });
    var data = await res.json();
    if (data.error) { showCreativesError(data.error); return; }
    creativesState.adBuilder.referenceAd = data.filename;
    var thumb = document.getElementById('adbuilder-ref-thumb');
    if (thumb) thumb.innerHTML = '<img src="/api/creatives/reference-image/' + encodeURIComponent(data.filename) + '" style="max-width:100%;max-height:120px;border-radius:6px;border:1px solid var(--border)">';
  } catch (e) { showCreativesError('Reference upload failed: ' + e.message); }
  input.value = '';
}

function pickAdBuilderProducts() {
  // Reuse the product picker modal; it calls addAdBuilderProduct(path) on selection.
  openProductImageModal('adbuilder');
}

function addAdBuilderProduct(path) {
  if (creativesState.adBuilder.products.indexOf(path) === -1) creativesState.adBuilder.products.push(path);
  var el = document.getElementById('adbuilder-products-thumb');
  if (el) {
    el.innerHTML = creativesState.adBuilder.products.map(function(p) {
      return '<img src="/api/creatives/product-image/' + encodeURIComponent(p) + '" style="width:44px;height:44px;object-fit:cover;border-radius:5px;border:1px solid var(--border)">';
    }).join('');
  }
}

async function generateVariations() {
  var ab = creativesState.adBuilder;
  ab.destinationUrl = (document.getElementById('adbuilder-desturl') || {}).value || '';
  ab.variationCount = parseInt((document.getElementById('adbuilder-count') || {}).value, 10) || 4;
  if (!ab.referenceAd) { showCreativesError('Upload a reference ad first.'); return; }
  // Ensure a session exists
  if (!creativesState.sessionId) {
    try {
      var sres = await fetch('/api/creatives/sessions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      var s = await sres.json();
      creativesState.sessionId = s.id; creativesState.sessions.unshift(s); renderCreativesSessions();
    } catch (e) { showCreativesError('Could not create session: ' + e.message); return; }
  }
  // 1. Extract style brief from the reference ad
  showCreativesSpinner('Reading the ad’s style...');
  var stylePrompt = '';
  try {
    var ares = await fetch('/api/creatives/analyze-reference', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ referenceImage: ab.referenceAd }) });
    var adata = await ares.json();
    stylePrompt = adata.stylePrompt || '';
  } catch (e) { /* fall back to generic below */ }
  if (!stylePrompt) stylePrompt = 'Clean, bright, professional product advertising photography with natural light and a minimal on-brand background.';
  var fullPrompt = stylePrompt + '\n\nFeature the provided product prominently as the hero. Do NOT include any text, logos, or labels in the image.';
  // 2. Generate N variations (each is a session version)
  ab.variationVersions = [];
  for (var i = 0; i < ab.variationCount; i++) {
    showCreativesSpinner('Generating variation ' + (i + 1) + ' of ' + ab.variationCount + '...');
    var fd = new FormData();
    fd.append('sessionId', creativesState.sessionId);
    fd.append('prompt', fullPrompt);
    fd.append('aspectRatio', '1:1');
    fd.append('model', (document.getElementById('creatives-model-select') || {}).value || '');
    if (ab.products.length) fd.append('productImagePaths', JSON.stringify(ab.products));
    fd.append('referenceImagePaths', JSON.stringify([ab.referenceAd]));
    try {
      var gres = await fetch('/api/creatives/generate', { method: 'POST', credentials: 'same-origin', body: fd });
      var gdata = await gres.json();
      if (gdata.imagePath) { ab.variationVersions.push({ version: gdata.version, imagePath: gdata.imagePath }); renderVariationGrid(); }
    } catch (e) { /* continue with the rest */ }
  }
  hideCreativesSpinner();
  if (!ab.variationVersions.length) showCreativesError('No variations were generated. Try again or adjust the reference/product.');
}
```

- [ ] **Step 3: Confirm the product picker can call `addAdBuilderProduct`**

Find `openProductImageModal` in `dashboard.js`. It currently adds picked products to the Studio state. Give it an optional target: when called as `openProductImageModal('adbuilder')`, its selection handler calls `addAdBuilderProduct(path)` instead of the Studio path. Locate where the modal confirms a selection and branch on a module-level `var productPickerTarget` set at open time:

```javascript
// at the top of openProductImageModal(target) — add a param and store it:
//   productPickerTarget = target || 'studio';
// where a product is chosen, branch:
//   if (productPickerTarget === 'adbuilder') { addAdBuilderProduct(path); }
//   else { /* existing studio behavior */ }
```

Declare `var productPickerTarget = 'studio';` near the other creatives module vars. (If `openProductImageModal` takes no arg today, add the `target` parameter and default it.)

- [ ] **Step 4: Remove the obsolete `generateHero` and update `syncModeUI`**

Delete the `generateHero` function (product+angle hero is gone). In `syncModeUI`, the Ad Builder panel now contains its own controls, so no change is needed to its show/hide logic — but ensure the free-prompt field stays hidden in Ad Builder (already the case). Leave the `#creatives-package-wrap` gating as-is (Task 6 adds the placement checklist next to it).

- [ ] **Step 5: Verify + manual smoke**

Run: `node --check agents/dashboard/public/js/dashboard.js`
Expected: no syntax error. (Functional check happens in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js
git commit -m "feat(ad-builder): reference-driven panel + N-variation generation"
```

---

### Task 6: Frontend — variation grid, selection, placement checklist, wire output

**Files:**
- Modify: `agents/dashboard/public/index.html` — add a variation grid container + placement checklist near the package button
- Modify: `agents/dashboard/public/js/dashboard.js` — `renderVariationGrid`, `selectVariation`, placement collection in `generateAdSet`

**Interfaces:**
- Consumes: `creativesState.adBuilder.variationVersions`, `showCreativeImage`, `creativesState.currentVersion`, existing `generateAdSet` (Task 6 of the prior plan).
- Produces: `renderVariationGrid()`, `selectVariation(version, imagePath)`; `generateAdSet` sends `sizes` (checked placements).

- [ ] **Step 1: Add the variation grid + placement checklist to `index.html`**

In the RIGHT panel, just above the `#creatives-package-wrap` div, add:

```html
      <div id="adbuilder-variation-grid" style="display:none;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem"></div>
      <div id="adbuilder-placements" style="display:none;margin-top:0.5rem;font-size:0.78rem">
        <div style="color:var(--muted);font-weight:600;margin-bottom:0.3rem">PLACEMENTS</div>
        <label style="margin-right:0.6rem"><input type="checkbox" class="ab-size" value="instagram-feed-1080x1080" checked> IG Feed (1:1)</label>
        <label style="margin-right:0.6rem"><input type="checkbox" class="ab-size" value="instagram-feed-1080x1350" checked> IG Feed (4:5)</label>
        <label style="margin-right:0.6rem"><input type="checkbox" class="ab-size" value="instagram-stories-1080x1920" checked> IG Story</label>
        <label style="margin-right:0.6rem"><input type="checkbox" class="ab-size" value="facebook-feed-1200x628" checked> FB Feed (landscape)</label>
        <label style="margin-right:0.6rem"><input type="checkbox" class="ab-size" value="facebook-feed-1080x1080" checked> FB Feed (1:1)</label>
        <label style="margin-right:0.6rem"><input type="checkbox" class="ab-size" value="facebook-stories-1080x1920" checked> FB Story</label>
      </div>
```

- [ ] **Step 2: Add `renderVariationGrid` and `selectVariation` in `dashboard.js`**

```javascript
function renderVariationGrid() {
  var grid = document.getElementById('adbuilder-variation-grid');
  if (!grid) return;
  var vers = creativesState.adBuilder.variationVersions || [];
  grid.style.display = vers.length ? 'flex' : 'none';
  grid.innerHTML = vers.map(function(v) {
    var sel = creativesState.currentVersion === v.version;
    return '<img src="/api/creatives/image/' + v.imagePath + '" title="Variation ' + v.version + '" ' +
      'onclick="selectVariation(' + v.version + ',\'' + v.imagePath + '\')" ' +
      'style="width:120px;height:120px;object-fit:cover;border-radius:8px;cursor:pointer;border:3px solid ' + (sel ? 'var(--accent)' : 'transparent') + '">';
  }).join('');
}

function selectVariation(version, imagePath) {
  creativesState.currentVersion = version;
  showCreativeImage(imagePath, version);
  renderVariationGrid();
  // Reveal placement checklist + Generate Ad Set once a variation is chosen.
  var pl = document.getElementById('adbuilder-placements');
  var pkg = document.getElementById('creatives-package-wrap');
  if (pl) pl.style.display = 'block';
  if (pkg) pkg.style.display = 'block';
}
```

- [ ] **Step 3: Send checked sizes from `generateAdSet`**

In `generateAdSet` (from the prior branch), collect checked sizes and include them in the POST body. After reading `var ab = creativesState.adBuilder || {};`, add:

```javascript
  var sizes = Array.prototype.slice.call(document.querySelectorAll('.ab-size:checked')).map(function(c) { return c.value; });
  if (creativesState.mode === 'adbuilder' && sizes.length === 0) { showCreativesError('Check at least one placement.'); return; }
```

And add `sizes: sizes` to the JSON body of the package POST.

- [ ] **Step 4: Show the grid on mode switch; hide package/placements until a variation is picked**

In `syncModeUI`, when entering Ad Builder, call `renderVariationGrid()`; and keep `#adbuilder-placements` + `#creatives-package-wrap` hidden until `selectVariation` runs. Add to the `isAd` branch of `syncModeUI`:

```javascript
  if (isAd) { renderVariationGrid(); }
  var plc = document.getElementById('adbuilder-placements');
  if (plc && !isAd) plc.style.display = 'none';
```

(Studio mode continues to hide the grid — add `var g = document.getElementById('adbuilder-variation-grid'); if (g && !isAd) g.style.display = 'none';`.)

- [ ] **Step 5: Verify**

Run: `node --check agents/dashboard/public/js/dashboard.js`
Expected: no syntax error.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js
git commit -m "feat(ad-builder): variation grid, selection, placement checklist, wire output"
```

---

### Task 7: End-to-end verification + PR

**Files:** none

- [ ] **Step 1: Full unit suite**

Run: `node --test 'tests/**/*.test.js'`
Expected: PASS for `config/creative-models.test.js` and `agents/creative-packager.test.js` (note: the pre-existing, unrelated `tests/agents/priority-tuner.test.js` time-based failure is not part of this branch).

- [ ] **Step 2: Ad Builder e2e (one reference ad — project rule #4)**

Load the dashboard → Creatives → Ad Builder. Upload a reference ad, add a product, set 4 variations, Generate Variations. Confirm 4 variations appear in the grid. Select one → the placement checklist + Generate Ad Set appear. Uncheck two placements. Generate Ad Set. Confirm the ZIP contains: `master.webp`; `images/<size>.webp` only for the four checked sizes; `guides/<size>.png` matching those sizes (low-res, with copy + SAFE ZONE markings); `copy.txt`; `specs.txt`; `manifest.json` (destinationUrl matches).

- [ ] **Step 3: Legacy Ad Intelligence regression**

Trigger a legacy "Generate Creative" from the Ad Intelligence tab; confirm it still produces a ZIP (the `source:'ad'` branch, now also emitting `master.webp` from the first generated image + guides).

- [ ] **Step 4: No stale model IDs**

Run: `grep -rn "claude-opus-4-6\|claude-sonnet-4-6\|claude-haiku-4-5-20251001\|gemini-2.0-flash-preview-image-generation" agents/creative-packager agents/dashboard/routes/creatives.js config/creative-models.js`
Expected: no matches.

- [ ] **Step 5: Push + PR**

```bash
git push -u origin feature/ad-builder-variations
gh pr create --base main --title "Ad Builder: reference-driven variations + layout-guide ZIP" --body "Implements docs/superpowers/specs/2026-07-23-ad-builder-reference-variations-addendum.md. Plan: docs/superpowers/plans/2026-07-23-ad-builder-reference-variations.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review

**Spec coverage:**
- Upload reference ad → Task 5 (`uploadAdBuilderReference`). ✔
- Style extraction (Haiku vision, style-only) → Task 1 (model) + Task 4 (`analyze-reference`). ✔
- N variations featuring our product → Task 4 (`referenceImagePaths` on generate) + Task 5 (`generateVariations`). ✔
- Variation grid + select → Task 6. ✔
- Placement checklist (six sizes, default all) → Task 6 + Task 4 (`sizes` param) + Task 2/3 (`sizesByName`, packager). ✔
- Output ZIP: clean plates + `master.webp` + low-res `guides/*.png` + copy.txt/specs.txt/manifest.json → Task 2/3. ✔
- Studio unchanged; product+angle removed → Task 5 (removes `generateHero`). ✔
- Models from config (styleVision Haiku, Gemini, Opus copy) → Task 1, existing config. ✔

**Placeholder scan:** No TBD/TODO; every code step carries concrete code or exact commands. ✔

**Type consistency:** `creativesState.adBuilder` fields (`referenceAd`, `products`, `variationCount`, `destinationUrl`, `sizes`, `variationVersions`), `referenceImagePaths` (route + generate + version), `job.sizes` → `sizesByName`, `buildGuideSvg(size, copy)` used consistently across tasks. ✔

**Note:** Task 5 Step 3 depends on the existing `openProductImageModal` structure; the implementer must read that function and adapt the target-branch minimally. Flagged as the one integration point requiring code reading rather than pure transcription.
