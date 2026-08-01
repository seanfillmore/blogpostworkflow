/**
 * 90-Day Coconut Reset — frame 2 (educational infographic), Coconut Breeze.
 *
 * Grounded in three real photographs: the bundle hero (which fixes the count,
 * the scent and how the units sit together) plus the individual lotion and cream
 * shots, which carry the label typography at a size the model can actually read.
 * Without those the model renders a generic white cosmetic bottle.
 *
 * Prompt is deliberately short and plain. Per the AI-imagery skill, elaborate
 * camera/lens/lighting scaffolding adds effort without control — the references
 * carry the information. The on-image copy is quoted verbatim because that is the
 * one thing the model must not paraphrase.
 */
export default {
  name: 'gen-frame-02-routine-coconut-breeze',
  product: '99-coconut-reset-digital',
  aspectRatio: '1:1',
  references: [
    'data/brand/bundle-images/90-day-reset-coconutbreeze.jpg',
    'data/brand/reference/coconut-lotion-coconut-breeze.jpg',
    'data/brand/reference/coconut-moisturizer-coconut-breeze.jpg',
  ],
  prompt: [
    'Create a clean product infographic for this skincare bundle, for a Shopify product gallery.',
    '',
    'Layout, top to bottom:',
    '- Headline: "Daily lotion. Overnight cream."',
    '- A row of the three lotion bottles, with the caption "THREE LOTIONS · EVERY MORNING"',
    '- A row of the three cream jars, with the caption "THREE CREAMS · EVERY NIGHT"',
    '- Closing line: "One pair a month. Ninety days."',
    '',
    'Warm sand background (#EDE5D8), black text, soft natural studio lighting with a gentle',
    'shadow under each product. Simple, modern, clean style with generous white space.',
    'Mobile optimized: the headline must stay legible at thumbnail size.',
    '',
    'Use the exact bottles and jars from the reference photos — same labels, same wordmark,',
    'same proportions, same coconut artwork. Do not invent packaging or change any label text.',
  ].join('\n'),
};
