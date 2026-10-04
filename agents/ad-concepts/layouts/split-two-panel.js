import { esc, bandHtml, bandRegion, plateBg, SIZES } from './band.js';

const W = 1080, H = 1350, PANEL_W = 538, PANEL_H = 1246;

export default {
  key: 'split-two-panel',
  plates: 2,
  size: () => SIZES['4:5'],
  regions: () => [
    { name: 'left-label', x: 28, y: 44, w: PANEL_W - 56, h: 160 },
    { name: 'right-label', x: PANEL_W + 4 + 28, y: 44, w: PANEL_W - 56, h: 160 },
    bandRegion(W, H),
  ],
  render({ plates, slots }) {
    const panel = (x, plate, text) => `<div style="position:absolute;left:${x}px;top:0;width:${PANEL_W}px;height:${PANEL_H}px;${plateBg(plate)}">
<div data-fit data-min="20" style="position:absolute;top:44px;left:28px;width:${PANEL_W - 56}px;height:160px;overflow:hidden;text-align:center;font-family:Outfit;font-weight:600;font-size:46px;line-height:1.12;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.75)">${esc(text)}</div></div>`;
    return `<div style="position:relative;width:${W}px;height:${H}px;background:#000;overflow:hidden">
${panel(0, plates[0], slots.left)}${panel(PANEL_W + 4, plates[1], slots.right)}
${bandHtml({ text: slots.band, width: W, height: H, bg: '#EDE5D8', color: '#000', size: 38, spacing: 0 })}
</div>`;
  },
};
