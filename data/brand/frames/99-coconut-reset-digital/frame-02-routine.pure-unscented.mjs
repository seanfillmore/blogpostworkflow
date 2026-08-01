// Same seam measurement as the Coconut Breeze frame; this photo is framed
// slightly differently (the jars sit on a marble surface), so the boundary falls
// at y≈1404 instead.
import { routineFrame } from './routine-frame.mjs';

export default routineFrame({
  name: 'frame-02-routine-pure-unscented',
  variant: 'Pure Unscented',
  photo: 'data/brand/bundle-images/90-day-reset-unscented.jpg',
  lotionBand: [196, 1406],
  creamBand: [1396, 1946],
});
