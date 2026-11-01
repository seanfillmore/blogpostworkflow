import { bandHtml, bandRegions, plateBg, sizeFor } from './band.js';

export default {
  key: 'photo-only',
  plates: 1,
  ratios: ['4:5', '1:1'],
  size: (ratio) => sizeFor(ratio),
  regions(ratio, slots) { const s = sizeFor(ratio); return bandRegions(s.width, s.height, slots); },
  render({ plates, slots, ratio }) {
    const { width, height } = sizeFor(ratio);
    return `<div style="position:relative;width:${width}px;height:${height}px;${plateBg(plates[0])};overflow:hidden">${bandHtml({ text: slots.band, width, height })}</div>`;
  },
};
