import { esc, bandHtml, bandRegions, plateBg, SIZES } from './band.js';

export default {
  key: 'headline-over-photo',
  plates: 1,
  size: () => SIZES['1:1'],
  regions: (ratio, slots) => [{ name: 'headline', x: 72, y: 70, w: 700, h: 192 }, ...bandRegions(1080, 1080, slots)],
  render({ plates, slots }) {
    return `<div style="position:relative;width:1080px;height:1080px;${plateBg(plates[0])}">
<div data-fit data-region="headline" data-min="34" style="position:absolute;top:70px;left:72px;width:700px;height:192px;overflow:hidden;white-space:pre-line;font-family:Outfit;font-weight:600;font-size:92px;line-height:1.02;color:#111;letter-spacing:-1px">${esc(slots.headline)}</div>
${bandHtml({ text: slots.band, width: 1080, height: 1080 })}
</div>`;
  },
};
