import { esc, bandHtml, bandRegions, plateBg, sizeFor, BAND_HEIGHT } from './band.js';

export const LABEL_MAX_CHARS = 28;
const W = 1080, LW = 340, LH = 64;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d, what) => {
  if (v === undefined || v === null) return d;
  if (!Number.isFinite(+v) || +v < 0 || +v > 1) throw new Error(`labelled-bundle: ${what} must be a 0-1 fraction, got ${v}`);
  return +v;
};

export default {
  key: 'labelled-bundle',
  plates: 1,
  ratios: ['4:5', '1:1'],
  size: (ratio) => sizeFor(ratio),
  regions: (ratio, slots) => { const H = sizeFor(ratio).height; return [{ name: 'label-zone', x: 0, y: 0, w: W, h: H - BAND_HEIGHT }, ...bandRegions(W, H, slots)]; },
  // slots.labels: 2-4 of { text, x, y, tx, ty } in 0-1 frame fractions: label centre (x,y), product point (tx,ty).
  render({ plates, slots, ratio }) {
    const H = sizeFor(ratio).height;
    const labels = slots.labels || [];
    if (labels.length < 2 || labels.length > 4) throw new Error(`labelled-bundle needs 2-4 labels, got ${labels.length}`);
    for (const l of labels) if (String(l.text ?? "").length > LABEL_MAX_CHARS) throw new Error(`labelled-bundle: label "${l.text}" is ${String(l.text).length} chars, max ${LABEL_MAX_CHARS}`);
    const items = labels.map(l => {
      const cx = clamp(num(l.x, .5, 'x') * W, LW / 2 + 16, W - LW / 2 - 16);
      const cy = clamp(num(l.y, .2, 'y') * H, LH / 2 + 16, H - BAND_HEIGHT - LH / 2 - 16);
      return { text: l.text, cx, cy, tx: clamp(num(l.tx, .5, 'tx') * W, 0, W), ty: clamp(num(l.ty, .6, 'ty') * H, 0, H - BAND_HEIGHT) };
    });
    const lines = items.map(i => `<line x1="${i.cx}" y1="${i.cy}" x2="${i.tx}" y2="${i.ty}" stroke="#fff" stroke-width="3"/><circle cx="${i.tx}" cy="${i.ty}" r="7" fill="#fff" stroke="#000" stroke-opacity=".35"/>`).join('');
    const pills = items.map(i => `<div data-fit data-min="14" style="position:absolute;left:${i.cx - LW / 2}px;top:${i.cy - LH / 2}px;width:${LW}px;height:${LH}px;line-height:${LH}px;text-align:center;white-space:nowrap;overflow:hidden;border-radius:${LH / 2}px;background:#fff;color:#111;font-family:Outfit;font-weight:600;font-size:30px;box-shadow:0 2px 10px rgba(0,0,0,.3)">${esc(i.text)}</div>`).join('');
    return `<div style="position:relative;width:${W}px;height:${H}px;${plateBg(plates[0])};overflow:hidden">
<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0">${lines}</svg>${pills}
${bandHtml({ text: slots.band, width: W, height: H })}
</div>`;
  },
};
