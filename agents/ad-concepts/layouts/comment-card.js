import { esc, bandHtml, bandRegions, plateBg, SIZES, BAND_HEIGHT } from './band.js';

const W = 1080, H = 1080;
const BUBBLE_TOP = 190, BUBBLE_MAX = H - BAND_HEIGHT - BUBBLE_TOP - 14;

function headlineHtml(headline, emphasis) {
  const h = String(headline || '');
  const i = emphasis ? h.toLowerCase().indexOf(String(emphasis).toLowerCase()) : -1;
  if (i < 0) return esc(h);
  const j = i + String(emphasis).length;
  return `${esc(h.slice(0, i))}<span style="border-bottom:7px solid #c0392b">${esc(h.slice(i, j))}</span>${esc(h.slice(j))}`;
}

export default {
  key: 'comment-card',
  plates: 1,
  size: () => SIZES['1:1'],
  // bubble is the MAX box (the quote may be shorter); the rendered bubble is always inside it.
  regions: (ratio, slots) => [
    { name: 'headline', x: 40, y: 56, w: 1000, h: 118 },
    { name: 'bubble', x: 80, y: BUBBLE_TOP, w: 920, h: BUBBLE_MAX },
    ...bandRegions(W, H, slots),
  ],
  render({ plates, slots }) {
    return `<div style="position:relative;width:${W}px;height:${H}px;${plateBg(plates[0])}">
<div data-fit data-region="headline" data-min="30" style="position:absolute;top:56px;left:40px;width:1000px;height:118px;overflow:hidden;text-align:center;font-family:Outfit;font-weight:600;font-size:76px;line-height:1.1;color:#000;letter-spacing:-1px">${headlineHtml(slots.headline, slots.emphasis)}</div>
<div style="position:absolute;top:${BUBBLE_TOP}px;left:80px;right:80px;display:flex;gap:22px;align-items:flex-start">
<div style="flex:none;width:76px;height:76px;border-radius:50%;background:#C9CDD2"></div>
<div data-fit data-region="bubble" data-min="14" style="width:822px;max-height:${BUBBLE_MAX}px;overflow:hidden;font-family:Cabin;font-size:31px">
<div style="background:#F0F2F5;border-radius:26px;padding:22px 28px;line-height:1.32;color:#050505"><div style="font-weight:700;font-size:.9032em;margin-bottom:6px">Customer review</div>${esc(slots.quote)}</div>
<div style="font-weight:700;font-size:.7742em;color:#3a3b3c;margin:10px 0 0 26px">Like&nbsp;&nbsp;&nbsp;Reply</div>
</div></div>
${bandHtml({ text: slots.band, width: W, height: H })}
</div>`;
  },
};
