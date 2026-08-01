/**
 * Source plate for frame 2 — lotion bottle row, Coconut Breeze.
 *
 * Two things here are deliberate and were both learned the hard way:
 *
 * 1. References EXCLUDE the bundle hero. Given it, the model reproduced its
 *    stacked composition however explicitly the prompt asked for separated units.
 *    A single-product reference leaves no stack to copy — and single-product
 *    references are also what keep the label wording correct.
 * 2. NO shadow is requested. The plate's own contact shadow is a darkened mint
 *    that survives the chroma key as a teal smudge under each unit. Asking for a
 *    flat, evenly lit backdrop keeps the matte clean; the grounding shadow is
 *    added in CSS by routine-frame.mjs, where it can be tuned and cannot leave
 *    residue.
 */
export default {
  name: 'plate-lotions-coconut-breeze',
  product: '99-coconut-reset-digital',
  aspectRatio: '16:9',
  references: ['data/brand/reference/coconut-lotion-coconut-breeze.jpg'],
  prompt: [
    'Photograph three identical units of this product side by side in a row,',
    'against a plain flat mint-green backdrop of one single even colour.',
    '',
    'They stand upright, evenly spaced, with clear space between them — none of them',
    'touch or overlap. Straight-on eye-level camera, flat even lighting.',
    '',
    'No shadows of any kind. No cast shadow, no contact shadow, no gradient, no',
    'vignette, no reflection, no surface or table. The background is one uniform',
    'flat colour edge to edge, as if for cutting out.',
    '',
    'Keep the product exactly as in the reference photo: identical label, identical',
    'wording, identical proportions, identical cap. Do not re-letter anything.',
    'No text, captions, graphics or props anywhere in the image.',
  ].join('\n'),
};
