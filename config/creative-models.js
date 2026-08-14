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
    verify: 'claude-haiku-4-5',
    imageGen: 'gemini-3-pro-image',
  },
};
