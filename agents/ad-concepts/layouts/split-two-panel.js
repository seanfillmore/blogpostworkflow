import { esc, bandHtml, bandRegions, plateBg, SIZES } from './band.js';

const W = 1080, H = 1350, PANEL_W = 538, PANEL_H = 1246;

export default {
  key: 'split-two-panel',
  plates: 2,
  ratios: ['4:5'],
  size: () => SIZES['4:5'],
  regions: (ratio, slots) => [
    { name: 'left-label', x: 28, y: 44, w: PANEL_W - 56, h: 160 },
    { name: 'right-label', x: PANEL_W + 4 + 28, y: 44, w: PANEL_W - 56, h: 160 },
    ...bandRegions(W, H, slots),
  ],
  render({ plates, slots }) {
    // The scrim keeps white captions legible over a pale render (2026-10-04: a cream tile wall and
    // a bright window both failed critique on legibility with the text shadow alone).
    const panel = (x, plate, text, name) => `<div style="position:absolute;left:${x}px;top:0;width:${PANEL_W}px;height:${PANEL_H}px;${plateBg(plate)}">
<div style="position:absolute;top:0;left:0;right:0;height:300px;background:linear-gradient(to bottom,rgba(0,0,0,.55),rgba(0,0,0,.3) 55%,rgba(0,0,0,0))"></div>
<div data-fit data-region="${name}" data-min="20" style="position:absolute;top:44px;left:28px;width:${PANEL_W - 56}px;height:160px;overflow:hidden;text-align:center;font-family:Outfit;font-weight:600;font-size:46px;line-height:1.12;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.75)">${esc(text)}</div></div>`;
    return `<div style="position:relative;width:${W}px;height:${H}px;background:#000;overflow:hidden">
${panel(0, plates[0], slots.left, 'left-label')}${panel(PANEL_W + 4, plates[1], slots.right, 'right-label')}
${bandHtml({ text: slots.band, width: W, height: H, bg: '#EDE5D8', color: '#000', size: 38, spacing: 0 })}
</div>`;
  },
};
