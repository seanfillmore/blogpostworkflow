/**
 * Image Generator Agent
 *
 * Generates a hero image for a blog post using Gemini image generation.
 * Uses Claude to craft a brand-appropriate image prompt from the post metadata,
 * then calls Gemini (gemini-3.1-flash-image-preview) to generate the image.
 *
 * When product reference images are available (via --sync-products), the actual
 * product photo is passed as a reference image so Gemini can faithfully render
 * the real product in the styled scene.
 *
 * A built-in creative director step uses Claude Vision to review every generated image:
 *   - Flags visible text, logos, or labels (auto-regenerates)
 *   - Describes the scene so the next prompt can choose a different composition
 *   - Checks for surreal/AI-looking artifacts
 *
 * Requires: ANTHROPIC_API_KEY + GEMINI_API_KEY in .env
 *           data/posts/<slug>.json (run blog-post-writer first)
 *
 * Output:  data/images/<slug>.webp  — hero image at 16:9 2K (compressed to ~150KB)
 *          data/images/scene-log.json — scene descriptions to prevent repetition
 *          Updates data/posts/<slug>.json with image_path field
 *
 * Usage:
 *   node agents/image-generator/index.js data/posts/<slug>.json
 *   node agents/image-generator/index.js --all
 *   node agents/image-generator/index.js --sync-products      # download product images from Shopify
 *   node agents/image-generator/index.js --describe-products  # generate Claude Vision descriptions for each product
 *   node agents/image-generator/index.js --compress-existing
 *
 * Product reference workflow:
 *   1. Run --sync-products once to cache product images to data/product-images/
 *   2. Subsequent generations automatically detect relevant product images
 *      and include them as reference images in the Gemini request.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import sharp from 'sharp';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { getProducts } from '../../lib/shopify.js';
import { getMetaPath, getImagePath, listAllSlugs, ensurePostDir, POSTS_DIR, ROOT } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = join(ROOT, 'data', 'images');
const SCENE_LOG_PATH = join(IMAGES_DIR, 'scene-log.json');
const PRODUCT_IMAGES_DIR = join(ROOT, 'data', 'product-images');
const PRODUCT_MANIFEST_PATH = join(PRODUCT_IMAGES_DIR, 'manifest.json');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const ingredientsConfig = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
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
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }
if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) { console.error('Missing GEMINI_API_KEY or OPENAI_API_KEY in .env'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const gemini = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

// ── scene log (prevents repetitive compositions) ──────────────────────────────

function loadSceneLog() {
  try { return JSON.parse(readFileSync(SCENE_LOG_PATH, 'utf8')); }
  catch { return []; }
}

function saveSceneLog(log) {
  mkdirSync(IMAGES_DIR, { recursive: true });
  writeFileSync(SCENE_LOG_PATH, JSON.stringify(log, null, 2));
}

// ── image dimension check ─────────────────────────────────────────────────────

async function getImageDimensions(filePath) {
  const meta = await sharp(filePath).metadata();
  return { width: meta.width, height: meta.height };
}

// ── prompt generation ─────────────────────────────────────────────────────────

// Structured photography shot templates — each specifies surface, props, background, and lighting
// Deliberately specific to prevent DALL-E from inventing impossible architecture or random fixtures
const SCENE_TEMPLATES = [
  {
    key: 'linen-flatlay',
    surface: 'natural undyed linen fabric spread flat',
    background: 'same linen fabric, slightly blurred at edges',
    lighting: 'soft diffused overcast window light, no harsh shadows',
    angle: 'directly overhead flat lay, filling the full frame edge to edge',
  },
  {
    key: 'white-oak-table',
    surface: 'smooth white-oak wood tabletop with visible grain',
    background: 'blurred out-of-focus soft green foliage',
    lighting: 'warm golden morning side light from the left',
    angle: 'slightly elevated 30-degree angle, landscape crop',
  },
  {
    key: 'raw-concrete',
    surface: 'pale brushed concrete surface, matte texture',
    background: 'plain pale concrete wall, slightly out of focus',
    lighting: 'clean diffused studio light, even and bright',
    angle: '45-degree overhead shot, landscape orientation',
  },
  {
    key: 'terracotta-flatlay',
    surface: 'warm terracotta clay saucer or flat plate',
    background: 'natural linen fabric, soft and blurred',
    lighting: 'warm directional light from upper left, soft shadow',
    angle: 'overhead flat lay, tight crop filling the full frame',
  },
  {
    key: 'outdoor-stone',
    surface: 'smooth natural slate stone, outdoors on a garden table',
    background: 'blurred green garden foliage, soft bokeh',
    lighting: 'bright natural diffused daylight, slight dappled shadow',
    angle: 'low 20-degree angle shot, landscape banner crop',
  },
  {
    key: 'white-marble-slab',
    surface: 'white marble slab with subtle grey veining, no sink or fixtures',
    background: 'plain white surface continuing out of focus',
    lighting: 'bright even natural light from above, minimal shadows',
    angle: 'overhead flat lay or very slight angle, filling the frame',
  },
  {
    key: 'wicker-tray',
    surface: 'natural wicker tray on a light wood surface',
    background: 'blurred warm-toned linen or cotton fabric',
    lighting: 'warm soft window light from the right',
    angle: 'slight overhead angle, landscape crop',
  },
  {
    key: 'kraft-paper',
    surface: 'unbleached kraft paper spread flat on a wooden surface',
    background: 'same kraft paper extending to the edges',
    lighting: 'bright flat natural light, clean and editorial',
    angle: 'directly overhead flat lay',
  },
  {
    key: 'dark-wood-moody',
    surface: 'dark walnut wood surface, rich grain texture',
    background: 'blurred dark background, deep tones',
    lighting: 'single warm candle-like side light from the left, soft shadows',
    angle: '45-degree angle, landscape orientation',
  },
  {
    key: 'outdoor-windowsill',
    surface: 'painted white wooden windowsill',
    background: 'blurred soft natural outdoor greenery visible through glass',
    lighting: 'bright natural backlight from the window, soft halo effect',
    angle: 'straight-on eye-level shot, landscape crop',
  },
  {
    key: 'bathroom-counter',
    surface: 'white quartz bathroom counter, tight crop showing only the countertop surface — no sink or plumbing visible',
    background: 'soft blurred white tile wall',
    lighting: 'warm diffused morning light from a frosted window to the left',
    angle: 'straight-on eye-level shot, landscape crop',
  },
  {
    key: 'bathroom-shelf',
    surface: 'small floating white wooden bathroom shelf with product and a rolled hand towel beside it',
    background: 'blurred white or light grey wall behind',
    lighting: 'soft warm bathroom ambient light, even and flattering',
    angle: 'slight upward angle, eye-level, landscape crop',
  },
  {
    key: 'shower-niche',
    surface: 'white subway tile shower niche shelf, tight crop showing only the niche and its contents',
    background: 'blurred white tile surround',
    lighting: 'clean bright diffused light, minimal shadow',
    angle: 'straight-on slightly elevated shot, landscape crop',
  },
  {
    key: 'kitchen-counter',
    surface: 'light natural stone kitchen counter, tight countertop crop — no appliances or sink visible',
    background: 'blurred warm neutral kitchen wall or backsplash tile',
    lighting: 'bright natural light from a window above left, soft and even',
    angle: 'slight overhead angle, landscape crop',
  },
  {
    key: 'bedside-table',
    surface: 'light oak bedside table surface, clean and minimal',
    background: 'blurred warm-toned linen headboard or bedroom wall',
    lighting: 'warm soft lamp light from the right, intimate and cosy',
    angle: 'slight elevated angle, landscape crop',
  },
];

async function buildImagePrompt(meta, usedScenes, usedTemplateKeys = [], cdRejectionNote = '', hasProductRef = false, productIngredients = [], productDescription = null, variantTitles = []) {
  // Hard-exclude templates used in recent posts, then fall back to full set if too few remain
  const available = SCENE_TEMPLATES.filter((t) => !usedTemplateKeys.includes(t.key));
  const pool = available.length >= 3 ? available : SCENE_TEMPLATES.filter((t) => !usedTemplateKeys.slice(0, 3).includes(t.key));

  const usedSummary = usedScenes.length > 0
    ? `\nALREADY USED SCENES (do NOT reuse these):\n${usedScenes.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const rejectionNote = cdRejectionNote
    ? `\nPREVIOUS ATTEMPT WAS REJECTED — avoid these specific issues in the new prompt:\n${cdRejectionNote}\n`
    : '';

  const templateList = pool.map((t) =>
    `[${t.key}] Surface: ${t.surface} | Background: ${t.background} | Light: ${t.lighting} | Angle: ${t.angle}`
  ).join('\n');

  const ingredientNote = productIngredients.length > 0
    ? `\nINGREDIENT PROP RULE:\n- If you include any raw ingredient as a prop (a herb, fruit, spice, oil, powder, botanical — anything that implies it is IN the formula), it MUST appear in this list: ${productIngredients.join(', ')}\n- Contextual scene props are unrestricted: toothbrushes, faucets, towels, soap dishes, cups, trays, etc. are always fine\n`
    : '';

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: `You write hero image prompts for Gemini image generation for a natural skincare brand's blog.

Brand: ${config.name} — natural deodorant, toothpaste, coconut oil body lotion, lip balm. Visual aesthetic: bright, airy, minimal, warm natural tones. Real product photography style.

Blog post:
- Title: ${meta.title}
- Keyword: ${meta.target_keyword}
- Tags: ${(meta.tags || []).join(', ')}
${usedSummary}${rejectionNote}${ingredientNote}
AVAILABLE SCENE TEMPLATES (choose one that fits the post topic best):
${templateList}

${hasProductRef
  ? variantTitles.length > 1
    ? `PRODUCT REFERENCE IMAGES WILL BE PROVIDED showing ${variantTitles.length} different variants of the same product: ${variantTitles.map(t => t.split('—')[1]?.trim() || t).join(', ')}. This is a generic post — include however many variants make the scene look natural and well-composed (anywhere from 1 to all ${variantTitles.length}). Describe each included product exactly as it appears in the reference images, including the specific cap/lid type (e.g. flip-top cap, screw cap — NOT a pump dispenser unless the reference clearly shows one).`
    : `PRODUCT REFERENCE IMAGES WILL BE PROVIDED: The actual product bottle/packaging will be sent as reference images alongside this prompt. Your prompt MUST describe the product exactly as it appears in the reference — including the specific cap/lid type (e.g. flip-top cap, screw cap — NOT a pump dispenser unless the reference clearly shows one), label colors, and packaging design. Do NOT describe a "plain white bottle" or invent a different cap style.`
  : productDescription
  ? `No reference images available, but here is the exact product description to use: ${productDescription} Describe the product faithfully using these details — do not invent a different format or container type.`
  : `No product reference images are available. Describe a generic unlabeled product container appropriate to the post topic.`
}

TOPIC vs PRODUCT BALANCE (critical):
The hero image must visually communicate what the blog post is ABOUT. Consider the post title and keyword:
- If the topic IS the product (e.g. "Best Natural Deodorant"), the product is the hero and dominates the frame.
- If the topic is a PROBLEM, PROCESS, or CONCEPT (e.g. "How to Remove Sweat Stains", "Dry Brushing Skin", "When Was Deodorant Invented"), the image must show the TOPIC as the hero — the relevant scene, situation, or visual concept. The product may appear as a secondary element in the scene, but the viewer should immediately understand what the article is about from the image alone.
- Ask yourself: "If someone saw only this image as a thumbnail, would they know what the article is about?" If the answer is "they'd think it's about soap" but the article is about sweat stains, the prompt is wrong.

SCENE TEMPLATE vs REAL-WORLD SETTING:
First decide: does this blog topic happen in a specific real-world location? Think about where a reader would actually encounter this topic in their life.
- "Is Deodorant a Liquid for TSA?" → airport security checkpoint, TSA screening bins
- "How to Remove Sweat Stains" → laundry room, bathroom counter with stained clothing
- "Best Natural Deodorant" → product photography on a styled surface (use a template)
- "When Was Deodorant Invented?" → vintage/historical styled scene (no template)
- "Dry Brushing Skin" → spa-like bathroom setting with a dry brush

If the topic has a natural real-world setting, use SELECTED_TEMPLATE: NONE and describe that real-world environment instead of picking from the template list. Only use a template when the topic is product-focused or doesn't have a strong location association.

Respond in this EXACT format — first line is the template key (or NONE), second line onwards is the prompt:
SELECTED_TEMPLATE: [key or NONE]
[Photography type], ...

Write the prompt using this structure:
1. Start with the appropriate photography type: "Product photography, " for product-focused posts, "Lifestyle photography, " for scene-based images, "Editorial photography, " for concept/story posts
2. Describe the primary subject — this is the TOPIC of the article. For product-focused posts, the product is the hero. For problem/process/concept posts, show the real-world setting where this topic matters (e.g. airport security bin for TSA rules, laundry area for stain removal, bathroom vanity for skincare routine). The product should appear naturally within that setting as a secondary element.
3. Include 1-3 natural props that reinforce the topic AND the real-world setting
4. If using a template, describe the surface and background from it. If using NONE, describe the real-world environment in detail — the location, surfaces, objects, and atmosphere that make it immediately recognizable.
5. State the lighting (natural for real-world scenes, or from the template)
6. End with: "photorealistic, 35mm lens, shot on Canon R5, wide landscape crop filling the full frame edge to edge, no letterboxing, no borders."

BANNER COMPOSITION RULES:
- Compose the scene for a wide landscape banner format (approximately 3:1 width-to-height ratio). Place the key subject(s) in the center of the frame with space on the left and right. The image will be displayed at roughly 500px tall spanning a full-width website header — avoid placing subjects at the very top or bottom edge of the frame.

HARD RULES:
- The image must visually match the blog post topic — a reader should understand the article subject from the image alone
- The setting should be WHERE a reader would encounter this topic in real life
- Props must make real-world sense in the chosen setting — no random unrelated objects
- BRANDING RULE (critical): NEVER put our brand name ("Real", "Real Skin Care") on products we don't actually sell. Our brand should ONLY appear on products that match the reference images provided. Generic unbranded props (a jar of coconut oil, a bowl of charcoal powder, a bottle of essential oil) are perfectly fine as contextual scene elements — just don't put our logo or brand name on them. If the blog topic is about a product category we don't carry, show that category generically/unbranded.
- PRODUCT NAMING: When describing our products in the prompt, use ONLY the exact product names from the reference image titles above. Do NOT invent product names like "Organic Coconut Oil Body Lotion" or "Natural Healing Balm" — use the exact product name as provided (e.g. "Non-Toxic Body Lotion", "Moisturizing Coconut Soap"). If no product reference is provided, describe generic unbranded products only.
- Contextual scene elements are encouraged — make it look like a real place
- People are allowed when the topic benefits from showing human context (e.g. someone washing a tattoo, applying deodorant, doing laundry). Avoid close-up faces — show people from the shoulders down or in profile. For product-focused posts, people are optional.
- MODESTY RULES: Keep all images appropriate for a family-friendly ecommerce blog. No bare torsos, bare backs, bare shoulders, or any suggestion of nudity. For body care topics (dry brushing, hair masks, body lotion), show the product and tools in a styled setting WITHOUT showing bare skin beyond hands, forearms, and lower legs. A dry brush on a towel is better than a dry brush on a bare back.
- Use between 1 and 5 props — choose the number that makes the scene feel natural and balanced
- Every prop must be physically plausible in the chosen setting
- PRODUCT USAGE RULES: If a product is being actively USED in the scene (lathering, applying, squeezing), it must be shown UNWRAPPED and OUT OF ITS PACKAGING. Our bar soap comes in a pleated paper wrapper — if someone is lathering with it, the wrapper must be OFF and the bar should be a plain white/cream puck shape. An unused/display product can show the wrapper. Never show a wrapped product producing lather or foam.
- PRODUCT FORMAT RULES (strictly enforced): Our toothpaste comes in a 4oz pump bottle or jar — NEVER a tube. Our deodorant is a small white cylindrical rollerball bottle (~2oz/60ml) with a flat white snap-on cap — NOT a stick, push-up, or large translucent roll-on. Our lip balm comes in a standard lip balm tube (cylindrical twist-up or slide-up tube) — NOT a tin, pot, or jar. Our body lotion comes in a pump bottle. Our bar soap is a round white puck (~3.4oz) in a pleated paper wrapper — when being used/lathered it should be UNWRAPPED. If the post is about toothpaste, describe a bottle or jar — never say "tube", "squeeze tube", or "toothpaste tube".`,
    }],
  });

  const raw = message.content[0].text.trim();
  const keyMatch = raw.match(/^SELECTED_TEMPLATE:\s*(\S+)/m);
  const selectedKey = keyMatch?.[1] === 'NONE' ? null : (keyMatch?.[1] ?? null);
  const prompt = raw.replace(/^SELECTED_TEMPLATE:\s*\S+\n?/, '').trim();
  return { prompt, selectedKey };
}

// ── creative director review ──────────────────────────────────────────────────

async function creativeDirectorReview(imagePath, mediaType = 'image/png', allowProductLabel = false, productContext = null, referenceImagePaths = []) {
  // Resize to max 1280px wide as JPEG before sending to Claude (5MB API limit)
  const reviewBuf = await sharp(imagePath).resize(1280, null, { withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const base64 = reviewBuf.toString('base64');
  mediaType = 'image/jpeg';

  // Build content array: reference images first (if any), then generated image, then prompt
  const contentParts = [];

  // Add reference images for label comparison
  if (referenceImagePaths.length > 0) {
    for (const refPath of referenceImagePaths.slice(0, 2)) {
      try {
        const refBuf = await sharp(refPath).resize(800, null, { withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        contentParts.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: refBuf.toString('base64') },
        });
      } catch { /* skip unreadable reference */ }
    }
  }

  // Add the generated image being reviewed
  contentParts.push({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64 },
  });

  const hasRefs = contentParts.length > 1;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: [
        ...contentParts,
        {
          type: 'text',
          text: `You are a creative director reviewing a hero image for a natural skincare brand's blog. Your job is to reject images that look obviously AI-generated or physically wrong.
${hasRefs ? `
REFERENCE IMAGE COMPARISON:
The first image(s) above are REFERENCE PHOTOS of the actual product. The LAST image is the generated hero image being reviewed.
Compare the product label in the generated image against the reference photo(s). Check:
- Is the brand name text accurate? ("real SKIN CARE" or "Real Skin Care")
- Is the label layout correct? (text placement, font style, color scheme)
- Are the label details faithful to the reference? (ingredient callouts, weight/size text, imagery)
- If the label text is garbled, misspelled, has wrong words, or doesn't match the reference — REJECT.
AI image generators commonly hallucinate label text. Even small errors (wrong words, scrambled letters, missing text) mean the label is inaccurate and must be rejected.
` : ''}

IMPORTANT — EDITORIAL CONTEXT:
These images are hero images for blog posts. They are NOT product ads. The image should match the TOPIC of the blog post, which may include real-world settings like laundry rooms, airports, kitchens, bathrooms, etc. A stained shirt in a laundry room is perfectly appropriate for a "how to remove sweat stains" article. An airport security bin is appropriate for a TSA rules article. Do NOT reject images simply because the scene doesn't look like a typical product photography setup — judge whether the image looks realistic and high quality, not whether it fits a narrow "skincare brand aesthetic."

${allowProductLabel
  ? 'NOTE: This image intentionally includes the actual product with its label visible. A product label with readable text is EXPECTED and should NOT cause a rejection.'
  : ''}
TEXT RULES:
- REJECT for: AI-generated fake text/gibberish on products, floating text overlays, watermarks, obviously wrong brand names
- ACCEPT: real-world incidental environmental text (airport signs, TSA labels, store signage, bathroom product labels in background, street signs) — these are natural parts of real-world scenes and should NOT cause rejection
- ACCEPT: product labels that match the brand if product references were provided
- The key question is: "Is the text an AI artifact/error, or a natural part of the scene?"
${productContext ? `\nPRODUCT ACCURACY — check ALL of the following details carefully:\n${productContext}\nThis includes the cap/lid type, container shape, and any other packaging details mentioned. A pump dispenser is NOT the same as a flip-top cap. A tube is NOT the same as a bottle. Flag any mismatch — even subtle ones like the wrong lid type.` : ''}
Review this image and respond in this EXACT format (no extra lines):

PASS: yes or no
TEXT_VISIBLE: yes or no (is there problematic AI-generated fake text, gibberish, or wrong brand names? Incidental environmental signage in real-world scenes does NOT count.)
BLACK_BARS: yes or no (solid-colour bars/borders on any edge — letterboxing or pillarboxing?)
SURREAL: yes or no — CHECK CAREFULLY FOR THESE COMMON AI FAILURES:
  * ANATOMY: Count all visible hands, arms, fingers, legs. Does every limb belong to a plausible body? Extra or missing fingers? Too many arms? Limbs that connect to nothing?
  * PHYSICS: Is a wrapped/packaged product being used as if unwrapped? Specifically: is a bar soap still in its pleated paper wrapper but producing lather or being rubbed on skin? A wrapped soap CANNOT produce lather — this is an automatic rejection. Are objects floating? Is liquid defying gravity?
  * GEOMETRY: Impossible architecture, objects merging into each other, surfaces that don't connect properly?
  * LOGIC: Would this scene make sense in real life? (A bathroom counter or kitchen is fine — three-armed people or wrapped soap producing lather is not)
  * FAKE BRANDED PRODUCTS: Are there any products bearing the brand name/logo ("Real", "Real Skin Care") that were NOT in the reference images? Generic unbranded props are fine (a plain jar of coconut oil, a bowl of powder, an unlabeled bottle) — those are contextual scene elements. But if you see a product with our brand name/logo on it that doesn't match any reference image provided, that is a fake branded product and should be flagged as SURREAL.
LOOKS_AI: yes or no (does this obviously look AI-generated? unnatural textures, distorted objects, weird proportions, inconsistent lighting, surreal background elements?)
MODESTY: yes or no (is there excessive bare skin — bare backs, bare torsos, bare shoulders, or anything suggestive of nudity? Hands, forearms, and lower legs are fine. This is a family-friendly ecommerce blog — reject if the image is too revealing.)
WRONG_PRODUCT_FORMAT: yes or no${productContext ? ' (does the product shown match ALL packaging details above — container type, lid/cap type, shape? Mark yes if ANY detail is wrong)' : ' (n/a — write no)'}
LABEL_INACCURATE: ${hasRefs ? 'yes or no (compare the product label in the generated image against the reference photo — is the text wrong, garbled, misspelled, missing, or different from the reference? Even subtle errors count. If no product label is visible in the generated image, write no.)' : 'no (no reference provided)'}
SCENE_DESCRIPTION: one sentence describing the surface, props, and lighting (e.g. "White linen flat lay with coconut oil jar, mint sprigs, and soft diffused light")
REJECTION_REASON: if PASS is no, one specific sentence describing what is wrong (name the specific problem objects or issues). If PASS is yes, write "None."`,
        },
      ],
    }],
  });

  const raw = message.content[0].text.trim();
  const pass = /PASS:\s*yes/i.test(raw);
  const textVisible = /TEXT_VISIBLE:\s*yes/i.test(raw);
  const blackBars = /BLACK_BARS:\s*yes/i.test(raw);
  const surreal = /SURREAL:\s*yes/i.test(raw);
  const looksAi = /LOOKS_AI:\s*yes/i.test(raw);
  const wrongProductFormat = /WRONG_PRODUCT_FORMAT:\s*yes/i.test(raw);
  const labelInaccurate = /LABEL_INACCURATE:\s*yes/i.test(raw);
  const modesty = /MODESTY:\s*yes/i.test(raw);
  const sceneMatch = raw.match(/SCENE_DESCRIPTION:\s*(.+)/i);
  const rejectionMatch = raw.match(/REJECTION_REASON:\s*(.+)/i);

  const failures = [
    textVisible && 'text/logos visible',
    blackBars && 'black bars detected',
    surreal && 'physically impossible/surreal elements',
    looksAi && 'obviously AI-generated appearance',
    wrongProductFormat && 'wrong product format (e.g. tube instead of bottle)',
    labelInaccurate && 'product label does not match reference image',
    modesty && 'excessive bare skin/nudity',
  ].filter(Boolean);

  const rejectionReason = rejectionMatch?.[1]?.trim() ?? '';

  return {
    pass: pass && failures.length === 0,
    textVisible,
    blackBars,
    surreal,
    looksAi,
    failures,
    scene: sceneMatch?.[1]?.trim() ?? 'Unknown scene',
    rejectionReason: rejectionReason === 'None.' ? '' : rejectionReason,
  };
}

// ── generate image (with CD review + retry) ───────────────────────────────────

// Hard limit on Gemini regeneration attempts to prevent runaway API costs.
// Total generations = MAX_RETRIES + 1 (initial attempt + this many retries).
// If all attempts fail CD review, images are saved to data/images/rejected/{slug}/
// and the pipeline is blocked until manually resolved.
const MAX_RETRIES = 2; // 3 total attempts (initial + 2 retries)
const REJECTED_DIR = join(ROOT, 'data', 'images', 'rejected');

// ── WebP compression ──────────────────────────────────────────────────────────
//
// Target output: 1600px wide max (covers retina at full blog column width),
// WebP quality 75 (sharp default is fine for blog images).
// No KB target needed — resizing handles file size naturally.

const WEB_MAX_WIDTH = 1600;
const WEB_QUALITY   = 75;

async function compressToWebP(sourcePath) {
  const { statSync, renameSync: rename } = await import('fs');
  const isWebP = sourcePath.endsWith('.webp');
  const webpPath = sourcePath.replace(/\.(png|webp|jpg|jpeg)$/i, '.webp');
  const tmpPath  = webpPath + '.tmp.webp';
  const outPath  = isWebP ? tmpPath : webpPath;

  await sharp(sourcePath)
    .resize(WEB_MAX_WIDTH, null, { withoutEnlargement: true })
    .webp({ quality: WEB_QUALITY })
    .toFile(outPath);

  if (isWebP) rename(tmpPath, webpPath);

  const finalKB = Math.round(statSync(webpPath).size / 1024);
  return { webpPath, finalKB, quality: WEB_QUALITY };
}

// ── product reference images ───────────────────────────────────────────────────

async function syncProductImages() {
  mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });

  console.log('Fetching products from Shopify...');
  const products = await getProducts();
  console.log(`Found ${products.length} products`);

  const manifest = [];
  let downloaded = 0;

  for (const product of products) {
    if (!product.images || product.images.length === 0) continue;

    const productDir = join(PRODUCT_IMAGES_DIR, product.handle);
    mkdirSync(productDir, { recursive: true });

    for (let i = 0; i < product.images.length; i++) {
      const image = product.images[i];
      const ext = image.src.split('?')[0].split('.').pop() || 'jpg';
      const filename = `${i + 1}.${ext}`;
      const localPath = join(productDir, filename);

      if (!existsSync(localPath)) {
        try {
          const res = await fetch(image.src);
          const buf = Buffer.from(await res.arrayBuffer());
          writeFileSync(localPath, buf);
          downloaded++;
          console.log(`  Downloaded: ${product.handle}/${filename}`);
        } catch (err) {
          console.error(`  Failed: ${image.src} — ${err.message}`);
        }
      }
    }

    manifest.push({
      handle: product.handle,
      title: product.title,
      tags: product.tags ? product.tags.split(',').map((t) => t.trim().toLowerCase()) : [],
      imageDir: product.handle,
    });
  }

  writeFileSync(PRODUCT_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nSync complete. ${downloaded} new image(s) downloaded. ${manifest.length} products in manifest.`);
}

async function describeProducts() {
  if (!existsSync(PRODUCT_MANIFEST_PATH)) {
    console.error('No manifest found. Run --sync-products first.');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));
  console.log(`Describing ${manifest.length} product(s)...\n`);

  for (const product of manifest) {
    const imageDir = product.imageDir.includes('/')
      ? product.imageDir
      : join(PRODUCT_IMAGES_DIR, product.imageDir);

    const images = getImagesFromDir(imageDir);
    if (images.length === 0) {
      console.log(`  SKIP ${product.handle} — no images found`);
      continue;
    }

    process.stdout.write(`  ${product.handle} (${images.length} image(s))... `);

    // Build image content blocks (up to 6 images)
    const imageBlocks = [];
    for (const img of images.slice(0, 6)) {
      try {
        const buf = await sharp(img).resize(800, null, { withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
        });
      } catch { /* skip unreadable image */ }
    }

    if (imageBlocks.length === 0) {
      console.log('no readable images');
      continue;
    }

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `You are describing a product for an AI image generator that will include this product in lifestyle photography.

Product: "${product.title}"

Describe ONLY the physical product itself — not the background, setting, or props. Be precise and specific so an AI image generator can accurately recreate it. Cover:
1. Container format (bottle, jar, tin, stick, tube, etc.) and size
2. Shape and proportions
3. Color of the container/packaging
4. Label or cap details (color, style, any text style if visible)
5. Material/finish (glossy, matte, glass, plastic, etc.)

Keep it to 3-4 sentences. Focus entirely on what makes this product visually distinct and what format it comes in — so the generator never shows the wrong product type (e.g. never shows a tube when it should be a bottle).`,
          },
        ],
      }],
    });

    product.productDescription = message.content[0].text.trim();
    console.log('done');
    console.log(`    → ${product.productDescription.slice(0, 120)}...`);
  }

  writeFileSync(PRODUCT_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nDescriptions saved to manifest.');
}

function getImagesFromDir(dir) {
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXTS.has(e.name.split('.').pop().toLowerCase()))
    .map((e) => join(dir, e.name));
}

function findProductImagesForPost(meta) {
  if (!existsSync(PRODUCT_MANIFEST_PATH)) return [];

  const manifest = JSON.parse(readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));

  // Resolve imageDir — support both legacy absolute paths and new relative (handle) format
  const resolved = manifest.map((p) => ({
    ...p,
    imageDir: p.imageDir.includes('/') ? p.imageDir : join(PRODUCT_IMAGES_DIR, p.imageDir),
  }));

  // Build keyword set from post metadata (full phrases + individual words)
  const postText = [
    ...(meta.tags || []),
    meta.target_keyword || '',
    meta.title || '',
  ].join(' ').toLowerCase();

  const postKeywords = postText.split(/\s+/).filter((k) => k.length > 3);

  // Category-aware matching — map post topic to product category to prevent cross-category confusion
  const CATEGORY_SIGNALS = {
    deodorant: ['deodorant', 'antiperspirant', 'armpit', 'underarm', 'sweat'],
    bar_soap: ['bar soap', 'soap bar', 'castile soap', 'antibacterial soap', 'body soap'],
    toothpaste: ['toothpaste', 'fluoride', 'tooth', 'teeth', 'dental', 'brush teeth'],
    lip_balm: ['lip balm', 'lip care', 'chapstick', 'chapped lips'],
    lotion: ['body lotion', 'moisturizer', 'moisturiser', 'dry skin', 'body cream'],
    liquid_soap: ['hand soap', 'foaming soap', 'liquid soap'],
  };

  // Detect the post's primary product category
  let postCategory = null;
  for (const [cat, signals] of Object.entries(CATEGORY_SIGNALS)) {
    if (signals.some((s) => postText.includes(s))) {
      postCategory = cat;
      break;
    }
  }

  // Find which manifest handle maps to which category
  const categoryHandles = {};
  for (const [cat, cfg] of Object.entries(ingredientsConfig)) {
    if (cfg.shopify_handle) categoryHandles[cfg.shopify_handle] = cat;
  }

  // Score each product against post keywords
  const scored = resolved
    .filter((p) => existsSync(p.imageDir))
    .map((p) => {
      const productTerms = [p.handle.replace(/-/g, ' '), p.title.toLowerCase(), ...p.tags].join(' ');
      let score = postKeywords.filter((k) => productTerms.includes(k)).length;

      // If we detected a post category, boost matching products and penalize mismatches
      if (postCategory) {
        const productCategory = categoryHandles[p.handle] || null;
        if (productCategory === postCategory) {
          score += 10; // strong boost for correct category
        } else if (productCategory && productCategory !== postCategory) {
          score = 0; // eliminate wrong-category products entirely
        }
      }

      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  const best = scored[0];

  // Look for a variation match in ingredients config
  const productConfig = Object.values(ingredientsConfig).find(
    (p) => p.shopify_handle === best.handle
  );

  if (productConfig?.variations) {
    // Score each variation's keywords against post text
    const scoredVariations = productConfig.variations
      .map((v) => {
        const variationScore = v.keywords.filter((kw) => postText.includes(kw.toLowerCase())).length;
        const variationDir = join(best.imageDir, v.image_subdir);
        const images = getImagesFromDir(variationDir);
        return { ...v, variationScore, variationDir, images };
      })
      .filter((v) => v.images.length > 0);

    const matched = scoredVariations.filter((v) => v.variationScore > 0).sort((a, b) => b.variationScore - a.variationScore);

    if (matched.length > 0) {
      // Specific variation matched — use only that one
      const bestVariation = matched[0];
      console.log(`  Variation matched: ${bestVariation.name} (${bestVariation.images.length} image(s))`);
      return bestVariation.images.map((path) => ({ path, title: `${best.title} — ${bestVariation.name}`, productDescription: best.productDescription || null }));
    } else if (scoredVariations.length > 1) {
      // Generic post — include all variations so all flavors appear in the scene
      const allImages = scoredVariations.flatMap((v) =>
        v.images.slice(0, 2).map((path) => ({ path, title: `${best.title} — ${v.name}`, productDescription: best.productDescription || null }))
      );
      console.log(`  Generic post — including all ${scoredVariations.length} variation(s) (${allImages.length} image(s))`);
      return allImages;
    }
  }

  // No variations — use root images
  const images = getImagesFromDir(best.imageDir);
  if (images.length === 0) return [];
  return images.map((path) => ({ path, title: best.title, productDescription: best.productDescription || null }));
}

// ── generate image (with CD review + retry) ───────────────────────────────────

async function generateImage(metaPath) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const slug = meta.slug || basename(metaPath, '.json');

  console.log(`\n  Post: "${meta.title}"`);
  console.log(`  Keyword: ${meta.target_keyword}`);

  // Check for matching product reference images
  const productRefs = findProductImagesForPost(meta);
  const useProductRef = productRefs.length > 0;
  if (useProductRef) {
    console.log(`  Product reference: ${basename(productRefs[0].path)} (${productRefs[0].title})`);
  }

  // Detect unique variants — used to tell the prompt builder to show all bottles
  const uniqueVariantTitles = [...new Set(productRefs.map((r) => r.title))];
  const isMultiVariant = uniqueVariantTitles.length > 1;

  // Build product format context for CD review — prefer manifest description if available
  const kw = (meta.target_keyword || meta.title || '').toLowerCase();
  const manifestDescription = productRefs[0]?.productDescription || null;
  const productContext = manifestDescription
    ? `The product in this image should match this description: ${manifestDescription} Reject if the product format does not match (e.g. a tube when it should be a bottle).`
    : kw.includes('toothpaste')
    ? 'This post is about toothpaste. Our toothpaste comes in a 4oz bottle or jar — NEVER a squeeze tube. Reject if the image shows a toothpaste tube.'
    : kw.includes('deodorant')
    ? 'This post is about deodorant. Our deodorant comes in a roll-on bottle format. Reject if a stick, spray, or any other format is shown.'
    : kw.includes('lip balm')
    ? 'This post is about lip balm. Our lip balm comes in a standard lip balm tube (cylindrical twist-up or slide-up tube). Reject if a tin, pot, jar, or any non-tube format is shown.'
    : kw.includes('lotion') || kw.includes('body lotion') || kw.includes('moisturizer')
    ? 'This post is about body lotion. Our lotion comes in a pump bottle — not a tube. Reject if a tube is shown.'
    : null;

  // Extract actual product ingredients to constrain prop choices
  const productIngredients = (() => {
    if (!existsSync(join(ROOT, 'config', 'ingredients.json'))) return [];
    const allProducts = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
    const postText = [meta.target_keyword || '', meta.title || '', ...(meta.tags || [])].join(' ').toLowerCase();
    // Score each product by keyword overlap — pick best match, not first match
    const scored = Object.values(allProducts)
      .filter((p) => p.shopify_handle)
      .map((p) => {
        const productTerms = [p.shopify_handle.replace(/-/g, ' '), (p.name || '').toLowerCase()].join(' ');
        const words = postText.split(/\s+/).filter((w) => w.length > 3);
        const score = words.filter((w) => productTerms.includes(w)).length;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { p: product } of scored) {
      if (!product.shopify_handle) continue;
      // Matched product — collect base + best matching variation ingredients
      const base = product.base_ingredients || [];
      let varIngredients = [];
      if (product.variations) {
        const scored = product.variations.map((v) => ({
          v,
          score: (v.keywords || []).filter((k) => postText.includes(k.toLowerCase())).length,
        })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
        if (scored.length > 0) varIngredients = scored[0].v.essential_oils || [];
      }
      return [...base, ...varIngredients];
    }
    return [];
  })();
  if (productIngredients.length > 0) {
    console.log(`  Ingredients: ${productIngredients.slice(0, 4).join(', ')}${productIngredients.length > 4 ? '…' : ''}`);
  }

  const sceneLog = loadSceneLog();
  const usedScenes = sceneLog.map((e) => e.scene);
  // Hard-exclude template keys used in the last 8 posts to force surface variety
  const usedTemplateKeys = sceneLog.slice(-8).map((e) => e.templateKey).filter(Boolean);

  let attempt = 0;
  let approved = false;
  let finalPrompt = '';
  let finalTemplateKey = null;
  let lastRejectionNote = ''; // passed back into the next prompt on retry
  let lastImagePath = '';     // path of the last generated image file
  let lastImageMimeType = 'image/png';
  const rejectedImages = [];  // track all rejected attempts for manual review

  while (attempt <= MAX_RETRIES && !approved) {
    if (attempt > 0) {
      console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);
    }

    process.stdout.write('  Generating image prompt with Claude... ');
    const allUsedScenes = [...usedScenes, ...sceneLog.filter((_, i) => i >= usedScenes.length).map((e) => e.scene)];
    const { prompt, selectedKey } = await buildImagePrompt(meta, allUsedScenes, usedTemplateKeys, lastRejectionNote, useProductRef, productIngredients, manifestDescription, uniqueVariantTitles);
    console.log('done');
    if (selectedKey) console.log(`  Template: ${selectedKey}`);
    console.log(`  Prompt: ${prompt.slice(0, 150)}...`);

    mkdirSync(IMAGES_DIR, { recursive: true });

    let imageData;
    let imageMimeType = 'image/png';
    let generatorUsed = 'unknown';

    // Try Gemini first; fall back to DALL-E 3 if quota/billing not yet active
    let geminiOk = false;
    if (gemini) {
      try {
        const geminiContents = [{ text: prompt }];

        if (useProductRef) {
          process.stdout.write(`  Generating image with Gemini (${productRefs.length} product reference(s))... `);
          for (const ref of productRefs.slice(0, 14)) {
            const refExt = ref.path.split('.').pop().toLowerCase();
            const refMime = refExt === 'png' ? 'image/png' : refExt === 'webp' ? 'image/webp' : 'image/jpeg';
            const refData = readFileSync(ref.path).toString('base64');
            geminiContents.push({ inlineData: { mimeType: refMime, data: refData } });
          }
          geminiContents[0].text = `${prompt}\n\nThe provided reference image(s) show the actual product from multiple angles. Include this exact product in the scene, rendered faithfully.`;
        } else {
          process.stdout.write('  Generating image with Gemini... ');
        }

        const geminiResponse = await gemini.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: geminiContents,
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
          },
        });

        const imagePart = geminiResponse.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
        if (imagePart) {
          imageData = imagePart.inlineData.data;
          imageMimeType = imagePart.inlineData.mimeType || 'image/png';
          generatorUsed = 'gemini';
          geminiOk = true;
          console.log('done');
        } else {
          console.log('no image returned — falling back to DALL-E 3');
        }
      } catch (err) {
        const isQuota = err.message?.includes('free_tier') || err.message?.includes('quota') || err.status === 429;
        console.log(isQuota ? 'quota/billing not active — falling back to DALL-E 3' : `error: ${err.message} — falling back to DALL-E 3`);
      }
    }

    if (!geminiOk) {
      if (!openai) {
        console.error('  No image generator available (Gemini quota exceeded, no OPENAI_API_KEY).');
        attempt++;
        continue;
      }
      process.stdout.write('  Generating image with DALL-E 3... ');
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        size: '1792x1024',
        quality: 'standard',
        response_format: 'b64_json',
        n: 1,
      });
      imageData = response.data[0].b64_json;
      imageMimeType = 'image/png';
      generatorUsed = 'dall-e-3';
      console.log('done');
    }

    const imageExt = imageMimeType === 'image/jpeg' ? 'jpg' : 'png';
    const imagePath = join(IMAGES_DIR, `${slug}.${imageExt}`);
    console.log(`  Generator: ${generatorUsed}`);

    console.log('done');
    writeFileSync(imagePath, Buffer.from(imageData, 'base64'));

    // Verify landscape orientation
    const { width, height } = await getImageDimensions(imagePath);
    if (width <= height) {
      console.log(`  ⚠ Not landscape: got ${width}×${height}`);
      lastRejectionNote = `Image is not landscape: ${width}×${height}.`;
      try { unlinkSync(imagePath); } catch { /* ignore */ }
      attempt++;
      continue;
    }
    console.log(`  Dimensions: ${width}×${height} ✓`);

    lastImagePath = imagePath;
    lastImageMimeType = imageMimeType;

    // Creative director review — pass reference images for label comparison
    process.stdout.write('  Creative director review... ');
    const reviewContext = productContext;
    const refPaths = productRefs.map(r => r.path);
    const review = await creativeDirectorReview(imagePath, imageMimeType, useProductRef, reviewContext, refPaths);
    if (review.pass) {
      console.log('approved');
    } else {
      const failList = review.failures.join(', ');
      console.log(`REJECTED — ${failList}`);
      if (review.rejectionReason) console.log(`  Reason: ${review.rejectionReason}`);
    }

    finalPrompt = prompt;
    finalTemplateKey = selectedKey;

    if (review.pass) {
      approved = true;
      sceneLog.push({ slug, scene: review.scene, templateKey: selectedKey, prompt: prompt.slice(0, 200) });
      saveSceneLog(sceneLog);
      console.log(`  Scene logged: "${review.scene}"`);
    } else {
      // Save rejected image for manual review
      const rejSlugDir = join(REJECTED_DIR, slug);
      mkdirSync(rejSlugDir, { recursive: true });
      const rejFilename = `attempt-${attempt + 1}.webp`;
      const rejPath = join(rejSlugDir, rejFilename);
      try {
        await sharp(imagePath).resize(1280, null, { withoutEnlargement: true }).webp({ quality: 80 }).toFile(rejPath);
        rejectedImages.push({
          path: rejPath,
          attempt: attempt + 1,
          failures: review.failures,
          reason: review.rejectionReason,
          scene: review.scene,
        });
        console.log(`  Saved rejected image: ${rejPath}`);
      } catch { /* ignore save failure */ }

      // Feed specific rejection reason back into next prompt so Claude can avoid those elements
      lastRejectionNote = review.rejectionReason || review.failures.join('; ');
      usedScenes.push(review.scene);
      if (selectedKey) usedTemplateKeys.push(selectedKey); // also block this template on retry
      attempt++;
    }
  }

  if (!approved) {
    // Hard gate: do NOT save rejected image as the post image. Block the pipeline.
    console.error(`  ✗ Image failed creative director review after ${MAX_RETRIES + 1} attempts.`);
    console.error(`  ${rejectedImages.length} rejected image(s) saved to data/images/rejected/${slug}/`);
    console.error('  Pipeline blocked — resolve via dashboard or re-run image generator.');

    // Write rejection record for dashboard and daily summary
    const rejectionRecord = {
      slug,
      title: meta.title,
      keyword: meta.target_keyword || slug,
      attempts: rejectedImages.length,
      rejected_at: new Date().toISOString(),
      images: rejectedImages.map((r) => ({
        path: r.path,
        attempt: r.attempt,
        failures: r.failures,
        reason: r.reason,
      })),
    };
    const rejRecordPath = join(REJECTED_DIR, slug, 'rejection.json');
    writeFileSync(rejRecordPath, JSON.stringify(rejectionRecord, null, 2));

    // Stamp post metadata so the pipeline knows the image is blocked
    meta.image_blocked = true;
    meta.image_blocked_at = new Date().toISOString();
    meta.image_blocked_reason = `CD rejected ${rejectedImages.length} attempt(s): ${rejectedImages.map(r => r.failures.join(', ')).join('; ')}`;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    sceneLog.push({ slug, scene: 'unknown (not approved)', templateKey: finalTemplateKey, prompt: finalPrompt.slice(0, 200) });
    saveSceneLog(sceneLog);

    await notify({
      subject: `Image blocked: ${meta.title}`,
      body: `Creative director rejected ${rejectedImages.length} attempt(s) for "${meta.title}".\nReasons: ${rejectedImages.map(r => r.reason || r.failures.join(', ')).join('; ')}\nResolve on the dashboard or re-run: node agents/image-generator/index.js data/posts/${slug}/meta.json`,
      status: 'error',
      category: 'pipeline',
    }).catch(() => {});

    // Return null to signal failure — pipeline should stop
    return null;
  }

  if (!lastImagePath) {
    console.error('  Error: no image was generated.');
    return null;
  }

  // Clean up rejected images directory on success (approved image wins)
  const rejSlugDir = join(REJECTED_DIR, slug);
  if (existsSync(rejSlugDir)) {
    try {
      for (const f of readdirSync(rejSlugDir)) unlinkSync(join(rejSlugDir, f));
      rmdirSync(rejSlugDir);
    } catch { /* ignore */ }
  }

  // Clear any previous image_blocked flag
  if (meta.image_blocked) {
    delete meta.image_blocked;
    delete meta.image_blocked_at;
    delete meta.image_blocked_reason;
  }

  // Compress to WebP
  process.stdout.write('  Compressing to WebP... ');
  const { webpPath: tempWebpPath, finalKB, quality } = await compressToWebP(lastImagePath);
  console.log(`done (${finalKB} KB, quality ${quality})`);

  // Remove the original source image if it isn't already a WebP
  if (!lastImagePath.endsWith('.webp')) {
    try { unlinkSync(lastImagePath); } catch { /* ignore */ }
  }

  // Move compressed image into the post directory
  ensurePostDir(slug);
  const finalImagePath = getImagePath(slug);
  const { renameSync } = await import('fs');
  renameSync(tempWebpPath, finalImagePath);

  // Update post metadata — store relative path so it works across machines
  meta.image_path = relative(ROOT, finalImagePath).replace(/\\/g, '/');
  meta.image_prompt = finalPrompt;
  meta.image_generated_at = new Date().toISOString();
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`  Saved:  ${finalImagePath}`);

  return { imagePath: finalImagePath, slug };
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

async function main() {
  console.log(`\nImage Generator Agent — ${config.name}\n`);

  if (args[0] === '--sync-products') {
    await syncProductImages();
    return;
  } else if (args[0] === '--describe-products') {
    await describeProducts();
    return;
  } else if (args[0] === '--compress-existing') {
    // Convert PNGs to WebP, and re-compress any WebPs that are still over 150KB
    if (!existsSync(IMAGES_DIR)) { console.error('No images directory found.'); process.exit(1); }
    const { statSync } = await import('fs');
    const toProcess = readdirSync(IMAGES_DIR)
      .filter((f) => !f.startsWith('_') && !f.endsWith('.json'))
      .filter((f) => {
        if (f.endsWith('.png')) return true;
        // Re-process WebPs that are either oversized in dimensions or over 400KB
        if (f.endsWith('.webp') && Math.round(statSync(join(IMAGES_DIR, f)).size / 1024) > 400) return true;
        return false;
      });

    if (toProcess.length === 0) { console.log('All images are already WebP and correctly sized.'); return; }
    console.log(`Processing ${toProcess.length} image(s)...\n`);

    for (const f of toProcess) {
      const srcPath = join(IMAGES_DIR, f);
      const slug = f.replace(/\.(png|webp)$/, '');
      process.stdout.write(`  ${f} → `);
      const { webpPath, finalKB, quality } = await compressToWebP(srcPath);
      console.log(`${basename(webpPath)} (${finalKB} KB, q${quality})`);
      if (f.endsWith('.png')) unlinkSync(srcPath);

      // Update matching post metadata image_path
      const metaPath = getMetaPath(slug);
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          meta.image_path = relative(ROOT, webpPath).replace(/\\/g, '/');
          writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        } catch { /* ignore */ }
      }
    }
    console.log('\nDone.');
    return;
  } else if (args[0] === '--all') {
    if (!existsSync(POSTS_DIR)) {
      console.error('No posts found. Run blog-post-writer first.');
      process.exit(1);
    }

    const allSlugs = listAllSlugs();
    const metaFiles = allSlugs.map((s) => getMetaPath(s));

    const toGenerate = metaFiles.filter((f) => {
      const slug = basename(dirname(f));
      if (existsSync(getImagePath(slug))) return false;
      try {
        const meta = JSON.parse(readFileSync(f, 'utf8'));
        // Skip legacy posts (synced from Shopify — already have CDN images)
        if (meta.legacy_source) return false;
        // Skip posts that already have their image uploaded to Shopify CDN
        if (meta.shopify_image_url) return false;
      } catch { /* include if unreadable */ }
      return true;
    });

    console.log(`${metaFiles.length} post(s) found, ${toGenerate.length} need images.\n`);

    for (const metaPath of toGenerate) {
      await generateImage(metaPath);
    }
  } else if (args[0]) {
    const metaPath = args[0].startsWith('/') ? args[0] : join(ROOT, args[0]);
    if (!existsSync(metaPath)) {
      console.error(`Post metadata not found: ${metaPath}`);
      process.exit(1);
    }
    await generateImage(metaPath);
  } else {
    console.error('Usage:');
    console.error('  node agents/image-generator/index.js data/posts/<slug>.json');
    console.error('  node agents/image-generator/index.js --all');
    console.error('  node agents/image-generator/index.js --sync-products');
    console.error('  node agents/image-generator/index.js --compress-existing');
    process.exit(1);
  }

  console.log('\nImage generation complete.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
