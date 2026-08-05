/**
 * Propped scene plate for the Meta statics.
 *
 * The first pass of these ads was typographic — and Sean's read was that
 * nothing on them said skincare or lotion at all. A cold Meta audience has no
 * brand context, so every frame has to establish the category in the first
 * second, before any headline is read. That is what this plate is for: the
 * headline goes over it, not instead of it.
 *
 * Grounding is mandatory (marketing-ai-product-imagery): without our own
 * photographs the model averages the category and renders someone else's bottle.
 * Both real reference photos are supplied and the prompt forbids re-lettering.
 *
 * Props are chosen from the buy motive in data/context/voice-of-customer.md,
 * not for decoration: winter dry skin, a real bathroom counter, hands that work.
 * No human skin is shown close-up — a generated forearm is where these models
 * produce artefacts that survive a casual look.
 */
export default {
  name: 'scene-counter-coconut-breeze',
  product: '99-coconut-reset-digital',
  aspectRatio: '4:5',
  references: [
    'data/brand/reference/coconut-lotion-coconut-breeze.jpg',
    'data/brand/reference/coconut-moisturizer-coconut-breeze.jpg',
  ],
  prompt: [
    'A warm, bright lifestyle photograph of these two skincare products together on a',
    'pale stone bathroom counter, shot slightly from above at a natural angle.',
    '',
    'The tall bottle of body lotion stands at the left. The short wide jar of body cream',
    'sits at the right with its lid off, resting beside it, so the white cream inside is',
    'visible. Both labels face the camera and are fully readable.',
    '',
    'Props, arranged naturally and not crowding the products: a folded soft sage-green',
    'towel behind them, half a fresh coconut with white flesh, a few green palm leaves,',
    'and a small dish of water droplets. Warm morning sunlight from the left casting soft',
    'natural shadows across the counter.',
    '',
    'Rich, saturated, editorial skincare photography. Shallow depth of field with the',
    'products sharp. Colour palette of warm cream, sage green and natural coconut brown.',
    '',
    'Keep both products exactly as in the reference photos: identical labels, identical',
    'wording, identical proportions, identical caps. Do not re-letter or redesign anything.',
    'No people, no hands, no text, no captions, no graphics, no logos other than the ones',
    'already on the products.',
  ].join('\n'),
};
