// Rows keyed by scripts/cutout-product.mjs out of the two shadowless plates.
// The cream plate came back with pale ghost banding across the top; the
// connected-component filter dropped it, which is why the crop box starts below.
import { routineFrame } from './routine-frame.mjs';

export default routineFrame({
  name: 'frame-02-routine-pure-unscented',
  variant: 'Pure Unscented',
  lotions: { file: 'data/brand/cutouts/reset-unscented-lotions.png', w: 1376, h: 1240 },
  creams: { file: 'data/brand/cutouts/reset-unscented-creams.png', w: 2432, h: 670 },
});
