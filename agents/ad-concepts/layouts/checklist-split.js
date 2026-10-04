import { esc, bandHtml, bandRegions, plateBg, SIZES } from './band.js';

const W = 1080, H = 1350, COL_TOP = 200, COL_H = 640, COL_W = 468, GAP = 24;
const X0 = (W - 2 * COL_W - GAP) / 2;
const X1 = X0 + COL_W + GAP;

export default {
  key: 'checklist-split',
  plates: 1,
  ratios: ['4:5'],
  size: () => SIZES['4:5'],
  regions: (ratio, slots) => [
    { name: 'title', x: 40, y: 56, w: 1000, h: 120 },
    { name: 'ours-column', x: X0, y: COL_TOP, w: COL_W, h: COL_H },
    { name: 'theirs-column', x: X1, y: COL_TOP, w: COL_W, h: COL_H },
    ...bandRegions(W, H, slots),
  ],
  render({ plates, slots }) {
    const rows = (list, mark, colour) => (list || []).map(r => `<div style="display:flex;gap:.5em;margin:0 0 .7em"><span style="flex:none;color:${colour};font-weight:700">${mark}</span><span>${esc(r)}</span></div>`).join('');
    const col = (x, name, head, list, mark, colour) => `<div data-region="${name}" style="position:absolute;left:${x}px;top:${COL_TOP}px;width:${COL_W}px;height:${COL_H}px;box-sizing:border-box;padding:28px;background:rgba(255,255,255,.9);border-radius:22px;overflow:hidden">
<div data-fit data-min="14" style="width:100%;height:100%;overflow:hidden;font-family:Cabin;font-size:34px;line-height:1.25;color:#111"><div style="font-family:Outfit;font-weight:600;font-size:1.2em;margin-bottom:.7em">${esc(head)}</div>${rows(list, mark, colour)}</div></div>`;
    return `<div style="position:relative;width:${W}px;height:${H}px;${plateBg(plates[0])};overflow:hidden">
<div data-fit data-region="title" data-min="26" style="position:absolute;top:56px;left:40px;width:1000px;height:120px;overflow:hidden;text-align:center;font-family:Outfit;font-weight:600;font-size:64px;line-height:1.1;color:#000;letter-spacing:-1px">${esc(slots.title)}</div>
${col(X0, 'ours-column', 'Ours', slots.oursRows, '\u2713', '#2e7d32')}${col(X1, 'theirs-column', slots.theirsLabel, slots.theirs, '\u2717', '#c0392b')}
${bandHtml({ text: slots.band, width: W, height: H, bg: '#EDE5D8', color: '#000', size: 38, spacing: 0 })}
</div>`;
  },
};
