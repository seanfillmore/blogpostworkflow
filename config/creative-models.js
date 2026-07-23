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
