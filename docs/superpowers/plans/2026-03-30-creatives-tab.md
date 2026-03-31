# Creatives Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Creatives tab to the dashboard for iterative text-to-image ad creative generation with product image references, templates, session persistence, and multi-placement packaging.

**Architecture:** Dashboard-native — the dashboard server calls the Gemini API directly for single-image generation and refinement (no agent subprocess). The existing `creative-packager` agent is invoked only for the final packaging step. All UI lives in the dashboard's HTML template literal in `agents/dashboard/index.js`. New API endpoints are prefixed with `/api/creatives/`.

**Tech Stack:** Node.js, Express (existing dashboard server), `@google/genai` (Gemini SDK, already installed), `@anthropic-ai/sdk` (Claude Vision for template-from-image + session naming, already installed), `sharp` (image processing, already installed), `archiver` (ZIP, already installed). New dependency: `multer` for multipart file uploads.

**Spec:** `docs/superpowers/specs/2026-03-30-creatives-tab-design.md`

**Critical rule:** All browser JavaScript inside the dashboard template literal must use `\\n` (double-backslash) instead of `\n` in string literals, and avoid `\s`, `\t`, `\r` in regex patterns. See CLAUDE.md "Template Literal Escape Sequences" section.

---

### Task 1: Install multer and create directories

**Files:**
- Modify: `package.json`
- Create: `data/creative-templates/` (directory)
- Create: `data/creative-templates/previews/` (directory)
- Create: `data/creative-sessions/` (directory)
- Create: `data/creatives/` (directory)
- Create: `data/reference-images/` (directory)

- [ ] **Step 1: Install multer**

```bash
npm install multer
```

- [ ] **Step 2: Create directories**

```bash
mkdir -p data/creative-templates/previews data/creative-sessions data/creatives data/reference-images
```

- [ ] **Step 3: Add .gitkeep files so empty directories are tracked**

```bash
touch data/creative-templates/.gitkeep data/creative-templates/previews/.gitkeep data/creative-sessions/.gitkeep data/creatives/.gitkeep data/reference-images/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json data/creative-templates/.gitkeep data/creative-templates/previews/.gitkeep data/creative-sessions/.gitkeep data/creatives/.gitkeep data/reference-images/.gitkeep
git commit -m "chore: install multer and create creatives directories"
```

---

### Task 2: Create starter templates

**Files:**
- Create: `data/creative-templates/lifestyle-scene.json`
- Create: `data/creative-templates/product-hero.json`
- Create: `data/creative-templates/flat-lay.json`
- Create: `data/creative-templates/seasonal-promo.json`
- Create: `data/creative-templates/before-and-after.json`
- Create: `data/creative-templates/ingredient-spotlight.json`
- Create: `data/creative-templates/minimalist.json`

- [ ] **Step 1: Create lifestyle-scene.json**

```json
{
  "id": "lifestyle-scene",
  "name": "Lifestyle Scene",
  "description": "Product in a natural, everyday setting with warm lighting and human interaction",
  "prompt": "A person using {{product}} in a bright, airy {{setting}}. Natural morning light streaming through a window. Clean, minimal aesthetic. Product prominently displayed on a surface nearby. Warm, inviting color palette with soft shadows.",
  "negativePrompt": "text, watermarks, logos, blurry, artificial lighting, cluttered background",
  "tags": ["lifestyle", "natural", "warm", "human"],
  "defaultAspectRatio": "4:5",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 2: Create product-hero.json**

```json
{
  "id": "product-hero",
  "name": "Product Hero",
  "description": "Single product on clean background with studio lighting for a premium feel",
  "prompt": "A single {{product}} centered on a pure white surface. Soft diffused studio lighting from directly above creates a gentle, natural shadow beneath the product. The composition is minimal and premium — nothing else in frame. The product occupies roughly 40% of the frame, leaving generous negative space. Colors are clean and neutral with slight warmth.",
  "negativePrompt": "text, watermarks, logos, multiple products, busy background, harsh shadows",
  "tags": ["product", "studio", "clean", "premium"],
  "defaultAspectRatio": "1:1",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 3: Create flat-lay.json**

```json
{
  "id": "flat-lay",
  "name": "Flat Lay",
  "description": "Top-down arrangement of product(s) with complementary props on a textured surface",
  "prompt": "A top-down flat lay photograph of {{product}} arranged on a {{surface}} surface. Complementary props scattered artfully around the product: fresh botanicals, a linen napkin, a small ceramic dish. Even, diffused overhead lighting with no harsh shadows. The arrangement feels curated but effortless. Muted, earthy color palette.",
  "negativePrompt": "text, watermarks, logos, angled perspective, harsh shadows, cluttered, neon colors",
  "tags": ["flat-lay", "overhead", "styled", "props"],
  "defaultAspectRatio": "1:1",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 4: Create seasonal-promo.json**

```json
{
  "id": "seasonal-promo",
  "name": "Seasonal Promo",
  "description": "Festive or seasonal themed creative with holiday-appropriate decorative elements",
  "prompt": "{{product}} arranged in a festive {{season}} scene. Warm, inviting colors appropriate for the season. Seasonal decorative elements placed tastefully around the product — not overwhelming. Soft, warm lighting that evokes comfort and celebration. The product remains the clear focal point.",
  "negativePrompt": "text, watermarks, logos, garish colors, too many decorations, cluttered",
  "tags": ["seasonal", "holiday", "festive", "promo"],
  "defaultAspectRatio": "4:5",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 5: Create before-and-after.json**

```json
{
  "id": "before-and-after",
  "name": "Before & After",
  "description": "Split composition showing transformation or comparison",
  "prompt": "A split-frame composition divided vertically. Left side: {{before_state}}, muted and dull tones. Right side: {{after_state}} with {{product}} visible, vibrant and fresh tones. The dividing line is clean and subtle. Both sides share the same background environment for continuity. The transformation is clear and compelling.",
  "negativePrompt": "text, watermarks, logos, blurry, inconsistent lighting between halves",
  "tags": ["before-after", "comparison", "transformation", "split"],
  "defaultAspectRatio": "16:9",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 6: Create ingredient-spotlight.json**

```json
{
  "id": "ingredient-spotlight",
  "name": "Ingredient Spotlight",
  "description": "Product surrounded by its natural or key ingredients with earthy tones",
  "prompt": "{{product}} placed at the center of the frame, surrounded by its key natural ingredients: {{ingredients}}. The ingredients are fresh and arranged organically on a {{surface}} surface. Earthy, natural color palette with warm, soft lighting. The composition suggests purity and natural origin. Slight depth of field keeping the product sharp.",
  "negativePrompt": "text, watermarks, logos, artificial ingredients, plastic, processed look, harsh lighting",
  "tags": ["ingredients", "natural", "organic", "earthy"],
  "defaultAspectRatio": "1:1",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 7: Create minimalist.json**

```json
{
  "id": "minimalist",
  "name": "Minimalist",
  "description": "Extreme simplicity with generous negative space, single product, muted palette",
  "prompt": "{{product}} positioned in the lower third of the frame against a smooth, monochrome {{color}} background. Extreme negative space — the product occupies no more than 20% of the frame. Soft, even lighting with almost no visible shadow. The overall feeling is calm, luxurious, and intentional. Muted color palette, no distractions.",
  "negativePrompt": "text, watermarks, logos, busy background, multiple objects, strong shadows, bright colors",
  "tags": ["minimal", "negative-space", "luxury", "calm"],
  "defaultAspectRatio": "9:16",
  "defaultModel": "gemini-2.0-flash-exp",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T00:00:00Z",
  "updatedAt": "2026-03-30T00:00:00Z"
}
```

- [ ] **Step 8: Commit**

```bash
git add data/creative-templates/*.json
git commit -m "feat: add 7 starter creative templates"
```

---

### Task 3: Add constants, imports, and Gemini/multer setup to dashboard

**Files:**
- Modify: `agents/dashboard/index.js` (top of file, lines 14–84)

- [ ] **Step 1: Add multer and path-related imports**

After the existing require statements (around line 20), add:

```javascript
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
```

- [ ] **Step 2: Add directory constants**

After the existing directory constants (around line 84), add:

```javascript
const CREATIVE_TEMPLATES_DIR = path.join(ROOT, 'data', 'creative-templates');
const CREATIVE_TEMPLATES_PREVIEWS_DIR = path.join(ROOT, 'data', 'creative-templates', 'previews');
const CREATIVE_SESSIONS_DIR = path.join(ROOT, 'data', 'creative-sessions');
const CREATIVES_DIR = path.join(ROOT, 'data', 'creatives');
const REFERENCE_IMAGES_DIR = path.join(ROOT, 'data', 'reference-images');
const PRODUCT_IMAGES_DIR = path.join(ROOT, 'data', 'product-images');
const PRODUCT_MANIFEST_PATH = path.join(PRODUCT_IMAGES_DIR, 'manifest.json');
```

- [ ] **Step 3: Add Gemini model config and multer setup**

After the directory constants, add:

```javascript
const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Exp)', maxReferenceImages: 10 },
  { id: 'gemini-2.0-flash-preview-image-generation', name: 'Gemini 2.0 Flash Preview', maxReferenceImages: 10 },
];

const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const upload = multer({ dest: path.join(ROOT, 'data', '.uploads-tmp'), limits: { fileSize: 20 * 1024 * 1024 } });
```

- [ ] **Step 4: Add directory-ensure helper**

After the multer setup, add:

```javascript
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
[CREATIVE_TEMPLATES_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR, REFERENCE_IMAGES_DIR].forEach(ensureDir);
```

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Gemini SDK, multer, and creatives constants to dashboard"
```

---

### Task 4: Disable Ad Intelligence and Optimize tabs, add Creatives tab pill

**Files:**
- Modify: `agents/dashboard/index.js` (lines 1041–1047 for tab pills, lines 1179–1220 for tab panels, lines 1242–1270 for switchTab, line 3003 for TAB_CHAT_NAMES, lines 1272–1283 for renderHeroKpis)

- [ ] **Step 1: Update tab pill buttons**

Find the tab pill buttons (around lines 1042–1046). Replace the Ad Intelligence and Optimize buttons with disabled versions and add the Creatives pill:

Replace:
```html
<button class="tab-pill" onclick="switchTab('ad-intelligence',this)" id="pill-ad-intelligence">Ad Intelligence</button>
<button class="tab-pill" onclick="switchTab('optimize',this)" id="pill-optimize">Optimize</button>
```

With:
```html
<button class="tab-pill" onclick="switchTab('creatives',this)" id="pill-creatives">Creatives</button>
<button class="tab-pill disabled" id="pill-ad-intelligence" title="Coming soon" style="opacity:0.4;cursor:not-allowed;pointer-events:none;">Ad Intelligence</button>
<button class="tab-pill disabled" id="pill-optimize" title="Coming soon" style="opacity:0.4;cursor:not-allowed;pointer-events:none;">Optimize</button>
```

- [ ] **Step 2: Add the Creatives tab panel HTML**

After the `tab-cro` panel div (around line 1178), add the Creatives tab panel. This is the shell — inner content will be built in later tasks:

```html
<div id="tab-creatives" class="tab-panel" style="display:none">
  <div id="creatives-content">
    <p class="muted" style="padding:2rem">Loading creatives studio...</p>
  </div>
</div>
```

- [ ] **Step 3: Update switchTab() to handle creatives tab**

In the `switchTab()` function (around line 1242), find the line that shows/hides tab action groups:

```javascript
['seo','cro','optimize','ads'].forEach(function(t) {
```

Replace with:

```javascript
['seo','cro','optimize','ads','creatives'].forEach(function(t) {
```

Also, add a render call for the creatives tab. After the line `if (name === 'ad-intelligence') renderAdIntelligenceTab();` (around line 1260), add:

```javascript
if (name === 'creatives') renderCreativesTab();
```

- [ ] **Step 4: Update TAB_CHAT_NAMES**

Find the `TAB_CHAT_NAMES` object (around line 3003). Add the creatives entry:

Replace:
```javascript
{ seo: 'SEO', cro: 'CRO', ads: 'Ads', 'ad-intelligence': 'Ad Intelligence', optimize: 'Optimize' }
```

With:
```javascript
{ seo: 'SEO', cro: 'CRO', ads: 'Ads', creatives: 'Creatives', 'ad-intelligence': 'Ad Intelligence', optimize: 'Optimize' }
```

- [ ] **Step 5: Add a placeholder renderCreativesTab() function**

Add this function near `renderAdIntelligenceTab()` (around line 2470):

```javascript
function renderCreativesTab() {
  var el = document.getElementById('creatives-content');
  if (!el) return;
  el.innerHTML = '<p class="muted" style="padding:2rem">Creatives studio loading...</p>';
}
```

- [ ] **Step 6: Verify locally**

```bash
node agents/dashboard/index.js &
# Open http://localhost:4242 in browser
# Verify: Creatives tab pill appears, clicking it shows placeholder
# Verify: Ad Intelligence and Optimize pills are grayed out and non-clickable
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Creatives tab pill, disable Ad Intelligence and Optimize tabs"
```

---

### Task 5: Template CRUD API endpoints

**Files:**
- Modify: `agents/dashboard/index.js` (add routes near the existing API routes, around line 4734+)

- [ ] **Step 1: Add GET /api/creatives/templates**

Add before the existing `/api/meta-ads-insights` route:

```javascript
// --- Creatives API ---

app.get('/api/creatives/templates', (req, res) => {
  try {
    const files = fs.readdirSync(CREATIVE_TEMPLATES_DIR).filter(f => f.endsWith('.json'));
    const templates = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CREATIVE_TEMPLATES_DIR, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add POST /api/creatives/templates**

```javascript
app.post('/api/creatives/templates', express.json(), (req, res) => {
  try {
    const t = req.body;
    if (!t.id || !t.name || !t.prompt) return res.status(400).json({ error: 'id, name, and prompt required' });
    t.createdAt = t.createdAt || new Date().toISOString();
    t.updatedAt = new Date().toISOString();
    t.source = t.source || 'manual';
    fs.writeFileSync(path.join(CREATIVE_TEMPLATES_DIR, t.id + '.json'), JSON.stringify(t, null, 2));
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add PUT /api/creatives/templates/:id**

```javascript
app.put('/api/creatives/templates/:id', express.json(), (req, res) => {
  try {
    const filePath = path.join(CREATIVE_TEMPLATES_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Template not found' });
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const updated = Object.assign(existing, req.body, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Add DELETE /api/creatives/templates/:id**

```javascript
app.delete('/api/creatives/templates/:id', (req, res) => {
  try {
    const filePath = path.join(CREATIVE_TEMPLATES_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Template not found' });
    const t = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (t.previewImage) {
      const prevPath = path.join(CREATIVE_TEMPLATES_PREVIEWS_DIR, path.basename(t.previewImage));
      if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Verify templates API**

```bash
node agents/dashboard/index.js &
curl -s http://localhost:4242/api/creatives/templates | head -c 200
# Expected: JSON array with 7 starter templates
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add template CRUD API endpoints"
```

---

### Task 6: Template "Create from Image" endpoint

**Files:**
- Modify: `agents/dashboard/index.js` (add route after template CRUD routes)

- [ ] **Step 1: Add POST /api/creatives/templates/from-image**

This endpoint must be registered BEFORE any `/api/creatives/templates/:id` routes to avoid the path parameter matching `from-image`. If the parameterized routes were added first in Task 5, move this route above them.

```javascript
app.post('/api/creatives/templates/from-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const anthropic = new Anthropic();
    const imgBuf = fs.readFileSync(req.file.path);
    const b64 = imgBuf.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } },
          { type: 'text', text: 'Analyze this image for use as a creative template. Return a JSON object (no markdown fencing) with these fields:\n- "name": short descriptive name (3-5 words) based on the dominant style\n- "description": one-line summary of the visual style\n- "prompt": a detailed text-to-image prompt that would reproduce this style. Use {{product}} as a placeholder where the main product would go. Include details about composition, lighting, color palette, mood, subject positioning, background.\n- "negativePrompt": things to avoid based on what is NOT in this image\n- "tags": array of 3-6 style/technique keyword strings\n- "defaultAspectRatio": estimate the aspect ratio as one of "1:1", "4:5", "9:16", "16:9"\n\nReturn ONLY the JSON object, no other text.' }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    let template;
    try { template = JSON.parse(text); }
    catch { template = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '')); }

    // Save preview image
    const ext = path.extname(req.file.originalname) || '.jpg';
    const previewName = (template.name || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now() + ext;
    const previewPath = path.join(CREATIVE_TEMPLATES_PREVIEWS_DIR, previewName);
    fs.copyFileSync(req.file.path, previewPath);
    fs.unlinkSync(req.file.path);

    template.previewImage = previewName;
    template.source = 'ai';
    template.id = (template.name || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    template.defaultModel = template.defaultModel || 'gemini-2.0-flash-exp';
    template.createdAt = new Date().toISOString();
    template.updatedAt = new Date().toISOString();

    res.json({ template, previewPath: previewName });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Verify route ordering**

Ensure the routes are in this order in the source file:
1. `GET /api/creatives/templates`
2. `POST /api/creatives/templates/from-image` (before parameterized routes)
3. `POST /api/creatives/templates`
4. `PUT /api/creatives/templates/:id`
5. `DELETE /api/creatives/templates/:id`

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Create Template from Image endpoint using Claude Vision"
```

---

### Task 7: Models, product images, and reference images API endpoints

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add GET /api/creatives/models**

```javascript
app.get('/api/creatives/models', (req, res) => {
  res.json(GEMINI_MODELS);
});
```

- [ ] **Step 2: Add GET /api/creatives/product-images**

```javascript
app.get('/api/creatives/product-images', (req, res) => {
  try {
    if (!fs.existsSync(PRODUCT_MANIFEST_PATH)) return res.json([]);
    const manifest = JSON.parse(fs.readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));
    // Add available image files for each product
    const result = manifest.map(p => {
      const imgDir = path.join(PRODUCT_IMAGES_DIR, p.imageDir || p.handle);
      let images = [];
      if (fs.existsSync(imgDir)) {
        images = fs.readdirSync(imgDir).filter(f => /\.(webp|jpg|jpeg|png)$/i.test(f));
      }
      return Object.assign({}, p, { images });
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add GET and POST /api/creatives/reference-images**

```javascript
app.get('/api/creatives/reference-images', (req, res) => {
  try {
    const files = fs.readdirSync(REFERENCE_IMAGES_DIR).filter(f => /\.(webp|jpg|jpeg|png)$/i.test(f));
    res.json(files.map(f => ({ filename: f, path: f })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/creatives/reference-images', upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = 'ref-' + Date.now() + ext;
    const dest = path.join(REFERENCE_IMAGES_DIR, filename);
    fs.renameSync(req.file.path, dest);
    res.json({ filename, path: filename });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Add static image serving routes**

```javascript
// Serve product images
app.get('/api/creatives/product-image/*', (req, res) => {
  const relPath = req.params[0];
  const filePath = path.join(PRODUCT_IMAGES_DIR, relPath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Serve reference images
app.get('/api/creatives/reference-image/:filename', (req, res) => {
  const filePath = path.join(REFERENCE_IMAGES_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Serve generated creatives
app.get('/api/creatives/image/*', (req, res) => {
  const relPath = req.params[0];
  const filePath = path.join(CREATIVES_DIR, relPath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const download = req.query.download === '1';
  if (download) res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(filePath) + '"');
  res.sendFile(filePath);
});

// Serve template preview images
app.get('/api/creatives/template-preview/:filename', (req, res) => {
  const filePath = path.join(CREATIVE_TEMPLATES_PREVIEWS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});
```

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add models, product images, reference images, and image serving endpoints"
```

---

### Task 8: Session CRUD API endpoints

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add GET /api/creatives/sessions (list)**

```javascript
app.get('/api/creatives/sessions', (req, res) => {
  try {
    const files = fs.readdirSync(CREATIVE_SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(CREATIVE_SESSIONS_DIR, f), 'utf8'));
        return { id: s.id, name: s.name, updatedAt: s.updatedAt, versionCount: (s.versions || []).length };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add GET /api/creatives/sessions/:id**

```javascript
app.get('/api/creatives/sessions/:id', (req, res) => {
  try {
    const filePath = path.join(CREATIVE_SESSIONS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add PUT /api/creatives/sessions/:id**

```javascript
app.put('/api/creatives/sessions/:id', express.json(), (req, res) => {
  try {
    const filePath = path.join(CREATIVE_SESSIONS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const updated = Object.assign(existing, req.body, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Add session helper — saveSession()**

Add this as a server-side helper function (not inside the template literal):

```javascript
function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  const filePath = path.join(CREATIVE_SESSIONS_DIR, session.id + '.json');
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  return session;
}

function createSession() {
  const id = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const session = {
    id,
    name: 'New Session',
    nameAutoGenerated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: GEMINI_MODELS[0].id,
    templateId: null,
    prompt: '',
    negativePrompt: '',
    aspectRatio: '1:1',
    referenceImages: [],
    versions: []
  };
  ensureDir(path.join(CREATIVES_DIR, id));
  return saveSession(session);
}
```

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add session CRUD API endpoints and helpers"
```

---

### Task 9: Image generation endpoint

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add POST /api/creatives/generate**

```javascript
app.post('/api/creatives/generate', upload.array('referenceImages', 20), async (req, res) => {
  try {
    if (!geminiClient) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const { prompt, negativePrompt, model, aspectRatio, sessionId } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const modelId = model || GEMINI_MODELS[0].id;

    // Load or create session
    let session;
    if (sessionId) {
      const sp = path.join(CREATIVE_SESSIONS_DIR, sessionId + '.json');
      if (fs.existsSync(sp)) session = JSON.parse(fs.readFileSync(sp, 'utf8'));
    }
    if (!session) session = createSession();

    // Build Gemini request parts
    const parts = [];

    // Add reference images from session (product images stored on disk)
    if (req.body.productImagePaths) {
      const productPaths = JSON.parse(req.body.productImagePaths);
      for (const p of productPaths) {
        const fullPath = path.join(PRODUCT_IMAGES_DIR, p);
        if (fs.existsSync(fullPath)) {
          const imgBuf = fs.readFileSync(fullPath);
          const mime = p.endsWith('.webp') ? 'image/webp' : p.endsWith('.png') ? 'image/png' : 'image/jpeg';
          parts.push({ inlineData: { mimeType: mime, data: imgBuf.toString('base64') } });
        }
      }
    }

    // Add uploaded reference images
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const imgBuf = fs.readFileSync(file.path);
        parts.push({ inlineData: { mimeType: file.mimetype || 'image/jpeg', data: imgBuf.toString('base64') } });
        fs.unlinkSync(file.path);
      }
    }

    // Build the full prompt with negative prompt
    let fullPrompt = prompt;
    if (negativePrompt) fullPrompt += '\\n\\nDo NOT include: ' + negativePrompt;

    parts.push({ text: fullPrompt });

    // Map aspect ratio to Gemini config
    const arMap = { '1:1': { width: 1080, height: 1080 }, '4:5': { width: 1080, height: 1350 }, '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1920, height: 1080 } };
    let dimensions = arMap[aspectRatio] || arMap['1:1'];
    if (aspectRatio === 'custom' && req.body.customWidth && req.body.customHeight) {
      dimensions = { width: parseInt(req.body.customWidth), height: parseInt(req.body.customHeight) };
    }

    const result = await geminiClient.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['TEXT', 'IMAGE'] }
    });

    // Extract image from response
    const candidate = result.candidates && result.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      // Check for safety/policy rejection
      const reason = candidate && candidate.finishReason;
      if (reason === 'SAFETY' || reason === 'BLOCKED') {
        return res.status(422).json({ error: 'Image generation was blocked by content policy. Try adjusting your prompt to avoid potentially flagged content.', reason });
      }
      return res.status(500).json({ error: 'No image returned from Gemini' });
    }

    const imgPart = candidate.content.parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('image/'));
    if (!imgPart) return res.status(500).json({ error: 'No image in Gemini response' });

    // Save image to disk — full resolution, original format from Gemini
    const version = (session.versions || []).length + 1;
    const sessionDir = path.join(CREATIVES_DIR, session.id);
    ensureDir(sessionDir);
    const mimeToExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = mimeToExt[imgPart.inlineData.mimeType] || '.png';
    const imgFilename = 'v' + version + ext;
    const imgPath = path.join(sessionDir, imgFilename);

    const imgBuffer = Buffer.from(imgPart.inlineData.data, 'base64');
    fs.writeFileSync(imgPath, imgBuffer);

    // Update session
    session.prompt = prompt;
    session.negativePrompt = negativePrompt || '';
    session.model = modelId;
    session.aspectRatio = aspectRatio || '1:1';
    if (!session.versions) session.versions = [];
    session.versions.push({
      version,
      imagePath: session.id + '/' + imgFilename,
      prompt,
      negativePrompt: negativePrompt || '',
      refinement: null,
      favorited: false,
      timestamp: new Date().toISOString()
    });

    // Auto-generate session name from first prompt
    if (session.nameAutoGenerated && version === 1) {
      try {
        const anthropic = new Anthropic();
        const nameResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 30,
          messages: [{ role: 'user', content: 'Generate a short 3-5 word name summarizing this image generation prompt. Return ONLY the name, no quotes or punctuation:\\n\\n' + prompt }]
        });
        session.name = nameResp.content[0].text.trim();
      } catch { /* keep default name */ }
    }

    saveSession(session);

    res.json({ imagePath: session.id + '/' + imgFilename, version, sessionId: session.id, sessionName: session.name });
  } catch (err) {
    // Clean up uploaded files on error
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Verify the generate endpoint starts up without errors**

```bash
node agents/dashboard/index.js &
curl -s http://localhost:4242/api/creatives/models
# Expected: JSON array of models
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add image generation endpoint with Gemini integration"
```

---

### Task 10: Image refinement endpoint

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add POST /api/creatives/refine**

```javascript
app.post('/api/creatives/refine', express.json(), async (req, res) => {
  try {
    if (!geminiClient) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const { sessionId, version, refinement, model } = req.body;
    if (!sessionId || !version || !refinement) return res.status(400).json({ error: 'sessionId, version, and refinement are required' });

    const sessionPath = path.join(CREATIVE_SESSIONS_DIR, sessionId + '.json');
    if (!fs.existsSync(sessionPath)) return res.status(404).json({ error: 'Session not found' });
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

    const prevVersion = session.versions.find(v => v.version === parseInt(version));
    if (!prevVersion) return res.status(404).json({ error: 'Version not found' });

    // Load the previous image
    const prevImgPath = path.join(CREATIVES_DIR, prevVersion.imagePath);
    if (!fs.existsSync(prevImgPath)) return res.status(404).json({ error: 'Previous image not found on disk' });

    const prevImgBuf = fs.readFileSync(prevImgPath);
    const modelId = model || session.model || GEMINI_MODELS[0].id;

    const prevExt = path.extname(prevImgPath).toLowerCase();
    const extToMime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    const prevMime = extToMime[prevExt] || 'image/png';
    const parts = [
      { inlineData: { mimeType: prevMime, data: prevImgBuf.toString('base64') } },
      { text: 'This is the current image. Please modify it with the following changes: ' + refinement + (session.negativePrompt ? '\\n\\nDo NOT include: ' + session.negativePrompt : '') }
    ];

    const result = await geminiClient.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['TEXT', 'IMAGE'] }
    });

    const candidate = result.candidates && result.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      const reason = candidate && candidate.finishReason;
      if (reason === 'SAFETY' || reason === 'BLOCKED') {
        return res.status(422).json({ error: 'Refinement was blocked by content policy. Try adjusting your refinement text.', reason });
      }
      return res.status(500).json({ error: 'No image returned from Gemini' });
    }

    const imgPart = candidate.content.parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('image/'));
    if (!imgPart) return res.status(500).json({ error: 'No image in Gemini response' });

    const newVersion = session.versions.length + 1;
    const mimeToExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = mimeToExt[imgPart.inlineData.mimeType] || '.png';
    const imgFilename = 'v' + newVersion + ext;
    const imgPath = path.join(CREATIVES_DIR, session.id, imgFilename);
    fs.writeFileSync(imgPath, Buffer.from(imgPart.inlineData.data, 'base64'));

    session.versions.push({
      version: newVersion,
      imagePath: session.id + '/' + imgFilename,
      prompt: prevVersion.prompt,
      negativePrompt: prevVersion.negativePrompt,
      refinement,
      favorited: false,
      timestamp: new Date().toISOString()
    });
    saveSession(session);

    res.json({ imagePath: session.id + '/' + imgFilename, version: newVersion });
  } catch (err) {
    console.error('Refine error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add image refinement endpoint"
```

---

### Task 11: Packaging endpoint

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add POST /api/creatives/package**

This spawns the creative-packager agent in a modified mode — passing the source image and prompt directly instead of an adId:

```javascript
app.post('/api/creatives/package', express.json(), async (req, res) => {
  try {
    const { sessionId, version } = req.body;
    if (!sessionId || !version) return res.status(400).json({ error: 'sessionId and version required' });

    const sessionPath = path.join(CREATIVE_SESSIONS_DIR, sessionId + '.json');
    if (!fs.existsSync(sessionPath)) return res.status(404).json({ error: 'Session not found' });
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const ver = session.versions.find(v => v.version === parseInt(version));
    if (!ver) return res.status(404).json({ error: 'Version not found' });

    const sourceImage = path.join(CREATIVES_DIR, ver.imagePath);
    if (!fs.existsSync(sourceImage)) return res.status(404).json({ error: 'Source image not found' });

    const jobId = 'pkg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const jobFile = path.join(ROOT, 'data', 'creative-jobs', jobId + '.json');
    ensureDir(path.join(ROOT, 'data', 'creative-jobs'));

    const job = {
      status: 'pending',
      type: 'package',
      sourceImage,
      sessionId,
      version: parseInt(version),
      prompt: ver.prompt,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));

    // Spawn creative-packager with --job-id
    const cp = require('child_process');
    const child = cp.spawn('node', [path.join(ROOT, 'agents', 'creative-packager', 'index.js'), '--job-id', jobId], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { CREATIVE_JOB_TYPE: 'package' })
    });
    child.unref();

    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add GET /api/creatives/package/:jobId (polling)**

```javascript
app.get('/api/creatives/package/download/:jobId', (req, res) => {
  const jobFile = path.join(ROOT, 'data', 'creative-jobs', req.params.jobId + '.json');
  if (!fs.existsSync(jobFile)) return res.status(404).json({ error: 'Job not found' });
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  if (job.status !== 'complete' || !job.zipPath) return res.status(400).json({ error: 'Package not ready' });
  if (!fs.existsSync(job.zipPath)) return res.status(404).json({ error: 'ZIP file not found' });
  res.download(job.zipPath);
});

app.get('/api/creatives/package/:jobId', (req, res) => {
  const jobFile = path.join(ROOT, 'data', 'creative-jobs', req.params.jobId + '.json');
  if (!fs.existsSync(jobFile)) return res.status(404).json({ error: 'Job not found' });
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const result = { status: job.status };
  if (job.status === 'complete') result.downloadUrl = '/api/creatives/package/download/' + req.params.jobId;
  if (job.status === 'error') result.error = job.error;
  res.json(result);
});
```

Note: The download route MUST be registered before the parameterized `:jobId` route.

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add packaging endpoints for multi-placement creative output"
```

---

### Task 12: Creatives tab — left panel UI (prompt, negative prompt, aspect ratio, references)

**Files:**
- Modify: `agents/dashboard/index.js` (replace the placeholder tab panel from Task 4)

- [ ] **Step 1: Replace the creatives tab panel placeholder with the full left panel HTML**

Find the placeholder `<div id="tab-creatives"` and replace it with the full tab structure. All browser JS strings must use `\\n` (double backslash). All regex must avoid `\s`, `\t`, `\n`.

```html
<div id="tab-creatives" class="tab-panel" style="display:none">
  <!-- Top bar -->
  <div id="creatives-top-bar" style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;">
    <div style="display:flex;gap:6px;align-items:center;">
      <span style="font-size:12px;color:var(--muted);">Model:</span>
      <select id="creatives-model-select" onchange="onCreativesModelChange()" style="background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px;"></select>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <span style="font-size:12px;color:var(--muted);">Template:</span>
      <select id="creatives-template-select" onchange="onCreativesTemplateChange()" style="background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px;">
        <option value="">Blank</option>
      </select>
      <button onclick="openManageTemplates()" style="background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;">Manage</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-left:auto;">
      <span style="font-size:12px;color:var(--muted);">Session:</span>
      <select id="creatives-session-select" onchange="onCreativesSessionChange()" style="background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px;max-width:220px;">
        <option value="new">New Session</option>
      </select>
      <span id="creatives-session-name" onclick="editSessionName()" style="cursor:pointer;font-size:12px;color:var(--accent);text-decoration:underline;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Click to rename"></span>
      <span id="creatives-autosave-indicator" style="font-size:10px;color:#00b894;">saved</span>
    </div>
  </div>

  <!-- Main layout -->
  <div style="display:grid;grid-template-columns:1fr 1fr;min-height:520px;">

    <!-- LEFT panel -->
    <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;max-height:calc(100vh - 200px);">

      <!-- Product context (multi-product, collapsible) -->
      <div id="creatives-product-context" style="display:none;padding:10px 16px 0;">
        <div onclick="toggleProductContext()" style="cursor:pointer;display:flex;align-items:center;gap:6px;">
          <span id="creatives-product-context-arrow" style="font-size:10px;">&#9660;</span>
          <label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;cursor:pointer;">Product Context</label>
        </div>
        <div id="creatives-product-context-body" style="margin-top:6px;"></div>
      </div>

      <!-- Prompt -->
      <div style="padding:14px 16px 8px;">
        <label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Prompt</label>
        <textarea id="creatives-prompt" rows="5" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-top:4px;padding:10px;color:var(--fg);font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;" placeholder="Describe the image you want to generate..."></textarea>
      </div>

      <!-- Negative prompt -->
      <div style="padding:0 16px 8px;">
        <label style="font-size:11px;color:#e17055;text-transform:uppercase;letter-spacing:0.5px;">Negative Prompt</label>
        <textarea id="creatives-negative-prompt" rows="2" style="width:100%;background:#1a1010;border:1px solid #442222;border-radius:8px;margin-top:4px;padding:8px;color:#e17055;font-size:12px;resize:vertical;box-sizing:border-box;font-family:inherit;" placeholder="text, watermarks, logos, blurry, low quality..."></textarea>
      </div>

      <!-- Aspect ratio -->
      <div style="padding:0 16px 10px;">
        <label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Aspect Ratio</label>
        <div id="creatives-aspect-buttons" style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
          <button class="ar-btn active" onclick="setAspectRatio(&apos;1:1&apos;,this)" data-ar="1:1" style="padding:6px 12px;border-radius:6px;font-size:11px;cursor:pointer;">1:1</button>
          <button class="ar-btn" onclick="setAspectRatio(&apos;4:5&apos;,this)" data-ar="4:5" style="padding:6px 12px;border-radius:6px;font-size:11px;cursor:pointer;">4:5</button>
          <button class="ar-btn" onclick="setAspectRatio(&apos;9:16&apos;,this)" data-ar="9:16" style="padding:6px 12px;border-radius:6px;font-size:11px;cursor:pointer;">9:16</button>
          <button class="ar-btn" onclick="setAspectRatio(&apos;16:9&apos;,this)" data-ar="16:9" style="padding:6px 12px;border-radius:6px;font-size:11px;cursor:pointer;">16:9</button>
          <button class="ar-btn" onclick="setAspectRatio(&apos;custom&apos;,this)" data-ar="custom" style="padding:6px 12px;border-radius:6px;font-size:11px;cursor:pointer;">Custom</button>
        </div>
        <div id="creatives-custom-ar" style="display:none;margin-top:6px;display:flex;gap:4px;align-items:center;">
          <input id="creatives-custom-w" type="number" value="1200" style="width:70px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:4px;color:var(--fg);font-size:12px;" />
          <span style="color:var(--muted);">x</span>
          <input id="creatives-custom-h" type="number" value="800" style="width:70px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:4px;color:var(--fg);font-size:12px;" />
          <span style="font-size:10px;color:var(--muted);">px</span>
        </div>
      </div>

      <!-- Reference images -->
      <div style="padding:0 16px 10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Reference Images</label>
          <span id="creatives-ref-count" style="font-size:10px;color:var(--muted);">0 / 10 max</span>
        </div>
        <div id="creatives-ref-images" style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;"></div>
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button id="creatives-add-product-btn" onclick="openProductImagePicker()" style="padding:6px 12px;background:transparent;border:1px dashed #6c5ce7;border-radius:6px;color:#6c5ce7;font-size:11px;cursor:pointer;">+ Product</button>
          <button id="creatives-add-upload-btn" onclick="openReferenceUpload()" style="padding:6px 12px;background:transparent;border:1px dashed #00b894;border-radius:6px;color:#00b894;font-size:11px;cursor:pointer;">+ Upload</button>
        </div>
        <input id="creatives-upload-input" type="file" accept="image/*" multiple style="display:none;" onchange="handleReferenceUpload(this)" />
        <!-- Drop zone overlay -->
        <div id="creatives-drop-zone" style="display:none;position:absolute;inset:0;background:rgba(0,184,148,0.1);border:2px dashed #00b894;border-radius:8px;z-index:10;display:flex;align-items:center;justify-content:center;">
          <span style="color:#00b894;font-size:14px;">Drop images here</span>
        </div>
      </div>

      <!-- Generate button -->
      <div style="padding:0 16px 14px;margin-top:auto;">
        <button id="creatives-generate-btn" onclick="generateCreativeImage()" style="width:100%;padding:11px;background:linear-gradient(135deg,#6c5ce7,#a855f7);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
          Generate Image
        </button>
      </div>
    </div>

    <!-- RIGHT panel (placeholder — built in Task 13) -->
    <div id="creatives-right-panel" style="display:flex;flex-direction:column;">
      <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:14px;">
        <div style="text-align:center;color:var(--muted);">
          <div style="font-size:48px;opacity:0.3;">&#128444;</div>
          <p style="font-size:13px;">Generated image will appear here</p>
        </div>
      </div>
    </div>

  </div>
</div>
```

- [ ] **Step 2: Add CSS for aspect ratio buttons and reference image thumbnails**

Find the CSS section in the template literal (around line 699) and add:

```css
.ar-btn { background:var(--card);color:var(--muted);border:1px solid var(--border);transition:all 0.15s; }
.ar-btn.active { background:#6c5ce7;color:white;border-color:#6c5ce7;font-weight:600; }
.ref-thumb { width:64px;height:64px;border-radius:6px;object-fit:cover;position:relative;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0; }
.ref-thumb.product { border:2px solid #6c5ce7;background:rgba(108,92,231,0.1); }
.ref-thumb.uploaded { border:2px solid #00b894;background:rgba(0,184,148,0.1); }
.ref-thumb .ref-remove { position:absolute;top:-4px;right:-4px;background:#e17055;color:white;border-radius:50%;width:16px;height:16px;font-size:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;line-height:1; }
```

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Creatives tab left panel HTML — prompt, negative prompt, aspect ratio, references"
```

---

### Task 13: Creatives tab — right panel UI (image display, refinement, filmstrip, package)

**Files:**
- Modify: `agents/dashboard/index.js` (replace the right panel placeholder from Task 12)

- [ ] **Step 1: Replace the right panel placeholder**

Find `<div id="creatives-right-panel"` and replace everything inside it:

```html
<div id="creatives-right-panel" style="display:flex;flex-direction:column;">

  <!-- Image display area -->
  <div id="creatives-image-area" style="flex:1;display:flex;align-items:center;justify-content:center;padding:14px;position:relative;min-height:300px;">
    <!-- Loading spinner (hidden by default) -->
    <div id="creatives-spinner" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.5);z-index:5;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;border-radius:8px;">
      <div style="width:32px;height:32px;border:3px solid var(--border);border-top-color:#6c5ce7;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
      <span id="creatives-spinner-text" style="color:var(--fg);font-size:12px;">Generating...</span>
    </div>
    <!-- Error message -->
    <div id="creatives-error" style="display:none;position:absolute;bottom:14px;left:14px;right:14px;background:rgba(225,112,85,0.15);border:1px solid #e17055;border-radius:8px;padding:10px;z-index:4;">
      <p id="creatives-error-text" style="color:#e17055;font-size:12px;margin:0;"></p>
      <button onclick="document.getElementById(&apos;creatives-error&apos;).style.display=&apos;none&apos;" style="margin-top:6px;padding:4px 10px;background:#e17055;color:white;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Dismiss</button>
    </div>
    <!-- Placeholder -->
    <div id="creatives-placeholder" style="text-align:center;color:var(--muted);">
      <div style="font-size:48px;opacity:0.3;">&#128444;</div>
      <p style="font-size:13px;">Generated image will appear here</p>
    </div>
    <!-- Generated image -->
    <img id="creatives-current-image" style="display:none;max-width:100%;max-height:100%;border-radius:8px;border:1px solid var(--border);" />
    <!-- Compare mode container -->
    <div id="creatives-compare" style="display:none;width:100%;height:100%;"></div>
    <!-- Action buttons (top right) -->
    <div style="position:absolute;top:14px;right:14px;display:flex;gap:4px;">
      <button id="creatives-download-btn" onclick="downloadCreativeImage()" style="display:none;padding:4px 8px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:4px;font-size:10px;cursor:pointer;" title="Download image">&#8615; Download</button>
      <button id="creatives-compare-btn" onclick="toggleCompareMode()" style="display:none;padding:4px 8px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:4px;font-size:10px;cursor:pointer;" title="Compare two versions">&#8652; Compare</button>
    </div>
  </div>

  <!-- Refinement bar -->
  <div style="padding:10px 16px;border-top:1px solid var(--border);">
    <div style="display:flex;gap:6px;align-items:center;">
      <input id="creatives-refine-input" style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--fg);font-size:12px;" placeholder="Refine: &apos;make the background warmer&apos;, &apos;zoom in on product&apos;..." onkeydown="if(event.key===&apos;Enter&apos;)refineCreativeImage()" />
      <button onclick="refineCreativeImage()" style="padding:8px 14px;background:#6c5ce7;color:white;border:none;border-radius:8px;font-size:12px;cursor:pointer;">Refine</button>
    </div>
  </div>

  <!-- History filmstrip -->
  <div style="padding:6px 16px 10px;border-top:1px solid var(--border);">
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">History</label>
      <span style="font-size:10px;color:var(--muted);">Click &#9733; to pin favorites</span>
    </div>
    <div id="creatives-filmstrip" style="display:flex;gap:5px;margin-top:5px;overflow-x:auto;padding-bottom:4px;"></div>
  </div>

  <!-- Package button -->
  <div style="padding:0 16px 10px;">
    <button id="creatives-package-btn" onclick="packageCreative()" style="width:100%;padding:9px;background:#00b894;color:white;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;display:none;">
      &#128230; Package for All Placements
    </button>
  </div>
</div>
```

- [ ] **Step 2: Add the CSS spin animation**

In the CSS section, add:

```css
@keyframes spin { to { transform:rotate(360deg); } }
```

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Creatives tab right panel — image display, refinement, filmstrip, packaging"
```

---

### Task 14: Creatives tab — browser JavaScript (core state and rendering)

**Files:**
- Modify: `agents/dashboard/index.js` (add inside `<script>` block)

- [ ] **Step 1: Add creatives state variables and initialization**

Add this JavaScript inside the `<script>` block, near other tab-specific JS (before the closing `</script>` tag). **Remember: all `\n` in string literals must be `\\n` (double backslash). No `\s` in regex.**

```javascript
// --- Creatives Tab State ---
var creativesState = {
  sessionId: null,
  currentVersion: null,
  aspectRatio: '1:1',
  referenceImages: [],  // [{type:'product'|'uploaded', path, handle?, file?}]
  models: [],
  templates: [],
  sessions: [],
  compareMode: false,
  compareVersions: []
};

async function renderCreativesTab() {
  try {
    var [modelsResp, templatesResp, sessionsResp] = await Promise.all([
      fetch('/api/creatives/models').then(function(r){return r.json();}),
      fetch('/api/creatives/templates').then(function(r){return r.json();}),
      fetch('/api/creatives/sessions').then(function(r){return r.json();})
    ]);
    creativesState.models = modelsResp;
    creativesState.templates = templatesResp;
    creativesState.sessions = sessionsResp;
    renderCreativesModels();
    renderCreativesTemplates();
    renderCreativesSessions();
    // Load most recent session if available
    if (sessionsResp.length > 0) {
      loadCreativesSession(sessionsResp[0].id);
    }
  } catch (err) {
    console.error('Failed to load creatives tab:', err);
  }
}

function renderCreativesModels() {
  var sel = document.getElementById('creatives-model-select');
  if (!sel) return;
  sel.innerHTML = creativesState.models.map(function(m) {
    return '<option value="' + m.id + '">' + m.name + '</option>';
  }).join('');
}

function renderCreativesTemplates() {
  var sel = document.getElementById('creatives-template-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Blank</option>' + creativesState.templates.map(function(t) {
    return '<option value="' + t.id + '">' + t.name + '</option>';
  }).join('');
}

function renderCreativesSessions() {
  var sel = document.getElementById('creatives-session-select');
  if (!sel) return;
  sel.innerHTML = '<option value="new">+ New Session</option>' + creativesState.sessions.map(function(s) {
    var d = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '';
    return '<option value="' + s.id + '">' + d + ' \\u2014 ' + s.name + ' (' + s.versionCount + ' versions)</option>';
  }).join('');
}
```

- [ ] **Step 2: Add session loading and switching**

```javascript
async function loadCreativesSession(sessionId) {
  try {
    var resp = await fetch('/api/creatives/sessions/' + sessionId);
    if (!resp.ok) return;
    var session = await resp.json();
    creativesState.sessionId = session.id;
    creativesState.currentVersion = session.versions.length > 0 ? session.versions[session.versions.length - 1].version : null;
    creativesState.referenceImages = session.referenceImages || [];
    creativesState.aspectRatio = session.aspectRatio || '1:1';

    // Populate form fields
    document.getElementById('creatives-prompt').value = session.prompt || '';
    document.getElementById('creatives-negative-prompt').value = session.negativePrompt || '';
    var modelSel = document.getElementById('creatives-model-select');
    if (modelSel) modelSel.value = session.model || creativesState.models[0].id;

    // Set aspect ratio button
    setAspectRatio(session.aspectRatio || '1:1', document.querySelector('.ar-btn[data-ar="' + (session.aspectRatio || '1:1') + '"]'));

    // Session name
    var nameEl = document.getElementById('creatives-session-name');
    if (nameEl) nameEl.textContent = session.name || '';

    // Render reference images
    renderCreativesRefImages();

    // Render filmstrip
    renderCreativesFilmstrip(session.versions || []);

    // Show current image
    if (session.versions && session.versions.length > 0) {
      var latest = session.versions[session.versions.length - 1];
      showCreativeImage(latest.imagePath, latest.version);
    } else {
      hideCreativeImage();
    }
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}

function onCreativesSessionChange() {
  var sel = document.getElementById('creatives-session-select');
  if (sel.value === 'new') {
    creativesState.sessionId = null;
    creativesState.currentVersion = null;
    creativesState.referenceImages = [];
    document.getElementById('creatives-prompt').value = '';
    document.getElementById('creatives-negative-prompt').value = '';
    document.getElementById('creatives-session-name').textContent = 'New Session';
    renderCreativesRefImages();
    renderCreativesFilmstrip([]);
    hideCreativeImage();
  } else {
    loadCreativesSession(sel.value);
  }
}

function onCreativesModelChange() {
  var sel = document.getElementById('creatives-model-select');
  var model = creativesState.models.find(function(m) { return m.id === sel.value; });
  if (model) {
    var countEl = document.getElementById('creatives-ref-count');
    if (countEl) countEl.textContent = creativesState.referenceImages.length + ' / ' + model.maxReferenceImages + ' max';
    checkRefImageLimit();
  }
}

function onCreativesTemplateChange() {
  var sel = document.getElementById('creatives-template-select');
  if (!sel.value) return;
  var t = creativesState.templates.find(function(tmpl) { return tmpl.id === sel.value; });
  if (!t) return;
  document.getElementById('creatives-prompt').value = t.prompt || '';
  document.getElementById('creatives-negative-prompt').value = t.negativePrompt || '';
  if (t.defaultAspectRatio) {
    setAspectRatio(t.defaultAspectRatio, document.querySelector('.ar-btn[data-ar="' + t.defaultAspectRatio + '"]'));
  }
  if (t.defaultModel) {
    var modelSel = document.getElementById('creatives-model-select');
    if (modelSel) modelSel.value = t.defaultModel;
    onCreativesModelChange();
  }
}
```

- [ ] **Step 3: Add aspect ratio, reference image rendering, and limit checking**

```javascript
function setAspectRatio(ar, btn) {
  creativesState.aspectRatio = ar;
  document.querySelectorAll('.ar-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  var customDiv = document.getElementById('creatives-custom-ar');
  if (customDiv) customDiv.style.display = ar === 'custom' ? 'flex' : 'none';
}

function renderCreativesRefImages() {
  var container = document.getElementById('creatives-ref-images');
  if (!container) return;
  container.innerHTML = creativesState.referenceImages.map(function(ref, i) {
    var borderColor = ref.type === 'product' ? '#6c5ce7' : '#00b894';
    var bgColor = ref.type === 'product' ? 'rgba(108,92,231,0.1)' : 'rgba(0,184,148,0.1)';
    var imgSrc = ref.type === 'product'
      ? '/api/creatives/product-image/' + ref.path
      : '/api/creatives/reference-image/' + ref.path;
    var label = ref.handle || ref.path.split('/').pop();
    if (label.length > 12) label = label.substring(0, 12) + '...';
    return '<div style="position:relative;width:64px;height:64px;border:2px solid ' + borderColor + ';border-radius:6px;background:' + bgColor + ';overflow:hidden;flex-shrink:0;">'
      + '<img src="' + imgSrc + '" style="width:100%;height:100%;object-fit:cover;" />'
      + '<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);font-size:8px;color:white;padding:1px 3px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>'
      + '<button onclick="removeRefImage(' + i + ')" style="position:absolute;top:-4px;right:-4px;background:' + borderColor + ';color:white;border:none;border-radius:50%;width:16px;height:16px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;">x</button>'
      + '</div>';
  }).join('');
  updateRefCount();
}

function updateRefCount() {
  var model = creativesState.models.find(function(m) { return m.id === (document.getElementById('creatives-model-select') || {}).value; });
  var max = model ? model.maxReferenceImages : 10;
  var countEl = document.getElementById('creatives-ref-count');
  if (countEl) countEl.textContent = creativesState.referenceImages.length + ' / ' + max + ' max';
  checkRefImageLimit();
}

function checkRefImageLimit() {
  var model = creativesState.models.find(function(m) { return m.id === (document.getElementById('creatives-model-select') || {}).value; });
  var max = model ? model.maxReferenceImages : 10;
  var atLimit = creativesState.referenceImages.length >= max;
  var addProduct = document.getElementById('creatives-add-product-btn');
  var addUpload = document.getElementById('creatives-add-upload-btn');
  if (addProduct) { addProduct.disabled = atLimit; addProduct.style.opacity = atLimit ? '0.4' : '1'; addProduct.title = atLimit ? 'Maximum reference images reached for this model' : ''; }
  if (addUpload) { addUpload.disabled = atLimit; addUpload.style.opacity = atLimit ? '0.4' : '1'; addUpload.title = atLimit ? 'Maximum reference images reached for this model' : ''; }
}

function removeRefImage(index) {
  creativesState.referenceImages.splice(index, 1);
  renderCreativesRefImages();
  updateProductContext();
}
```

- [ ] **Step 4: Add image display and filmstrip rendering**

```javascript
function showCreativeImage(imagePath, version) {
  var img = document.getElementById('creatives-current-image');
  var placeholder = document.getElementById('creatives-placeholder');
  var downloadBtn = document.getElementById('creatives-download-btn');
  var compareBtn = document.getElementById('creatives-compare-btn');
  var packageBtn = document.getElementById('creatives-package-btn');
  if (img) { img.src = '/api/creatives/image/' + imagePath; img.style.display = 'block'; }
  if (placeholder) placeholder.style.display = 'none';
  if (downloadBtn) downloadBtn.style.display = '';
  if (compareBtn) compareBtn.style.display = '';
  if (packageBtn) packageBtn.style.display = '';
  creativesState.currentVersion = version;
}

function hideCreativeImage() {
  var img = document.getElementById('creatives-current-image');
  var placeholder = document.getElementById('creatives-placeholder');
  var downloadBtn = document.getElementById('creatives-download-btn');
  var compareBtn = document.getElementById('creatives-compare-btn');
  var packageBtn = document.getElementById('creatives-package-btn');
  if (img) { img.style.display = 'none'; img.src = ''; }
  if (placeholder) placeholder.style.display = '';
  if (downloadBtn) downloadBtn.style.display = 'none';
  if (compareBtn) compareBtn.style.display = 'none';
  if (packageBtn) packageBtn.style.display = 'none';
}

function renderCreativesFilmstrip(versions) {
  var container = document.getElementById('creatives-filmstrip');
  if (!container) return;
  if (!versions || versions.length === 0) { container.innerHTML = '<span style="font-size:11px;color:var(--muted);">No versions yet</span>'; return; }
  // Show newest first, favorites pinned at start
  var favs = versions.filter(function(v) { return v.favorited; });
  var rest = versions.filter(function(v) { return !v.favorited; }).reverse();
  var ordered = favs.concat(rest);
  container.innerHTML = ordered.map(function(v) {
    var isCurrent = v.version === creativesState.currentVersion;
    var borderColor = v.favorited ? '#f9ca24' : (isCurrent ? '#6c5ce7' : 'var(--border)');
    var borderWidth = (v.favorited || isCurrent) ? '2px' : '1px';
    var label = 'v' + v.version + (v.favorited ? ' \\u2605' : '');
    var textColor = v.favorited ? '#f9ca24' : (isCurrent ? '#6c5ce7' : 'var(--muted)');
    return '<div onclick="selectFilmstripVersion(' + v.version + ')" style="position:relative;width:50px;height:50px;border:' + borderWidth + ' solid ' + borderColor + ';border-radius:5px;flex-shrink:0;cursor:pointer;overflow:hidden;background:var(--card);">'
      + '<img src="/api/creatives/image/' + v.imagePath + '" style="width:100%;height:100%;object-fit:cover;" />'
      + '<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);font-size:8px;color:' + textColor + ';text-align:center;padding:1px;font-weight:600;">' + label + '</div>'
      + '<button onclick="event.stopPropagation();toggleFavorite(' + v.version + ')" style="position:absolute;top:1px;right:1px;background:none;border:none;color:' + (v.favorited ? '#f9ca24' : 'rgba(255,255,255,0.4)') + ';font-size:10px;cursor:pointer;padding:0;line-height:1;">\\u2605</button>'
      + '</div>';
  }).join('');
}

function selectFilmstripVersion(version) {
  if (creativesState.compareMode) {
    if (creativesState.compareVersions.length < 2) {
      creativesState.compareVersions.push(version);
      if (creativesState.compareVersions.length === 2) renderCompareView();
    }
    return;
  }
  // Load the session to find the version
  fetch('/api/creatives/sessions/' + creativesState.sessionId).then(function(r) { return r.json(); }).then(function(session) {
    var v = session.versions.find(function(ver) { return ver.version === version; });
    if (v) showCreativeImage(v.imagePath, v.version);
    renderCreativesFilmstrip(session.versions);
  });
}

async function toggleFavorite(version) {
  if (!creativesState.sessionId) return;
  var resp = await fetch('/api/creatives/sessions/' + creativesState.sessionId);
  var session = await resp.json();
  var v = session.versions.find(function(ver) { return ver.version === version; });
  if (v) {
    v.favorited = !v.favorited;
    await fetch('/api/creatives/sessions/' + creativesState.sessionId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versions: session.versions })
    });
    renderCreativesFilmstrip(session.versions);
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add creatives tab browser JS — state management, rendering, filmstrip"
```

---

### Task 15: Creatives tab — browser JavaScript (generate, refine, upload, download, package)

**Files:**
- Modify: `agents/dashboard/index.js` (continue inside `<script>` block)

- [ ] **Step 1: Add generate and refine functions**

```javascript
async function generateCreativeImage() {
  var prompt = document.getElementById('creatives-prompt').value.trim();
  if (!prompt) { alert('Please enter a prompt'); return; }

  var model = document.getElementById('creatives-model-select').value;
  var negativePrompt = document.getElementById('creatives-negative-prompt').value.trim();
  var aspectRatio = creativesState.aspectRatio;

  showCreativesSpinner('Generating with ' + model + '...');

  var formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('negativePrompt', negativePrompt);
  formData.append('model', model);
  formData.append('aspectRatio', aspectRatio);
  if (creativesState.sessionId) formData.append('sessionId', creativesState.sessionId);
  if (aspectRatio === 'custom') {
    formData.append('customWidth', document.getElementById('creatives-custom-w').value);
    formData.append('customHeight', document.getElementById('creatives-custom-h').value);
  }

  // Collect product image paths
  var productPaths = creativesState.referenceImages
    .filter(function(r) { return r.type === 'product'; })
    .map(function(r) { return r.path; });
  if (productPaths.length > 0) formData.append('productImagePaths', JSON.stringify(productPaths));

  // Add uploaded reference images that are files (not yet saved to server)
  var uploadedRefs = creativesState.referenceImages.filter(function(r) { return r.type === 'uploaded' && r.file; });
  for (var i = 0; i < uploadedRefs.length; i++) {
    formData.append('referenceImages', uploadedRefs[i].file);
  }

  try {
    var resp = await fetch('/api/creatives/generate', { method: 'POST', body: formData });
    var data = await resp.json();
    if (!resp.ok) {
      showCreativesError(data.error || 'Generation failed');
      return;
    }
    creativesState.sessionId = data.sessionId;
    creativesState.currentVersion = data.version;

    // Update session name
    if (data.sessionName) {
      var nameEl = document.getElementById('creatives-session-name');
      if (nameEl) nameEl.textContent = data.sessionName;
    }

    showCreativeImage(data.imagePath, data.version);

    // Refresh filmstrip and sessions
    var sessionResp = await fetch('/api/creatives/sessions/' + data.sessionId);
    var session = await sessionResp.json();
    renderCreativesFilmstrip(session.versions);
    var sessionsResp = await fetch('/api/creatives/sessions');
    creativesState.sessions = await sessionsResp.json();
    renderCreativesSessions();
    document.getElementById('creatives-session-select').value = data.sessionId;
    showAutosaveIndicator();
  } catch (err) {
    showCreativesError('Generation failed: ' + err.message);
  } finally {
    hideCreativesSpinner();
  }
}

async function refineCreativeImage() {
  var refinement = document.getElementById('creatives-refine-input').value.trim();
  if (!refinement) return;
  if (!creativesState.sessionId || !creativesState.currentVersion) { alert('Generate an image first'); return; }

  var model = document.getElementById('creatives-model-select').value;
  showCreativesSpinner('Refining...');

  try {
    var resp = await fetch('/api/creatives/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: creativesState.sessionId,
        version: creativesState.currentVersion,
        refinement: refinement,
        model: model
      })
    });
    var data = await resp.json();
    if (!resp.ok) {
      showCreativesError(data.error || 'Refinement failed');
      return;
    }
    showCreativeImage(data.imagePath, data.version);
    document.getElementById('creatives-refine-input').value = '';

    // Refresh filmstrip
    var sessionResp = await fetch('/api/creatives/sessions/' + creativesState.sessionId);
    var session = await sessionResp.json();
    renderCreativesFilmstrip(session.versions);
    showAutosaveIndicator();
  } catch (err) {
    showCreativesError('Refinement failed: ' + err.message);
  } finally {
    hideCreativesSpinner();
  }
}
```

- [ ] **Step 2: Add upload, download, and packaging functions**

```javascript
function openProductImagePicker() {
  openProductImageModal();
}

function openReferenceUpload() {
  document.getElementById('creatives-upload-input').click();
}

async function handleReferenceUpload(input) {
  if (!input.files || input.files.length === 0) return;
  for (var i = 0; i < input.files.length; i++) {
    var file = input.files[i];
    creativesState.referenceImages.push({ type: 'uploaded', path: file.name, file: file });
  }
  renderCreativesRefImages();
  updateProductContext();
  input.value = '';
}

function downloadCreativeImage() {
  if (!creativesState.sessionId || !creativesState.currentVersion) return;
  fetch('/api/creatives/sessions/' + creativesState.sessionId).then(function(r) { return r.json(); }).then(function(session) {
    var v = session.versions.find(function(ver) { return ver.version === creativesState.currentVersion; });
    if (v) window.open('/api/creatives/image/' + v.imagePath + '?download=1', '_blank');
  });
}

async function packageCreative() {
  if (!creativesState.sessionId || !creativesState.currentVersion) return;
  var packageBtn = document.getElementById('creatives-package-btn');
  if (packageBtn) packageBtn.textContent = '\\u{1F4E6} Packaging...';
  if (packageBtn) packageBtn.disabled = true;

  try {
    var resp = await fetch('/api/creatives/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: creativesState.sessionId, version: creativesState.currentVersion })
    });
    var data = await resp.json();
    if (!resp.ok) { showCreativesError(data.error || 'Packaging failed'); return; }

    // Poll for completion
    pollCreativePackage(data.jobId);
  } catch (err) {
    showCreativesError('Packaging failed: ' + err.message);
    if (packageBtn) { packageBtn.textContent = '\\u{1F4E6} Package for All Placements'; packageBtn.disabled = false; }
  }
}

function pollCreativePackage(jobId) {
  var attempts = 0;
  var maxAttempts = 60;
  var interval = setInterval(async function() {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      showCreativesError('Packaging timed out');
      resetPackageBtn();
      return;
    }
    try {
      var resp = await fetch('/api/creatives/package/' + jobId);
      var data = await resp.json();
      if (data.status === 'complete') {
        clearInterval(interval);
        resetPackageBtn();
        window.open(data.downloadUrl, '_blank');
      } else if (data.status === 'error') {
        clearInterval(interval);
        showCreativesError('Packaging error: ' + (data.error || 'Unknown'));
        resetPackageBtn();
      }
    } catch (err) {
      clearInterval(interval);
      showCreativesError('Polling error: ' + err.message);
      resetPackageBtn();
    }
  }, 3000);
}

function resetPackageBtn() {
  var btn = document.getElementById('creatives-package-btn');
  if (btn) { btn.textContent = '\\u{1F4E6} Package for All Placements'; btn.disabled = false; }
}
```

- [ ] **Step 3: Add spinner, error, and autosave helpers**

```javascript
function showCreativesSpinner(text) {
  var spinner = document.getElementById('creatives-spinner');
  var spinText = document.getElementById('creatives-spinner-text');
  if (spinner) spinner.style.display = 'flex';
  if (spinText) spinText.textContent = text || 'Generating...';
}

function hideCreativesSpinner() {
  var spinner = document.getElementById('creatives-spinner');
  if (spinner) spinner.style.display = 'none';
}

function showCreativesError(msg) {
  var errDiv = document.getElementById('creatives-error');
  var errText = document.getElementById('creatives-error-text');
  if (errDiv) errDiv.style.display = '';
  if (errText) errText.textContent = msg;
}

function showAutosaveIndicator() {
  var el = document.getElementById('creatives-autosave-indicator');
  if (el) { el.textContent = 'saved'; el.style.color = '#00b894'; }
}

function editSessionName() {
  if (!creativesState.sessionId) return;
  var nameEl = document.getElementById('creatives-session-name');
  var current = nameEl ? nameEl.textContent : '';
  var newName = prompt('Rename session:', current);
  if (!newName || newName === current) return;
  fetch('/api/creatives/sessions/' + creativesState.sessionId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName, nameAutoGenerated: false })
  }).then(function() {
    if (nameEl) nameEl.textContent = newName;
    return fetch('/api/creatives/sessions');
  }).then(function(r) { return r.json(); }).then(function(sessions) {
    creativesState.sessions = sessions;
    renderCreativesSessions();
    document.getElementById('creatives-session-select').value = creativesState.sessionId;
  });
}
```

- [ ] **Step 4: Add multi-product context rendering**

```javascript
function updateProductContext() {
  var productRefs = creativesState.referenceImages.filter(function(r) { return r.type === 'product'; });
  var contextDiv = document.getElementById('creatives-product-context');
  var contextBody = document.getElementById('creatives-product-context-body');
  if (!contextDiv || !contextBody) return;

  if (productRefs.length < 2) {
    contextDiv.style.display = 'none';
    return;
  }

  contextDiv.style.display = '';
  // Fetch manifest for product descriptions
  fetch('/api/creatives/product-images').then(function(r) { return r.json(); }).then(function(manifest) {
    contextBody.innerHTML = productRefs.map(function(ref, i) {
      var product = manifest.find(function(p) { return p.handle === ref.handle; });
      var title = product ? product.title : ref.handle;
      var desc = product ? (product.productDescription || 'No description') : 'Uploaded reference';
      return '<div style="margin-bottom:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;">'
        + '<div style="font-size:12px;font-weight:600;color:var(--fg);">' + (i + 1) + '. ' + title + '</div>'
        + '<textarea style="width:100%;margin-top:4px;background:var(--card);border:1px solid var(--border);border-radius:4px;padding:6px;color:var(--fg);font-size:11px;resize:vertical;box-sizing:border-box;font-family:inherit;" rows="2"'
        + ' data-product-index="' + i + '" onchange="updateProductDesc(' + i + ',this.value)">' + desc + '</textarea>'
        + '</div>';
    }).join('');
  });
}

function toggleProductContext() {
  var body = document.getElementById('creatives-product-context-body');
  var arrow = document.getElementById('creatives-product-context-arrow');
  if (!body) return;
  var hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (arrow) arrow.innerHTML = hidden ? '&#9660;' : '&#9654;';
}
```

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add creatives tab browser JS — generate, refine, upload, download, package"
```

---

### Task 16: Compare mode

**Files:**
- Modify: `agents/dashboard/index.js` (add inside `<script>` block)

- [ ] **Step 1: Add compare mode functions**

```javascript
function toggleCompareMode() {
  creativesState.compareMode = !creativesState.compareMode;
  creativesState.compareVersions = [];
  var compareBtn = document.getElementById('creatives-compare-btn');
  var compareDiv = document.getElementById('creatives-compare');
  var imageEl = document.getElementById('creatives-current-image');
  var placeholder = document.getElementById('creatives-placeholder');

  if (creativesState.compareMode) {
    if (compareBtn) compareBtn.style.background = '#6c5ce7';
    if (compareBtn) compareBtn.style.color = 'white';
    if (compareDiv) { compareDiv.style.display = 'flex'; compareDiv.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;">Select two versions from the filmstrip to compare</div>'; }
    if (imageEl) imageEl.style.display = 'none';
    if (placeholder) placeholder.style.display = 'none';
  } else {
    if (compareBtn) compareBtn.style.background = 'var(--card)';
    if (compareBtn) compareBtn.style.color = 'var(--muted)';
    if (compareDiv) { compareDiv.style.display = 'none'; compareDiv.innerHTML = ''; }
    // Restore current image
    if (creativesState.currentVersion) {
      fetch('/api/creatives/sessions/' + creativesState.sessionId).then(function(r) { return r.json(); }).then(function(session) {
        var v = session.versions.find(function(ver) { return ver.version === creativesState.currentVersion; });
        if (v) showCreativeImage(v.imagePath, v.version);
      });
    }
  }
}

async function renderCompareView() {
  var compareDiv = document.getElementById('creatives-compare');
  if (!compareDiv || creativesState.compareVersions.length < 2) return;

  var resp = await fetch('/api/creatives/sessions/' + creativesState.sessionId);
  var session = await resp.json();
  var v1 = session.versions.find(function(v) { return v.version === creativesState.compareVersions[0]; });
  var v2 = session.versions.find(function(v) { return v.version === creativesState.compareVersions[1]; });
  if (!v1 || !v2) return;

  var makePanel = function(v) {
    var label = v.favorited ? '\\u2605 Version ' + v.version + ' \\u2014 Favorite' : 'Version ' + v.version;
    var borderColor = v.favorited ? '#f9ca24' : '#6c5ce7';
    var promptText = v.refinement ? 'Refinement: ' + v.refinement : (v.prompt || '').substring(0, 100) + '...';
    return '<div style="flex:1;text-align:center;padding:8px;">'
      + '<div style="font-size:12px;color:' + borderColor + ';margin-bottom:6px;font-weight:600;">' + label + '</div>'
      + '<img src="/api/creatives/image/' + v.imagePath + '" style="max-width:100%;max-height:280px;border:2px solid ' + borderColor + ';border-radius:8px;" />'
      + '<div style="margin-top:6px;font-size:10px;color:var(--muted);background:var(--bg);border-radius:4px;padding:6px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + promptText + '</div>'
      + '<button onclick="useCompareVersion(' + v.version + ')" style="margin-top:6px;padding:4px 10px;background:#6c5ce7;color:white;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Use This Version</button>'
      + '</div>';
  };

  compareDiv.innerHTML = '<div style="display:flex;width:100%;gap:12px;align-items:flex-start;">'
    + makePanel(v1)
    + makePanel(v2)
    + '</div>'
    + '<div style="text-align:center;margin-top:8px;"><button onclick="toggleCompareMode()" style="padding:4px 12px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;">Exit Compare</button></div>';
  compareDiv.style.flexDirection = 'column';
}

function useCompareVersion(version) {
  toggleCompareMode();
  selectFilmstripVersion(version);
}
```

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add side-by-side compare mode for creatives"
```

---

### Task 17: Product image picker modal

**Files:**
- Modify: `agents/dashboard/index.js` (add HTML modal + JS)

- [ ] **Step 1: Add modal HTML**

Add this HTML just before the closing `</body>` tag (or near other modals in the template):

```html
<!-- Product Image Picker Modal -->
<div id="product-image-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;" onclick="if(event.target===this)closeProductImageModal()">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;max-width:640px;width:90%;max-height:80vh;overflow:auto;padding:20px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <h3 style="margin:0;font-size:16px;">Select Product Images</h3>
      <button onclick="closeProductImageModal()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">x</button>
    </div>
    <div id="product-image-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px;"></div>
  </div>
</div>
```

- [ ] **Step 2: Add modal JavaScript**

```javascript
async function openProductImageModal() {
  var modal = document.getElementById('product-image-modal');
  var grid = document.getElementById('product-image-grid');
  if (!modal || !grid) return;
  modal.style.display = 'flex';
  grid.innerHTML = '<p style="color:var(--muted);grid-column:1/-1;">Loading products...</p>';

  try {
    var products = await fetch('/api/creatives/product-images').then(function(r) { return r.json(); });
    grid.innerHTML = products.map(function(p) {
      var mainImg = p.images && p.images.length > 0 ? p.images[0] : null;
      var imgSrc = mainImg ? '/api/creatives/product-image/' + (p.imageDir || p.handle) + '/' + mainImg : '';
      var alreadySelected = creativesState.referenceImages.some(function(r) { return r.handle === p.handle; });
      var opacity = alreadySelected ? '0.4' : '1';
      return '<div style="cursor:pointer;opacity:' + opacity + ';" onclick="selectProductImage(&apos;' + p.handle + '&apos;,&apos;' + (p.imageDir || p.handle) + '/' + (mainImg || '') + '&apos;,this)">'
        + (imgSrc ? '<img src="' + imgSrc + '" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);" />' : '<div style="width:100%;aspect-ratio:1;background:var(--bg);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px;">No image</div>')
        + '<div style="font-size:11px;color:var(--fg);margin-top:4px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (p.title || p.handle) + '</div>'
        + (alreadySelected ? '<div style="font-size:9px;color:#6c5ce7;text-align:center;">Selected</div>' : '')
        + '</div>';
    }).join('');
  } catch (err) {
    grid.innerHTML = '<p style="color:#e17055;">Failed to load products: ' + err.message + '</p>';
  }
}

function selectProductImage(handle, imgPath, el) {
  if (creativesState.referenceImages.some(function(r) { return r.handle === handle; })) return;
  creativesState.referenceImages.push({ type: 'product', handle: handle, path: imgPath });
  renderCreativesRefImages();
  updateProductContext();
  closeProductImageModal();
}

function closeProductImageModal() {
  var modal = document.getElementById('product-image-modal');
  if (modal) modal.style.display = 'none';
}
```

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add product image picker modal for creatives tab"
```

---

### Task 18: Template management modal

**Files:**
- Modify: `agents/dashboard/index.js` (add HTML modal + JS)

- [ ] **Step 1: Add template management modal HTML**

Add near the product image modal:

```html
<!-- Template Management Modal -->
<div id="template-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;" onclick="if(event.target===this)closeTemplateModal()">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;max-width:720px;width:90%;max-height:80vh;overflow:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);">
      <h3 style="margin:0;font-size:16px;">Manage Templates</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <button onclick="openNewTemplateForm()" style="padding:6px 14px;background:#6c5ce7;color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">+ New Template</button>
        <button onclick="openCreateFromImage()" style="padding:6px 14px;background:linear-gradient(135deg,#e17055,#d63031);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">Create from Image</button>
        <button onclick="closeTemplateModal()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;">x</button>
      </div>
    </div>
    <div id="template-modal-body" style="padding:12px 20px;"></div>
  </div>
</div>
```

- [ ] **Step 2: Add template modal JavaScript — list, edit, delete**

```javascript
function openManageTemplates() {
  var modal = document.getElementById('template-modal');
  if (modal) modal.style.display = 'flex';
  renderTemplateList();
}

function closeTemplateModal() {
  var modal = document.getElementById('template-modal');
  if (modal) modal.style.display = 'none';
}

async function renderTemplateList() {
  var body = document.getElementById('template-modal-body');
  if (!body) return;
  body.innerHTML = '<p style="color:var(--muted);">Loading...</p>';

  var templates = await fetch('/api/creatives/templates').then(function(r) { return r.json(); });
  creativesState.templates = templates;
  renderCreativesTemplates();

  if (templates.length === 0) {
    body.innerHTML = '<p style="color:var(--muted);padding:20px 0;">No templates yet. Create one!</p>';
    return;
  }

  body.innerHTML = templates.map(function(t) {
    var badge = t.source === 'ai'
      ? '<span style="font-size:10px;background:#e17055;color:white;padding:2px 6px;border-radius:4px;margin-left:8px;">AI-generated</span>'
      : '<span style="font-size:10px;background:#6c5ce7;color:white;padding:2px 6px;border-radius:4px;margin-left:8px;">manual</span>';
    var preview = t.previewImage
      ? '<img src="/api/creatives/template-preview/' + t.previewImage + '" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--border);" />'
      : '<div style="width:60px;height:60px;background:var(--bg);border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:24px;">&#128196;</div>';
    var promptPreview = (t.prompt || '').substring(0, 80) + ((t.prompt || '').length > 80 ? '...' : '');
    return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px;">'
      + '<div style="display:flex;gap:14px;">'
      + preview
      + '<div style="flex:1;min-width:0;">'
      + '<div style="display:flex;align-items:center;">'
      + '<span style="font-weight:600;color:var(--fg);font-size:14px;">' + t.name + '</span>'
      + badge
      + '</div>'
      + '<p style="color:var(--muted);font-size:12px;margin:4px 0 8px;">' + (t.description || '') + '</p>'
      + '<div style="color:var(--muted);font-size:11px;background:var(--card);border-radius:4px;padding:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + promptPreview + '</div>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">'
      + '<button onclick="editTemplate(&apos;' + t.id + '&apos;)" style="padding:4px 10px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:4px;font-size:11px;cursor:pointer;">Edit</button>'
      + '<button onclick="deleteTemplate(&apos;' + t.id + '&apos;)" style="padding:4px 10px;background:var(--card);color:#e17055;border:1px solid var(--border);border-radius:4px;font-size:11px;cursor:pointer;">Delete</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }).join('');
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  await fetch('/api/creatives/templates/' + id, { method: 'DELETE' });
  renderTemplateList();
}

function editTemplate(id) {
  var t = creativesState.templates.find(function(tmpl) { return tmpl.id === id; });
  if (!t) return;
  openTemplateForm(t);
}

function openNewTemplateForm() {
  openTemplateForm(null);
}

function openTemplateForm(existing) {
  var body = document.getElementById('template-modal-body');
  if (!body) return;
  var t = existing || { id: '', name: '', description: '', prompt: '', negativePrompt: '', tags: [], defaultAspectRatio: '1:1', defaultModel: 'gemini-2.0-flash-exp' };
  var isEdit = !!existing;

  body.innerHTML = '<div style="max-width:500px;">'
    + '<h4 style="margin-top:0;">' + (isEdit ? 'Edit' : 'New') + ' Template</h4>'
    + '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--muted);">Name</label><input id="tpl-name" value="' + (t.name || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
    + '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--muted);">Description</label><input id="tpl-desc" value="' + (t.description || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
    + '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--muted);">Prompt</label><textarea id="tpl-prompt" rows="5" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;color:var(--fg);font-size:12px;resize:vertical;box-sizing:border-box;font-family:inherit;">' + (t.prompt || '') + '</textarea></div>'
    + '<div style="margin-bottom:8px;"><label style="font-size:11px;color:#e17055;">Negative Prompt</label><input id="tpl-neg" value="' + (t.negativePrompt || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
    + '<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--muted);">Tags (comma-separated)</label><input id="tpl-tags" value="' + (t.tags || []).join(', ') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">'
    + '<button onclick="renderTemplateList()" style="padding:6px 14px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>'
    + '<button onclick="saveTemplateForm(&apos;' + (t.id || '') + '&apos;,' + isEdit + ')" style="padding:6px 14px;background:#00b894;color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">Save</button>'
    + '</div>'
    + '</div>';
}

async function saveTemplateForm(existingId, isEdit) {
  var name = document.getElementById('tpl-name').value.trim();
  var desc = document.getElementById('tpl-desc').value.trim();
  var prompt = document.getElementById('tpl-prompt').value.trim();
  var neg = document.getElementById('tpl-neg').value.trim();
  var tags = document.getElementById('tpl-tags').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  if (!name || !prompt) { alert('Name and prompt are required'); return; }

  var id = existingId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  var data = { id: id, name: name, description: desc, prompt: prompt, negativePrompt: neg, tags: tags };

  if (isEdit) {
    await fetch('/api/creatives/templates/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } else {
    data.source = 'manual';
    await fetch('/api/creatives/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }
  renderTemplateList();
}
```

- [ ] **Step 3: Add "Create from Image" JavaScript**

```javascript
function openCreateFromImage() {
  var body = document.getElementById('template-modal-body');
  if (!body) return;

  body.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">'
    + '<div>'
    + '<label style="font-size:11px;color:var(--muted);text-transform:uppercase;">Reference Image</label>'
    + '<div id="tpl-from-image-drop" style="margin-top:8px;border:2px dashed #e17055;border-radius:8px;aspect-ratio:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;cursor:pointer;" onclick="document.getElementById(&apos;tpl-from-image-input&apos;).click()">'
    + '<div style="font-size:36px;">&#128248;</div>'
    + '<span style="color:#e17055;font-size:13px;">Drop image here or click to browse</span>'
    + '</div>'
    + '<input id="tpl-from-image-input" type="file" accept="image/*" style="display:none;" onchange="previewFromImage(this)" />'
    + '</div>'
    + '<div id="tpl-from-image-fields">'
    + '<p style="color:var(--muted);font-size:13px;">Upload an image and click Analyze to generate a template.</p>'
    + '</div>'
    + '</div>';
}

function previewFromImage(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  var reader = new FileReader();
  reader.onload = function(e) {
    var drop = document.getElementById('tpl-from-image-drop');
    if (drop) drop.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover;border-radius:6px;" />';
    var fields = document.getElementById('tpl-from-image-fields');
    if (fields) fields.innerHTML = '<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px;">'
      + '<button onclick="renderTemplateList()" style="padding:6px 14px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>'
      + '<button id="tpl-analyze-btn" onclick="analyzeTemplateImage()" style="padding:6px 14px;background:#e17055;color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">Analyze Image</button>'
      + '</div>'
      + '<p style="color:var(--muted);font-size:12px;">Click Analyze to have AI generate a template from this image.</p>';
  };
  reader.readAsDataURL(file);
}

async function analyzeTemplateImage() {
  var input = document.getElementById('tpl-from-image-input');
  if (!input.files || !input.files[0]) return;

  var btn = document.getElementById('tpl-analyze-btn');
  if (btn) { btn.textContent = 'Analyzing...'; btn.disabled = true; }

  var formData = new FormData();
  formData.append('image', input.files[0]);

  try {
    var resp = await fetch('/api/creatives/templates/from-image', { method: 'POST', body: formData });
    var data = await resp.json();
    if (!resp.ok) { alert(data.error || 'Analysis failed'); return; }

    var t = data.template;
    var fields = document.getElementById('tpl-from-image-fields');
    if (!fields) return;

    fields.innerHTML = '<div style="margin-bottom:8px;"><label style="font-size:10px;color:var(--muted);">Name</label><input id="tpl-ai-name" value="' + (t.name || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
      + '<div style="margin-bottom:8px;"><label style="font-size:10px;color:var(--muted);">Description</label><input id="tpl-ai-desc" value="' + (t.description || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
      + '<div style="margin-bottom:8px;"><label style="font-size:10px;color:var(--muted);">Prompt</label><textarea id="tpl-ai-prompt" rows="5" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px;color:var(--fg);font-size:12px;resize:vertical;box-sizing:border-box;font-family:inherit;">' + (t.prompt || '') + '</textarea></div>'
      + '<div style="margin-bottom:8px;"><label style="font-size:10px;color:#e17055;">Negative Prompt</label><input id="tpl-ai-neg" value="' + (t.negativePrompt || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
      + '<div style="margin-bottom:8px;"><label style="font-size:10px;color:var(--muted);">Tags</label><input id="tpl-ai-tags" value="' + (t.tags || []).join(', ') + '" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px;color:var(--fg);font-size:13px;box-sizing:border-box;" /></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
      + '<button onclick="renderTemplateList()" style="padding:6px 14px;background:var(--card);color:var(--muted);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>'
      + '<button onclick="saveAiTemplate(&apos;' + (data.previewPath || '') + '&apos;)" style="padding:6px 14px;background:#00b894;color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">Save Template</button>'
      + '</div>';
  } catch (err) {
    alert('Analysis failed: ' + err.message);
  } finally {
    if (btn) { btn.textContent = 'Analyze Image'; btn.disabled = false; }
  }
}

async function saveAiTemplate(previewPath) {
  var name = document.getElementById('tpl-ai-name').value.trim();
  var prompt = document.getElementById('tpl-ai-prompt').value.trim();
  if (!name || !prompt) { alert('Name and prompt are required'); return; }

  var data = {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: name,
    description: document.getElementById('tpl-ai-desc').value.trim(),
    prompt: prompt,
    negativePrompt: document.getElementById('tpl-ai-neg').value.trim(),
    tags: document.getElementById('tpl-ai-tags').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
    source: 'ai',
    previewImage: previewPath || null
  };

  await fetch('/api/creatives/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  renderTemplateList();
}
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add template management modal with Create from Image flow"
```

---

### Task 19: Drag-and-drop reference image upload

**Files:**
- Modify: `agents/dashboard/index.js` (add JS for drag-and-drop on the left panel)

- [ ] **Step 1: Add drag-and-drop event handlers**

Add this JavaScript to enable dropping files onto the left panel:

```javascript
// Drag-and-drop for reference images
document.addEventListener('DOMContentLoaded', function() {
  var tabPanel = document.getElementById('tab-creatives');
  if (!tabPanel) return;

  tabPanel.addEventListener('dragover', function(e) {
    if (activeTab !== 'creatives') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  tabPanel.addEventListener('drop', function(e) {
    if (activeTab !== 'creatives') return;
    e.preventDefault();
    var files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (var i = 0; i < files.length; i++) {
      if (!files[i].type.startsWith('image/')) continue;
      creativesState.referenceImages.push({ type: 'uploaded', path: files[i].name, file: files[i] });
    }
    renderCreativesRefImages();
    updateProductContext();
  });
});
```

Note: Since this code is inside the template literal and uses `DOMContentLoaded`, it will run when the page loads. The `activeTab` variable is already available from the dashboard's existing tab system.

- [ ] **Step 2: Add save-to-library functionality for uploaded references**

Modify `handleReferenceUpload` to include a save option. Add this function:

```javascript
async function saveRefToLibrary(index) {
  var ref = creativesState.referenceImages[index];
  if (!ref || !ref.file) return;
  var formData = new FormData();
  formData.append('image', ref.file);
  try {
    var resp = await fetch('/api/creatives/reference-images', { method: 'POST', body: formData });
    var data = await resp.json();
    if (resp.ok) {
      ref.path = data.filename;
      ref.file = null;
      ref.saved = true;
      renderCreativesRefImages();
    }
  } catch (err) {
    console.error('Failed to save reference image:', err);
  }
}
```

Update `renderCreativesRefImages()` to show a "Save" button on unsaved uploaded images. In the existing function, after the remove button line for uploaded refs, add:

```javascript
+ (ref.type === 'uploaded' && ref.file ? '<button onclick="saveRefToLibrary(' + i + ')" style="position:absolute;top:-4px;left:-4px;background:#00b894;color:white;border:none;border-radius:4px;font-size:8px;cursor:pointer;padding:1px 4px;">Save</button>' : '')
```

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add drag-and-drop upload and save-to-library for reference images"
```

---

### Task 20: End-to-end local verification

**Files:** None (testing only)

- [ ] **Step 1: Start the dashboard locally**

```bash
cd /Users/seanfillmore/Code/Claude
node agents/dashboard/index.js &
```

- [ ] **Step 2: Verify tab changes**

Open http://localhost:4242 in a browser. Check:
- Creatives tab pill is visible and clickable
- Ad Intelligence and Optimize pills are grayed out and non-clickable
- Clicking Creatives shows the two-panel layout

- [ ] **Step 3: Verify template loading**

On the Creatives tab, check:
- Model dropdown shows Gemini model options
- Template dropdown shows "Blank" plus the 7 starter templates
- Selecting a template populates the prompt and negative prompt fields
- "Manage" button opens the template management modal
- Templates are listed with edit/delete buttons

- [ ] **Step 4: Verify reference image functionality**

- Click "+ Product" — product image picker modal opens with product thumbnails
- Click a product — it appears in the reference images area with purple border
- Click "+ Upload" — file picker opens
- Select an image — it appears with green border
- Reference count updates (e.g. "2 / 10 max")
- Click × to remove a reference image

- [ ] **Step 5: Verify API endpoints**

```bash
curl -s http://localhost:4242/api/creatives/models | python3 -m json.tool
curl -s http://localhost:4242/api/creatives/templates | python3 -m json.tool | head -20
curl -s http://localhost:4242/api/creatives/product-images | python3 -m json.tool | head -20
curl -s http://localhost:4242/api/creatives/sessions | python3 -m json.tool
```

- [ ] **Step 6: Test image generation (requires GEMINI_API_KEY)**

If `GEMINI_API_KEY` is set in `.env`:
- Type a simple prompt (e.g. "A coconut oil deodorant on a white background")
- Click Generate
- Verify spinner appears, image loads, filmstrip updates
- Type a refinement ("make the background blue")
- Click Refine — new version appears
- Click the star on a filmstrip thumbnail — verify it pins
- Click Download — image downloads

- [ ] **Step 7: Stop the server**

```bash
kill %1
```

- [ ] **Step 8: Commit any fixes**

If any bugs were found and fixed during testing:

```bash
git add agents/dashboard/index.js
git commit -m "fix: address issues found during creatives tab local testing"
```

---

### Task 21: Final cleanup and PR

- [ ] **Step 1: Check for template literal escape issues**

Run the CLAUDE.md prescribed check:

```bash
grep -n '\\n\|[^\\]\\n' agents/dashboard/index.js | grep -v "^Binary" | head -30
```

Review any flagged lines inside the `<script>` block. Ensure all `\n` in browser string literals use `\\n`.

- [ ] **Step 2: Verify the server starts cleanly**

```bash
node agents/dashboard/index.js &
sleep 2
curl -s http://localhost:4242/api/creatives/models
kill %1
```

Expected: Server starts without errors, models endpoint returns JSON.

- [ ] **Step 3: Create final commit if any escape fixes were needed**

```bash
git add agents/dashboard/index.js
git commit -m "fix: escape sequence corrections in creatives tab browser JS"
```

- [ ] **Step 4: Push branch and create PR**

```bash
git push -u origin feature/creatives-tab
```

Then create PR with summary covering: new Creatives tab, disabled tabs, template system, session persistence, image generation/refinement, compare mode, packaging integration.
