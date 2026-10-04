import { esc, bandHtml, bandRegions, plateBg, sizeFor } from './band.js';

// Same headline position at 1:1 and 4:5 (approved reference B); the photo fills the extra height.

export default {
  key: 'headline-over-photo',
  plates: 1,
  ratios: ['4:5', '1:1'],
  size: (ratio) => sizeFor(ratio),
  regions: (ratio, slots) => [{ name: 'headline', x: 72, y: 70, w: 700, h: 192 }, ...bandRegions(1080, sizeFor(ratio).height, slots)],
  render({ plates, slots, ratio }) {
    const { height } = sizeFor(ratio);
    return `<div style="position:relative;width:1080px;height:${height}px;${plateBg(plates[0])}">
<div data-fit data-region="headline" data-min="34" style="position:absolute;top:70px;left:72px;width:700px;height:192px;overflow:hidden;white-space:pre-line;font-family:Outfit;font-weight:600;font-size:92px;line-height:1.02;color:#111;letter-spacing:-1px">${esc(slots.headline)}</div>
${bandHtml({ text: slots.band, width: 1080, height })}
</div>`;
  },
};
