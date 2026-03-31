# Creatives Tab — Design Spec

## Overview

A new "Creatives" tab in the dashboard for generating ad creatives using text-to-image prompts with product image references. Replaces the current ad-specific creative generation flow with a standalone, iterative creative studio. The "Ad Intelligence" and "Optimize" tabs are disabled for now.

## Architecture

**Dashboard-native approach.** Single-image generation and refinement calls go directly from the dashboard server to the Gemini API — no agent subprocess overhead. The existing `creative-packager` agent is invoked only for the final "Package" step (multi-placement sizing into Instagram/Facebook formats).

**Why:** This is an iterative workflow where the user generates, reviews, refines, and regenerates rapidly. Spawning agent subprocesses per generation adds 5-10s of unnecessary latency.

## Tab Changes

- Add a **"Creatives"** tab pill after the CRO tab
- **Disable** the "Ad Intelligence" and "Optimize" tab pills (hidden or grayed out with tooltip "Coming soon")
- The existing creative generation code tied to Ad Intelligence (the per-ad "Generate Creative" button, `openCreativeGenerator()`, `/api/generate-creative`) remains in the codebase but is not accessible while the tab is disabled

## Layout

Two-panel layout within the Creatives tab:

### Top Bar

- **Model selector** — dropdown listing available Gemini model variants (e.g. `gemini-3.1-flash-image-preview`, `gemini-2.0-flash-exp`). Switching models updates the reference image limit counter.
- **Template selector** — dropdown listing all templates from `data/creative-templates/` plus a "Blank" option. Selecting a template populates the prompt (and negative prompt if defined in the template).
- **Manage Templates** button — opens the template management modal.
- **Session selector** — dropdown showing "Current Session" plus previous sessions sorted by date. Each entry shows date and auto-generated name (e.g. "Mar 29 — Coconut Deo Lifestyle"). Session names are auto-generated from the first prompt but can be edited by the user.
- **Auto-save indicator** — green dot + "saved" text. Session state auto-persists through page reloads and tab switches.

### Left Panel (Input)

1. **Prompt textarea** — free-text area for the image generation prompt. When a template is selected, pre-populated with the template's prompt text (editable). When multiple products are selected, a collapsible "Product context" section appears above the prompt listing each product with its visual description from `manifest.json`. The user can edit descriptions and arrangement instructions.

2. **Negative prompt field** — red-tinted textarea below the main prompt for exclusions (e.g. "text, watermarks, logos, blurry, low quality"). Passed to Gemini as a negative prompt.

3. **Aspect ratio selector** — toggle row of presets: `1:1`, `4:5`, `9:16`, `16:9`, `Custom`. Selected ratio determines the output image dimensions. Default: `1:1`. Selecting "Custom" reveals two numeric inputs for width and height in pixels (e.g. `1200 × 800`).

4. **Reference images area** — displays selected reference images with a counter showing current count vs. model-specific maximum (e.g. "2 / 16 max").
   - **Product images** (purple border) — selected from the product image library via a picker modal
   - **Uploaded references** (green border) — added via drag-and-drop or file browser
   - Each image has an × button to remove it
   - **"+ Product" button** — opens the product image library modal (reads from `data/product-images/manifest.json`, shows product thumbnails grouped by product handle)
   - **"+ Upload" button** — opens file picker or accepts drag-and-drop. After upload, a "Save to library" checkbox/button allows persisting the image to `data/reference-images/` for reuse in future sessions
   - When the model's reference image limit is reached, both add buttons are disabled with a tooltip explaining the cap
   - When switching to a model with a lower limit, a warning is shown and the user chooses which references to remove

5. **Generate button** — "Generate Image" with gradient styling. Sends the prompt, negative prompt, aspect ratio, selected model, and reference images to the server.

### Right Panel (Output)

1. **Generated image display** — shows the current/latest generated image. Scales to fit the panel while maintaining the selected aspect ratio. When no image has been generated yet, shows a placeholder. Includes a **download button** to save the individual image to disk.

2. **Compare button** — top-right corner of the image area. Enters compare mode (see below).

3. **Refinement input** — text input + "Refine" button below the image. User types adjustment instructions (e.g. "make the background warmer", "zoom in on the product"). Sends the current image + refinement text to Gemini for a new iteration.

4. **History filmstrip** — horizontal scrollable row of thumbnail versions, newest on the left. Each thumbnail shows the version number.
   - Click a thumbnail to view that version in the main display
   - Click the star icon to pin/unpin as a **favorite** (gold border + star icon). Favorites remain easily accessible regardless of how many iterations follow.
   - The currently displayed version has a purple highlight border

5. **Package button** — "Package for All Placements" at the bottom. Takes the currently displayed image and invokes the `creative-packager` agent to generate all placement sizes (Instagram feed square, Instagram feed portrait, Instagram Stories, Facebook feed landscape, Facebook feed square, Facebook stories). Returns a downloadable ZIP.

### Compare Mode

Activated by clicking the "Compare" button or by selecting two versions in the filmstrip:

- Replaces the single image display with a side-by-side split view
- Each side shows the image, the prompt that generated it, and a "Use This Version" button
- "Exit Compare" button returns to single-image view
- Selecting "Use This Version" sets that version as the current working image for further refinement

## Loading & Error States

- **Generation in progress:** Spinner overlay on the image area with a status message: "Generating with [model name]..."
- **Refinement in progress:** Same spinner with "Refining..."
- **Packaging in progress:** Spinner on the Package button area with "Packaging [N] placements..."
- **Gemini content policy rejection:** Inline error message below the image area showing the rejection reason from Gemini, with guidance: "Try adjusting your prompt to avoid [flagged content]." The prompt area remains editable so the user can tweak and retry immediately.
- **Network/API errors:** Generic error message with a "Retry" button

## Template System

### Storage

Templates are stored as individual JSON files in `data/creative-templates/`:

```json
{
  "id": "lifestyle-scene",
  "name": "Lifestyle Scene",
  "description": "Product in a natural, everyday setting with warm lighting",
  "prompt": "A person using {{product}} in a bright, airy {{setting}}. Natural morning light streaming through a window. Clean, minimal aesthetic. Product prominently displayed.",
  "negativePrompt": "text, watermarks, logos, blurry, artificial lighting",
  "tags": ["lifestyle", "natural", "warm"],
  "defaultAspectRatio": "4:5",
  "defaultModel": "gemini-3.1-flash-image-preview",
  "source": "manual",
  "previewImage": null,
  "createdAt": "2026-03-30T10:00:00Z",
  "updatedAt": "2026-03-30T10:00:00Z"
}
```

For AI-generated templates, `source` is `"ai"` and `previewImage` points to the reference image file path in `data/creative-templates/previews/`.

### Manage Templates Modal

Opened via the "Manage" button in the top bar. Contains:

- **Template list** — each template shown as a card with: name, description, prompt preview (truncated), source badge ("manual" in purple, "AI-generated" in orange), and reference image thumbnail (for AI-generated templates)
- **Edit button** — opens inline editing of all template fields
- **Delete button** — with confirmation
- **"+ New Template" button** — opens a blank form to create a template manually (name, description, prompt, negative prompt, tags, default aspect ratio, default model)
- **"Create from Image" button** — opens the AI-powered template creation flow

### Create from Image Flow

1. User clicks "Create from Image" in the Manage Templates modal
2. A two-panel sub-modal opens:
   - **Left:** drag-and-drop zone for the reference image
   - **Right:** empty form fields (name, description, prompt, negative prompt, tags)
3. User uploads an image and clicks "Analyze Image"
4. Dashboard sends the image to Claude Vision (via Anthropic API) with a system prompt instructing it to analyze composition, lighting, color palette, mood, subject positioning, and style
5. Claude returns a structured analysis that populates all form fields:
   - **Name:** derived from the dominant style/technique
   - **Description:** one-line summary
   - **Prompt:** detailed text-to-image prompt with `{{product}}` placeholders that would reproduce the style
   - **Negative prompt:** things to avoid based on what's not in the image
   - **Tags:** style/technique keywords
6. User reviews and edits all fields before saving
7. The original reference image is saved to `data/creative-templates/previews/` as a visual preview of what inspired the template

### Starter Templates

The following templates are created at initial setup:

1. **Lifestyle Scene** — product in a natural everyday setting, warm lighting, human interaction
2. **Product Hero** — single product on clean background, studio lighting, premium feel
3. **Flat Lay** — top-down arrangement of product(s) with complementary props on a textured surface
4. **Seasonal Promo** — festive/seasonal themed with holiday-appropriate decorative elements
5. **Before & After** — split composition showing transformation or comparison
6. **Ingredient Spotlight** — product surrounded by its natural/key ingredients, earthy tones
7. **Minimalist** — extreme simplicity, generous negative space, single product, monochrome or muted palette

## Multi-Product Prompts

When multiple product images are selected as references:

- A collapsible **"Product Context"** section appears above the main prompt textarea
- Lists each selected product with its title and visual description (from `manifest.json`'s `productDescription` field)
- Each product entry is editable — the user can adjust descriptions or add arrangement instructions
- The product context is prepended to the prompt when sent to Gemini, structured as:

```
Products in this image:
1. [Title] — [visual description]. Position: [user-specified or "auto"]
2. [Title] — [visual description]. Position: [user-specified or "auto"]

Scene description:
[main prompt text]
```

- Template placeholders like `{{product}}` are auto-filled with the concatenated product names when a single product is selected, or replaced with the full product context block for multi-product selections

## Session Persistence

### Session Data Structure

Sessions are stored as JSON files in `data/creative-sessions/`:

```json
{
  "id": "session-abc123",
  "name": "Coconut Deo Lifestyle",
  "nameAutoGenerated": true,
  "createdAt": "2026-03-30T10:00:00Z",
  "updatedAt": "2026-03-30T10:30:00Z",
  "model": "gemini-3.1-flash-image-preview",
  "templateId": "lifestyle-scene",
  "prompt": "A woman applying...",
  "negativePrompt": "text, watermarks...",
  "aspectRatio": "1:1",
  "referenceImages": [
    { "type": "product", "handle": "coconut-oil-deodorant", "path": "coconut-oil-deodorant/main.webp" },
    { "type": "uploaded", "path": "data/reference-images/ref-abc.webp", "saved": true }
  ],
  "versions": [
    {
      "version": 1,
      "imagePath": "data/creatives/session-abc123/v1.webp",
      "prompt": "A woman applying...",
      "negativePrompt": "text, watermarks...",
      "refinement": null,
      "favorited": false,
      "timestamp": "2026-03-30T10:05:00Z"
    },
    {
      "version": 2,
      "imagePath": "data/creatives/session-abc123/v2.webp",
      "prompt": "A woman applying...",
      "negativePrompt": "text, watermarks...",
      "refinement": "make the background warmer",
      "favorited": true,
      "timestamp": "2026-03-30T10:08:00Z"
    }
  ]
}
```

### Auto-Save Behavior

- Session state is saved to disk after every meaningful action: generate, refine, change prompt, add/remove reference images, favorite/unfavorite, rename session
- On page load, the most recent session is restored automatically
- The session selector dropdown lists all sessions from `data/creative-sessions/`, sorted by `updatedAt` descending
- Loading a previous session restores: prompt, negative prompt, model, aspect ratio, reference images, and full version history with images

### Session Naming

- Auto-generated from the first prompt: Claude (via API) generates a short 3-5 word summary of the prompt (e.g. "Coconut Deo Lifestyle Scene")
- Displayed in the session dropdown and editable — clicking the session name in the top bar allows inline renaming
- The `nameAutoGenerated` flag tracks whether the user has manually renamed it

## API Endpoints

All new endpoints are prefixed with `/api/creatives/`.

### Image Generation

| Endpoint | Method | Content-Type | Request | Response |
|---|---|---|---|---|
| `/api/creatives/generate` | POST | `multipart/form-data` | `prompt`, `negativePrompt`, `model`, `aspectRatio`, `sessionId`, reference image files | `{ imagePath, version, sessionId }` |
| `/api/creatives/refine` | POST | `application/json` | `{ sessionId, version, refinement, model }` | `{ imagePath, version }` |
| `/api/creatives/image/*` | GET | — | — | Serves image file from disk |

### Packaging

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/creatives/package` | POST | `{ sessionId, version, placements }` | `{ jobId }` |
| `/api/creatives/package/:jobId` | GET | — | `{ status, downloadUrl?, error? }` |
| `/api/creatives/package/download/:jobId` | GET | — | ZIP file download |

### Templates

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/creatives/templates` | GET | — | `[{ template objects }]` |
| `/api/creatives/templates` | POST | JSON or `multipart/form-data` (for new template with preview image) | `{ template }` |
| `/api/creatives/templates/:id` | PUT | JSON | `{ template }` |
| `/api/creatives/templates/:id` | DELETE | — | `{ ok }` |
| `/api/creatives/templates/from-image` | POST | `multipart/form-data`: image file | `{ template (unsaved), previewPath }` |

### Sessions

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/creatives/sessions` | GET | — | `[{ id, name, updatedAt, versionCount }]` |
| `/api/creatives/sessions/:id` | GET | — | Full session object |
| `/api/creatives/sessions/:id` | PUT | JSON (name, favorited versions, etc.) | `{ session }` |

### Reference & Product Images

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/creatives/product-images` | GET | — | Product manifest with image paths |
| `/api/creatives/reference-images` | GET | — | List of saved reference images |
| `/api/creatives/reference-images` | POST | `multipart/form-data` | `{ path, filename }` |

### Models

| Endpoint | Method | Response |
|---|---|---|
| `/api/creatives/models` | GET | `[{ id, name, maxReferenceImages }]` |

## File System

| Path | Purpose |
|---|---|
| `data/creative-templates/` | Template JSON files |
| `data/creative-templates/previews/` | Reference images for AI-generated templates |
| `data/creative-sessions/` | Session JSON files |
| `data/creatives/` | Generated images, organized by session ID subdirectories |
| `data/reference-images/` | User-saved reference images for reuse |
| `data/creative-packages/` | Packaged ZIP outputs (already exists) |

## Image Handling

- **Browser to server:** `multipart/form-data` for all image uploads (reference images, template source images). No base64 over the wire.
- **Server to Gemini:** Read image from disk, send as inline data to Gemini API.
- **Gemini to server:** Receive generated image, save to `data/creatives/{sessionId}/v{N}.webp`.
- **Server to browser:** Return the file path in JSON. Browser loads via `<img src="/api/creatives/image/{path}">`.
- **Individual download:** Download button on the current image triggers a direct file download via the image serving endpoint with a `Content-Disposition: attachment` header.

## Model Configuration

Available Gemini models and their limits are defined in a config object in the dashboard server code:

```javascript
const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-image-preview', name: 'Gemini 3.1 Flash (Preview)', maxReferenceImages: 16 },
  { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Exp)', maxReferenceImages: 10 },
];
```

This config is served via `/api/creatives/models` and can be extended as new models become available without UI changes.

## Dependencies

- **`@google/generative-ai`** — Gemini SDK (may already be a dependency via the image-generator agent; if so, reuse it in the dashboard server)
- **`multer`** — multipart form data parsing for file uploads in Express (or equivalent middleware)
- **`archiver`** — ZIP creation for packaging (already used by creative-packager)
- **Anthropic SDK** — already a project dependency, used for Claude Vision in the "Create from Image" template flow and for auto-generating session names
