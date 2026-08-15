// Single source of truth for models used across the creatives pipeline.
// Ad copy is revenue-critical → flagship. Everything else is a short,
// mechanical task → Haiku.
//
// Image model IDs: gemini-3-pro-image and gemini-3.1-flash-image went GA.
// Verified against the models endpoint 2026-08-14. Do not reintroduce the
// `-preview` suffixes — they are the older, separately-billed endpoints.
export const CREATIVE_MODELS = {
  adCopy: 'claude-opus-4-8',
  styleBrief: 'claude-haiku-4-5',
  templateVision: 'claude-haiku-4-5',
  styleVision: 'claude-haiku-4-5',
  sessionName: 'claude-haiku-4-5',
  imageGen: 'gemini-3-pro-image',

  // agents/ad-studio. Pro @2K is the only image model that renders label text
  // legibly; Flash renders it blank or blurred.
  adStudio: {
    angle: 'claude-opus-4-8',
    copy: 'claude-opus-4-8',
    // Sonnet, NOT Haiku. Haiku passed a live ad whose headline read "DOES MORE WORK
    // TTHAN THE FORMLA" and whose bottle said "4 FL oz / 118ml" on an 8 fl. oz.
    // product — it auto-corrected both on the way out. This is one vision call
    // guarding a ~$0.13 render that nobody else reads before it goes live; the read
    // has to be worth more than the render. Do not drop it back to Haiku to save
    // pennies on the cheapest call in the pipeline.
    verify: 'claude-sonnet-5',
    imageGen: 'gemini-3-pro-image',
  },
};
