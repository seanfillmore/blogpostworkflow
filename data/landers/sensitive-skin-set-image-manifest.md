# Sensitive Skin Set Lander — Image Manifest

**Template:** `realskincare-theme/templates/product.landing-page-sensitive-skin-set-lander.json`
**Branch:** `feat/sensitive-skin-set-lander` @ `d5f5319`
**Purpose:** Every image the lander needs, with target dimensions, alt text, format, and copy-pasteable AI generation prompts.

## At a glance

**12 new images to generate · 2 existing assets reused · 3 sections image-free**

| # | Setting | Section | Dimensions | Format |
|---|---|---|---|---|
| 1 | `bg_image_desktop` | hero | 2400 × 1200 | WebP |
| 2 | `bg_image_mobile` | hero | 750 × 1000 | WebP |
| 3 | `image_1` | why-it-works | 800 × 800 | WebP |
| 4 | `image_2` | why-it-works | 800 × 800 | WebP |
| 5 | `image_3` | why-it-works | 800 × 800 | WebP |
| 6 | `<img>` inline | stats-hero | 1600 × 1600 | WebP |
| 7 | `ugc-1.image` | ugc-photos | 800 × 800 | JPG |
| 8 | `ugc-2.image` | ugc-photos | 800 × 800 | JPG |
| 9 | `ugc-3.image` | ugc-photos | 800 × 800 | JPG |
| 10 | `ugc-4.image` | ugc-photos | 800 × 800 | JPG |
| 11 | `us_image` | compare-table | 512 × 512 | PNG (transparent) |
| 12 | `image` | dont-fumble-cta | 1600 × 1600 | WebP |

## File-naming convention

When you save generated assets, name them so they map cleanly to setting keys:

| Setting | Filename |
|---|---|
| `bg_image_desktop` | `hero-desktop.webp` |
| `bg_image_mobile` | `hero-mobile.webp` |
| `image_1` | `why-1-lotion.webp` |
| `image_2` | `why-2-cream.webp` |
| `image_3` | `why-3-set.webp` |
| stats-hero inline | `stats-hand-applying.webp` |
| `ugc-1.image` | `ugc-1-bathroom-counter.jpg` |
| `ugc-2.image` | `ugc-2-cream-in-hand.jpg` |
| `ugc-3.image` | `ugc-3-nightstand-tray.jpg` |
| `ugc-4.image` | `ugc-4-unboxing.jpg` |
| `us_image` | `compare-thumb.png` |
| dont-fumble | `dont-fumble-shelf.webp` |

Upload via Shopify admin → **Settings → Files**. The Theme Editor image picker reads from there.

## Visual System (apply to editorial shots; UGC exempt)

- **Palette anchors:** `#eef3e8` (sage green), `#faf7f0` (warm cream), `#1a1b18` (near-black), `#FFB503` (yellow accent), `#4a8b3c` (deep green).
- **Lighting (editorial only):** Soft, natural daylight — north-facing window quality. No hard studio strobes, no obvious ring-light catchlights. *(UGC shots intentionally use casual mixed/warm lighting — see the UGC section.)*
- **Tone:** Editorial, calm, aspirational for hero / CTA / brand shots.
- **Privacy rule:** No model faces anywhere on the lander. Hands, forearms, and over-the-shoulder framing are fine.
- **Brand hygiene:** No competitor product, no competitor branding, no logos other than RSC's own.
- **The two products:**
  - **Pure Unscented Body Lotion** — clear bottle with white opaque liquid, pump dispenser, minimal cream-colored label.
  - **Pure Unscented Body Cream** — squat glass jar, contents are creamy off-white with a subtle warm peach / red-orange tint from unrefined red palm oil. *(Important — do NOT render the cream as pure white.)*

---

## 1. Hero desktop background

- **Setting:** `bg_image_desktop`
- **Dimensions:** 2400 × 1200 (2:1)
- **Format:** WebP (JPG fallback acceptable)
- **Alt text:** `Pure Unscented Body Lotion bottle and Pure Unscented Body Cream jar on a sage-green surface in soft daylight`
- **Prompt:**
  > Editorial product photo, soft natural daylight from upper right, gentle long shadows. A clear pump bottle of body lotion with white opaque liquid (label minimal cream-colored) sits beside a squat glass jar of body cream — the cream inside is creamy off-white with a subtle warm peach / red-orange tint, lid off and angled slightly. Both products are right-of-center on a smooth sage-green (#eef3e8) surface that fades to warm cream (#faf7f0) on the right. Clean negative space on the LEFT half of the frame for headline overlay. Minimalist, calm, premium-but-approachable. Shallow depth of field. No competitor branding, no faces, no clutter. 2:1 aspect. Photo-real.

## 2. Hero mobile background

- **Setting:** `bg_image_mobile`
- **Dimensions:** 750 × 1000 (3:4 portrait)
- **Format:** WebP
- **Alt text:** `Pure Unscented Body Lotion and Body Cream on a sage-green surface, soft daylight`
- **⚠ Aspect-ratio caveat:** `hero-landing-section.liquid` mobile breakpoint isn't pinned to 3:4. On taller phones (iPhone Pro Max ≈ 19.5:9) a 3:4 source may crop tighter than expected. Render the focal subject (products) within the central 60% of the frame so cropping doesn't lose them.
- **Prompt:**
  > Same products and palette as desktop hero, recomposed vertical. The lotion bottle and cream jar are stacked roughly center-to-lower-center of a 3:4 portrait frame on a sage-green (#eef3e8) surface, soft natural daylight from above. Clean upper third of the frame reserved for mobile headline overlay. Products kept in the central 60% of the frame so device-specific crop doesn't lose them. Photo-real, editorial, no faces, no competitor branding.

## 3. Why It Works — image 1 (lotion)

- **Setting:** `image_1`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** WebP
- **Alt text:** `Pure Unscented Body Lotion bottle`
- **Prompt:**
  > Hero product shot of a single pump-dispenser body lotion bottle. White opaque liquid visible, minimal cream-colored label. Centered on a warm cream (#faf7f0) backdrop. Soft natural daylight, gentle shadow falling lower-right. Square 1:1 framing with the bottle filling about 70% of the frame vertically. Photo-real, editorial, calm. No competitor branding, no faces.

## 4. Why It Works — image 2 (cream)

- **Setting:** `image_2`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** WebP
- **Alt text:** `Pure Unscented Body Cream jar`
- **Prompt:**
  > Hero product shot of a single squat glass jar of body cream, lid off and resting at the side. Contents visible: creamy off-white cream with a subtle warm peach / red-orange tint (unrefined red palm oil). Centered on a sage-green (#eef3e8) backdrop. Soft natural daylight, gentle shadow falling lower-right. Square 1:1 framing with the jar filling about 60% of the frame vertically. Photo-real, editorial, calm. No competitor branding, no faces.

## 5. Why It Works — image 3 (set together)

- **Setting:** `image_3`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** WebP
- **Alt text:** `Sensitive Skin Set components together`
- **Prompt:**
  > Both products together: pump-dispenser body lotion bottle and squat glass jar of body cream side by side, jar slightly forward. Cream visible inside the jar (creamy off-white with subtle warm peach tint). Backdrop is split — left half sage-green (#eef3e8), right half warm cream (#faf7f0) — soft transition, no hard line. Soft natural daylight from upper-left, gentle shadows. Square 1:1, products fill ~75% of frame. Photo-real, editorial. No competitor branding, no faces.

## 6. Stats Hero (inline image — pasted into custom-liquid)

- **Where it goes:** `sections.stats-hero.settings.custom_liquid` — replace the `<!-- Image goes here ... -->` HTML comment with an `<img>` tag like:
  ```html
  <img src="{{ 'stats-hand-applying.webp' | asset_url }}" alt="Hand applying Pure Unscented Body Lotion to a forearm in soft daylight" loading="lazy" style="width:100%;height:100%;object-fit:cover;">
  ```
  *(Or use a Files URL if uploaded via Settings → Files instead of dropped into theme assets.)*
- **Dimensions:** 1600 × 1600 (1:1)
- **Format:** WebP (JPG acceptable)
- **Alt text:** `Hand applying Pure Unscented Body Lotion to a forearm in soft daylight`
- **Prompt:**
  > Lifestyle close-up: a single hand pumping body lotion onto the back of the opposite forearm. White lotion just dispensed onto skin, mid-application — not yet rubbed in. Skin tone neutral / unspecified, no jewelry, no nail polish, no tattoos, no watch. Background is softly out-of-focus warm cream (#faf7f0) with a subtle hint of sage on the edges. Natural daylight from a window left of frame. The lotion bottle sits in the soft background, just barely recognizable. Square 1:1. Editorial, calm, aspirational. Photo-real. No face visible, no competitor branding, no logos.

## 7–10. UGC Photos (4 images, render as a batch)

UGC shots are deliberately the *opposite* of the editorial set — they should look like real customers shot them on a phone. Polish kills credibility here. **Prefix each prompt with a "UGC tone" cue** when generating (Midjourney `--style raw` helps, Sora "amateur smartphone" wording helps).

### 7. UGC-1 (Morgan K.)

- **Setting:** `ugc-1.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG (slight compression artifacts are *fine*, even helpful)
- **Alt text:** `Customer photo of Pure Unscented Body Lotion on a bathroom counter`
- **Prompt:**
  > UGC-style smartphone photo (looks like an iPhone snapshot, NOT a studio shot). The Pure Unscented Body Lotion bottle sits on a bathroom counter next to a folded white washcloth. Slightly imperfect framing, a bit of natural overhead bathroom lighting (warm-tinged), faint reflection on the counter. Casual, real, lived-in. No competitor product visible. No face. Square 1:1.

### 8. UGC-2 (Casey R.)

- **Setting:** `ugc-2.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG
- **Alt text:** `Customer photo of Pure Unscented Body Cream jar in hand`
- **Prompt:**
  > UGC-style smartphone photo. A hand holds open the squat glass jar of body cream — fingertip just dipped into the creamy off-white cream (subtle warm peach tint). Soft natural daylight from a window in the background, slightly out of focus. Casual home setting (kitchen counter or windowsill). Looks shot on a phone, not styled. No face beyond the hand. Square 1:1. No competitor branding.

### 9. UGC-3 (Jordan T.)

- **Setting:** `ugc-3.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG
- **Alt text:** `Customer photo of Pure Unscented Body Lotion and Cream on a wooden tray`
- **Prompt:**
  > UGC-style smartphone photo. Both products — lotion bottle and cream jar — sit on a small wooden tray on a nightstand or dresser. A folded knit blanket edge intrudes from the corner. Warm bedside-lamp lighting mixed with daylight. Slightly off-axis, casual phone framing. No face. No competitor product. Square 1:1.

### 10. UGC-4 (Alex M.)

- **Setting:** `ugc-4.settings.image`
- **Dimensions:** 800 × 800 (1:1)
- **Format:** JPG
- **Alt text:** `Customer photo of the Sensitive Skin Set with free Pure Unscented Lip Balm and Bar Soap`
- **Prompt:**
  > UGC-style smartphone photo of a customer "unboxing" moment. Body Lotion bottle, body Cream jar, plus a small Pure Unscented lip balm tube and a wrapped Unscented bar soap arranged loosely on a kitchen counter or wooden table. A bit of brown craft paper / tissue from the shipping box visible at the edge. Daylight, casual, slightly cluttered, real. No face. Square 1:1.

## 11. Compare Table thumbnail

- **Setting:** `us_image`
- **Dimensions:** 512 × 512 (1:1) — render at this size for retina headroom (displays at ~64×64, but tablet breakpoints push to ~96–128px)
- **Format:** PNG with transparent background (so it sits cleanly on the green-tinted "Us" column header regardless of future palette changes)
- **Alt text:** `Sensitive Skin Set`
- **Prompt:**
  > Tiny product thumbnail: lotion bottle and cream jar tightly composed together, viewed from a slight 3/4 angle. Transparent background. Products fill ~85% of the square frame — every pixel counts. Soft, even lighting, minimal shadow (light drop shadow OK to ground them on the column). Crisp, clean, no clutter. Output as a transparent PNG. 1:1 square.

## 12. Don't Fumble CTA

- **Setting:** `dont-fumble-cta.image`
- **Dimensions:** 1600 × 1600 (1:1)
- **Format:** WebP
- **Alt text:** `A bathroom shelf cleared of half-empty lotion bottles, with the Sensitive Skin Set in their place`
- **Prompt:**
  > Editorial mood shot. A clean wooden bathroom shelf — the kind you'd find in a thoughtfully designed bathroom. Only two products on the shelf: the Pure Unscented Body Lotion bottle and the Pure Unscented Body Cream jar, calmly placed with breathing room between them. Soft natural daylight from a window out of frame, a hint of greenery (a small eucalyptus stem or olive leaf) just at the edge for warmth. Background is a soft warm cream wall (#faf7f0). The shelf reads as the *conclusion* of a search — implied: "the graveyard of half-empty bottles is gone, just these two left." Photo-real, editorial, calm, premium. Square 1:1. No faces, no competitor branding, no other products.

---

## Sections that need NO new images

- **stats-row** (`multicolumn`) — 4 text-only stat cards.
- **quality-trust** (`guarantees`) — uses preset SVG icons (`leaf`, `shield`, `heart`, `map_pin`).
- **final-cta-strip** (`rich-text`) — full-bleed dark color block with text and button only.
- **founder-block** (`image-with-text`) — already populated with `shopify://shop_images/Coconut-About_a5199414-98ea-4656-b46e-3e10e2a6f27f.jpg`.
- **free-from-block** (`image-with-text`) — already populated with `shopify://shop_images/coconut_oil.webp`.
- **hero-ingredient-cards** (`multicolumn`) — already populated with `shopify://shop_images/Wax.webp` (lotion card) and `shopify://shop_images/Coconut_Oil_Extract.webp` (cream card).

---

## Production order

Render in this order so partial completion still produces a presentable lander.

**Batch A — editorial set (top of page):**
1. `bg_image_desktop` (hero, 2400×1200)
2. `bg_image_mobile` (hero, 750×1000)
3. stats-hero inline (1600×1600)
4. dont-fumble-cta (1600×1600)

**Batch B — product triptych:**
5. `image_1`, `image_2`, `image_3` (why-it-works, 800×800 ×3) — generate in one Midjourney/Sora session so lighting/palette stays coherent across all three.

**Batch C — thumbnail:**
6. `us_image` (compare-table, 512×512 transparent PNG) — solo render.

**Batch D — UGC set:**
7. `ugc-1` through `ugc-4` (800×800 ×4) — render together with the same "phone snapshot, not studio" prompt prefix so they read as a coherent UGC strip and don't drift toward editorial polish.
