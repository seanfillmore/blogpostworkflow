# Sensitive Skin Set Lander — Image Manifest

**Template:** `realskincare-theme/templates/product.landing-page-sensitive-skin-set-lander.json`
**Branch:** `feat/sensitive-skin-set-lander` @ `83b3465`
**Purpose:** Every image the lander needs, grouped by section, with target dimensions, ready-to-use alt text, format guidance, and copy-pasteable AI generation / photo briefing prompts.

## Visual System (apply to every shot)

- **Palette anchors:** `#eef3e8` (sage green), `#faf7f0` (warm cream), `#1a1b18` (near-black), `#FFB503` (yellow accent), `#4a8b3c` (deep green).
- **Lighting:** Soft, natural daylight — north-facing window quality. No hard studio strobes, no obvious ring-light catchlights.
- **Tone:** Editorial, calm, aspirational for hero / CTA / brand shots. UGC-casual realism for testimonial cards.
- **Privacy rule:** No model faces anywhere on the lander. Hands, forearms, and over-the-shoulder framing are fine. UGC shots especially must obey this.
- **Brand hygiene:** No competitor product, no competitor branding, no logos other than RSC's own. No visible bottle of Cetaphil / Aveeno / CeraVe / Eucerin / etc., even out of focus.
- **The two products:**
  - **Pure Unscented Body Lotion** — clear bottle with white opaque liquid, pump dispenser.
  - **Pure Unscented Body Cream** — squat glass jar, contents are a soft pale cream with a faint warm peach / red-orange tint from unrefined red palm oil. (Important — do NOT render the cream as pure white. It reads creamy off-white with a hint of warm orange.)

---

## Hero — `hero` (`hero-landing-section`)

### `bg_image_desktop`
- **Setting:** `bg_image_desktop`
- **Dimensions:** 2400 × 1200 (2:1, desktop full-bleed; allow safe zone on left for text)
- **Format:** WebP (JPG fallback acceptable)
- **Alt text:** `Pure Unscented Body Lotion bottle and Pure Unscented Body Cream jar on a sage-green surface in soft daylight`
- **Generation prompt:**
  > Editorial product photo, soft natural daylight from upper right, gentle long shadows. A clear pump bottle of body lotion with white opaque liquid (label minimal cream-colored) sits beside a squat glass jar of body cream — the cream inside is creamy off-white with a subtle warm peach / red-orange tint, lid off and angled slightly. Both products are right-of-center on a smooth sage-green (#eef3e8) surface that fades to warm cream (#faf7f0) on the right. Clean negative space on the LEFT half of the frame for headline overlay. Minimalist, calm, premium-but-approachable. Shallow depth of field. No competitor branding, no faces, no clutter. 2:1 aspect. Photo-real.

### `bg_image_mobile`
- **Setting:** `bg_image_mobile`
- **Dimensions:** 750 × 1000 (3:4 portrait, mobile)
- **Format:** WebP (JPG fallback acceptable)
- **Alt text:** `Pure Unscented Body Lotion and Body Cream on a sage-green surface, soft daylight`
- **Generation prompt:**
  > Same products and palette as desktop hero, recomposed vertical. The lotion bottle and cream jar are stacked roughly center-to-lower-center of a 3:4 portrait frame on a sage-green (#eef3e8) surface, soft natural daylight from above. Clean upper third of the frame reserved for mobile headline overlay. Photo-real, editorial, no faces, no competitor branding.

---

## Why It Works — `why-it-works` (`landing-health-image`)

This section needs three product detail shots that read as a small visual triptych. They share the visual language of the hero but are tighter and more specific.

### `image_1`
- **Setting:** `image_1`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** WebP
- **Alt text:** `Pure Unscented Body Lotion bottle` *(matches existing `image_1_alt`)*
- **Generation prompt:**
  > Hero product shot of a single pump-dispenser body lotion bottle. White opaque liquid visible, minimal cream-colored label. Centered on a warm cream (#faf7f0) backdrop. Soft natural daylight, gentle shadow falling lower-right. Square 1:1 framing with the bottle filling about 70% of the frame vertically. Photo-real, editorial, calm. No competitor branding, no faces.

### `image_2`
- **Setting:** `image_2`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** WebP
- **Alt text:** `Pure Unscented Body Cream jar` *(matches existing `image_2_alt`)*
- **Generation prompt:**
  > Hero product shot of a single squat glass jar of body cream, lid off and resting at the side. Contents visible: creamy off-white cream with a subtle warm peach / red-orange tint (unrefined red palm oil). Centered on a sage-green (#eef3e8) backdrop. Soft natural daylight, gentle shadow falling lower-right. Square 1:1 framing with the jar filling about 60% of the frame vertically. Photo-real, editorial, calm. No competitor branding, no faces.

### `image_3`
- **Setting:** `image_3`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** WebP
- **Alt text:** `Sensitive Skin Set components together` *(matches existing `image_3_alt`)*
- **Generation prompt:**
  > Both products together: pump-dispenser body lotion bottle and squat glass jar of body cream side by side, jar slightly forward. Cream visible inside the jar (creamy off-white with subtle warm peach tint). Backdrop is split — left half sage-green (#eef3e8), right half warm cream (#faf7f0) — soft transition, no hard line. Soft natural daylight from upper-left, gentle shadows. Square 1:1, products fill ~75% of frame. Photo-real, editorial. No competitor branding, no faces.

---

## Stats Hero — `stats-hero` (`image-with-text`)

### `image`
- **Setting:** `image`
- **Dimensions:** 1600 × 1600 (1:1, displayed adapt-to-image)
- **Format:** WebP (JPG acceptable)
- **Alt text:** `Hand applying Pure Unscented Body Lotion to a forearm in soft daylight`
- **Generation prompt:**
  > Lifestyle close-up: a single hand pumping body lotion onto the back of the opposite forearm. White lotion just dispensed onto skin, mid-application — not yet rubbed in. Skin tone neutral / unspecified, no jewelry, no nail polish, no tattoos, no watch. Background is softly out-of-focus warm cream (#faf7f0) with a subtle hint of sage on the edges. Natural daylight from a window left of frame. The lotion bottle sits in the soft background, just barely recognizable. Square 1:1. Editorial, calm, aspirational. Photo-real. No face visible, no competitor branding, no logos.

---

## Stats Row — `stats-row` (`multicolumn`)

**No images required.** This section is configured as text-only stat cards (4 numeric callouts). Skip.

---

## Quality Trust — `quality-trust` (`guarantees`)

**No images required.** This section uses preset built-in SVG icons (`leaf`, `shield`, `heart`, `map_pin`). Skip.

---

## UGC Photos — `ugc-photos` (`multicolumn`)

Four customer-style square photos. **These are deliberately the opposite of hero/CTA shots** — they should look like real customers shot them on a phone in a bathroom or on a counter. Polish kills credibility here.

### `ugc-1` (Morgan K.)
- **Setting:** `ugc-1.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG (UGC-style — slight compression artifacts are fine, even helpful)
- **Alt text:** `Customer photo of Pure Unscented Body Lotion on a bathroom counter`
- **Generation prompt:**
  > UGC-style smartphone photo (looks like an iPhone snapshot, NOT a studio shot). The Pure Unscented Body Lotion bottle sits on a bathroom counter next to a folded white washcloth. Slightly imperfect framing, a bit of natural overhead bathroom lighting (warm-tinged), faint reflection on the counter. Casual, real, lived-in. No competitor product visible. No face. Square 1:1.

### `ugc-2` (Casey R.)
- **Setting:** `ugc-2.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG
- **Alt text:** `Customer photo of Pure Unscented Body Cream jar in hand`
- **Generation prompt:**
  > UGC-style smartphone photo. A hand holds open the squat glass jar of body cream — fingertip just dipped into the creamy off-white cream (subtle warm peach tint). Soft natural daylight from a window in the background, slightly out of focus. Casual home setting (kitchen counter or windowsill). Looks shot on a phone, not styled. No face beyond the hand. Square 1:1. No competitor branding.

### `ugc-3` (Jordan T.)
- **Setting:** `ugc-3.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG
- **Alt text:** `Customer photo of Pure Unscented Body Lotion and Cream on a wooden tray`
- **Generation prompt:**
  > UGC-style smartphone photo. Both products — lotion bottle and cream jar — sit on a small wooden tray on a nightstand or dresser. A folded knit blanket edge intrudes from the corner. Warm bedside-lamp lighting mixed with daylight. Slightly off-axis, casual phone framing. No face. No competitor product. Square 1:1.

### `ugc-4` (Alex M.)
- **Setting:** `ugc-4.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG
- **Alt text:** `Customer photo of the Sensitive Skin Set with free Pure Unscented Lip Balm and Bar Soap`
- **Generation prompt:**
  > UGC-style smartphone photo of a customer "unboxing" moment. Body Lotion bottle, body Cream jar, plus a small Pure Unscented lip balm tube and a wrapped Unscented bar soap arranged loosely on a kitchen counter or wooden table. A bit of brown craft paper / tissue from the shipping box visible at the edge. Daylight, casual, slightly cluttered, real. No face. Square 1:1.

---

## Compare Table — `compare-table` (`landing-compare-table`)

### `us_image`
- **Setting:** `us_image`
- **Dimensions:** 256 × 256 (1:1, displayed at ~64×64 — render at 4× for retina)
- **Format:** WebP or PNG (PNG if it carries transparency)
- **Alt text:** `Sensitive Skin Set` *(matches existing `us_image_alt`)*
- **Generation prompt:**
  > Tiny product thumbnail: lotion bottle and cream jar tightly composed together, viewed from a slight 3/4 angle. Solid sage-green (#eef3e8) background to match the column header tint, OR transparent background (PNG) if the implementer wants the column color to show through. Products fill ~85% of the square frame — this is a thumbnail, every pixel counts. Crisp, clean, no clutter, no shadow drama. 1:1 square.

---

## Don't Fumble CTA — `dont-fumble-cta` (`image-with-text`)

### `image`
- **Setting:** `image`
- **Dimensions:** 1600 × 1600 (1:1)
- **Format:** WebP
- **Alt text:** `A bathroom shelf cleared of half-empty lotion bottles, with the Sensitive Skin Set in their place`
- **Generation prompt:**
  > Editorial mood shot. A clean wooden bathroom shelf — the kind you'd find in a thoughtfully designed bathroom. Only two products on the shelf: the Pure Unscented Body Lotion bottle and the Pure Unscented Body Cream jar, calmly placed with breathing room between them. Soft natural daylight from a window out of frame, a hint of greenery (a small eucalyptus stem or olive leaf) just at the edge for warmth. Background is a soft warm cream wall (#faf7f0). The shelf reads as the *conclusion* of a search — implied: "the graveyard of half-empty bottles is gone, just these two left." Photo-real, editorial, calm, premium. Square 1:1. No faces, no competitor branding, no other products.

---

## Final CTA Strip — `final-cta-strip` (`rich-text`)

**No images required.** Configured as a full-bleed dark color block (`#1a1b18`) with white text and a yellow CTA button. Skip.

---

## Founder Block — `founder-block` (`image-with-text`)

**Already populated.** `image: shopify://shop_images/Coconut-About_a5199414-98ea-4656-b46e-3e10e2a6f27f.jpg` — the existing founder/about portrait. **No new image needed.**

(If at any point this image is wiped or replaced, the spec is: a portrait or environmental shot of Sean Fillmore in a kitchen / workshop context, warm tones, ~1600×1600. Hand off to existing brand photography library before generating new.)

---

## Free-From Block — `free-from-block` (`image-with-text`)

**Already populated.** `image: shopify://shop_images/coconut_oil.webp` — the existing coconut-oil ingredient hero. **No new image needed.**

---

## Summary Table

| Section | Setting | New image needed? | Dimensions |
|---|---|---|---|
| hero | `bg_image_desktop` | YES | 2400×1200 |
| hero | `bg_image_mobile` | YES | 750×1000 |
| why-it-works | `image_1` | YES | 800×800 |
| why-it-works | `image_2` | YES | 800×800 |
| why-it-works | `image_3` | YES | 800×800 |
| stats-hero | `image` | YES | 1600×1600 |
| stats-row | — | No (text-only) | — |
| quality-trust | — | No (preset SVG icons) | — |
| ugc-photos | `ugc-1.image` | YES | 800×800 |
| ugc-photos | `ugc-2.image` | YES | 800×800 |
| ugc-photos | `ugc-3.image` | YES | 800×800 |
| ugc-photos | `ugc-4.image` | YES | 800×800 |
| compare-table | `us_image` | YES | 256×256 |
| dont-fumble-cta | `image` | YES | 1600×1600 |
| final-cta-strip | — | No (dark color block) | — |
| founder-block | `image` | No (existing asset) | — |
| free-from-block | `image` | No (existing asset) | — |

**Totals:** 12 new images required, 2 existing assets reused, 3 sections image-free by design.

---

## Production Order (highest visual impact first)

Render in this order so partial completion still produces a presentable lander.

1. **`hero` — `bg_image_desktop`** (2400×1200) — first thing every visitor sees; non-negotiable.
2. **`hero` — `bg_image_mobile`** (750×1000) — mobile is >60% of traffic; pair with #1.
3. **`stats-hero` — `image`** (1600×1600) — second viewport on desktop, anchors the "Modern Skincare Is Failing Sensitive Skin" stat block.
4. **`dont-fumble-cta` — `image`** (1600×1600) — closes the page emotionally; needs to feel premium.
5. **`why-it-works` — `image_1`, `image_2`, `image_3`** (800×800 ×3) — generate as a triptych in one batch so they share lighting/palette.
6. **`compare-table` — `us_image`** (256×256) — small but highly visible inside the comparison table header.
7. **`ugc-photos` — `ugc-1` through `ugc-4`** (800×800 ×4) — generate last and as a batch; these MUST look casual and consistent with each other (same UGC tone), so batching keeps style coherent.

**Batch grouping recommendation:**
- **Batch A (editorial / hero set):** items 1–4 — same lighting language, calm editorial tone.
- **Batch B (product triptych):** item 5 — same lighting, three product variations.
- **Batch C (thumbnail):** item 6 — solo render.
- **Batch D (UGC set):** item 7 — deliberately casual; render with a separate "phone snapshot" style prompt prefix so they don't drift toward editorial.
