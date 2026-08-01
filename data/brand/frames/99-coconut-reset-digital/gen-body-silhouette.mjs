/**
 * Source plate for frame 7 — a human silhouette.
 *
 * Depicts no product, so there is nothing to ground it in and no packaging to get
 * wrong; that is why depictsProduct is false. Media plan §3 permits generating a
 * diagram — only the contents of the box must be real.
 *
 * Asked for a solid dark figure on white so the shape can be keyed to alpha and
 * recoloured to the brand tone, and so the mask can be measured to place the zone
 * markers on the actual elbow and heel rather than by eye.
 *
 * The pose matters: arms must be clear of the torso. Hand-drawing this three times
 * failed on exactly that — the arms merged into the body and the "Hands" marker
 * landed on what read as a hip.
 */
export default {
  name: 'body-silhouette',
  product: '99-coconut-reset-digital',
  aspectRatio: '2:3',
  depictsProduct: false,
  references: [],
  prompt: [
    'A simple, elegant silhouette of a standing human figure, seen from the front.',
    '',
    'Solid dark charcoal, filled flat with no shading, gradient or outline, on a pure',
    'white background. No facial features, no hair detail, no clothing.',
    '',
    'Natural relaxed proportions. Arms hang down but are held clearly away from the',
    'sides so there is visible white space between each arm and the torso along their',
    'whole length. Legs slightly apart with visible white space between them. Feet',
    'flat on the ground and fully visible.',
    '',
    'The whole body from the top of the head to the soles of the feet is inside the',
    'frame, centred, with generous even margin. Nothing is cropped.',
  ].join('\n'),
};
