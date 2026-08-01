/**
 * Not a finished frame — a PLATE. The model relights and re-grounds the real
 * product photo; it is never asked to draw the product or any text.
 *
 * Two generation rounds established the reason: asked to lay out the whole
 * infographic, gemini-3-pro-image produced excellent composition and unusable
 * packaging — "6 fl. oz - 230ml" where the bottle says 8 fl oz / 236ml, jars at
 * 110ml where they are 118ml, and the ORGANIC COCONUT OIL seal rendered as
 * mirrored gibberish. Wrong volume on a cosmetic is an accuracy problem.
 *
 * So the split is: model owns background, lighting and shadow; the photograph
 * owns the product; render-frame.mjs owns every glyph.
 */
export default {
  name: 'plate-creams-coconut-breeze',
  product: '99-coconut-reset-digital',
  aspectRatio: '16:9',
  references: ['data/brand/bundle-images/90-day-reset-coconutbreeze.jpg'],
  prompt: [
    'Take the three cream jars from this photo and place them on a plain, warm',
    'sand-beige background (#EDE5D8), evenly spaced in a row, standing upright.',
    '',
    'Soft natural studio lighting from upper left, with a gentle contact shadow under',
    'each jar. Generous empty space around them.',
    '',
    'Keep each jar exactly as photographed — identical label, identical wording,',
    'identical proportions and lid. Do not redraw, restyle or re-letter the label.',
    'Do not add any text, captions, logos or graphics to the image.',
  ].join('\n'),
};
