import { bandHtml, bandRegion, plateBg, SIZES } from './band.js';

export default {
  key: 'photo-only',
  plates: 1,
  size: (ratio) => SIZES[ratio] || SIZES['1:1'],
  regions(ratio) { const s = SIZES[ratio] || SIZES['1:1']; return [bandRegion(s.width, s.height)]; },
  render({ plates, slots, ratio }) {
    const { width, height } = SIZES[ratio] || SIZES['1:1'];
    return `<div style="position:relative;width:${width}px;height:${height}px;${plateBg(plates[0])};overflow:hidden">${bandHtml({ text: slots.band, width, height })}</div>`;
  },
};
