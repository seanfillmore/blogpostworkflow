// Bands measured off the source photo by scanning a column down the left bottle:
// the bottle's white base ends at y≈1386 and the jar's ribbed lid begins there.
// Cutting on that seam is what makes the two crops read as "resting on" rather
// than as one photo sliced through a label.
import { routineFrame } from './routine-frame.mjs';

export default routineFrame({
  name: 'frame-02-routine-coconut-breeze',
  variant: 'Coconut Breeze',
  photo: 'data/brand/bundle-images/90-day-reset-coconutbreeze.jpg',
  lotionBand: [172, 1388],
  creamBand: [1378, 1878],
});
