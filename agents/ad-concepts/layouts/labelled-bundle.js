import { esc, bandHtml, bandRegion, plateBg, SIZES, BAND_HEIGHT } from './band.js';

const W = 1080, H = 1080, LW = 300, LH = 64;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

export default {
  key: 'labelled-bundle',
  plates: 1,
  size: () => SIZES['1:1'],
  regions: () => [{ name: 'label-zone', x: 0, y: 0, w: W, h: H - BAND_HEIGHT }, bandRegion(W, H)],
  // slots.labels: 2-4 of { text, x, y, tx, ty } in 0-1 frame fractions: label centre (x,y), product point (tx,ty).
  render({ plates, slots }) {
    const labels = slots.labels || [];
    if (labels.length < 2 || labels.length > 4) throw new Error(`labelled-bundle needs 2-4 labels, got ${labels.length}`);
    const items = labels.map(l => {
      const cx = clamp(num(l.x, .5) * W, LW / 2 + 16, W - LW / 2 - 16);
      const cy = clamp(num(l.y, .2) * H, LH / 2 + 16, H - BAND_HEIGHT - LH / 2 - 16);
      return { text: l.text, cx, cy, tx: clamp(num(l.tx, .5) * W, 0, W), ty: clamp(num(l.ty, .6) * H, 0, H - BAND_HEIGHT) };
    });
    const lines = items.map(i => `<line x1="${i.cx}" y1="${i.cy}" x2="${i.tx}" y2="${i.ty}" stroke="#fff" stroke-width="3"/><circle cx="${i.tx}" cy="${i.ty}" r="7" fill="#fff" stroke="#000" stroke-opacity=".35"/>`).join('');
    const pills = items.map(i => `<div data-fit data-min="14" style="position:absolute;left:${i.cx - LW / 2}px;top:${i.cy - LH / 2}px;width:${LW}px;height:${LH}px;line-height:${LH}px;text-align:center;white-space:nowrap;overflow:hidden;border-radius:${LH / 2}px;background:#fff;color:#111;font-family:Outfit;font-weight:600;font-size:30px;box-shadow:0 2px 10px rgba(0,0,0,.3)">${esc(i.text)}</div>`).join('');
    return `<div style="position:relative;width:${W}px;height:${H}px;${plateBg(plates[0])};overflow:hidden">
<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0">${lines}</svg>${pills}
${bandHtml({ text: slots.band, width: W, height: H })}
</div>`;
  },
};
