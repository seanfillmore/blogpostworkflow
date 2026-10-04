// Shared bottom band: one line of Outfit set inside a fixed box, shrunk to fit (data-fit).
export const BAND_HEIGHT = 104;
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const cssUrl = (u) => String(u || '').replace(/['"\\()\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
export const SIZES = { '1:1': { width: 1080, height: 1080 }, '4:5': { width: 1080, height: 1350 } };

export function bandHtml({ text, width = 1080, height, bg = '#000', color = '#fff', size = 40, spacing = 2 }) {
  if (!text) return '';
  const top = height - BAND_HEIGHT;
  return `<div class="band" style="position:absolute;left:0;top:${top}px;width:${width}px;height:${BAND_HEIGHT}px;background:${bg}">
<div data-fit data-min="18" style="position:absolute;left:40px;top:0;width:${width - 80}px;height:${BAND_HEIGHT}px;line-height:${BAND_HEIGHT}px;text-align:center;white-space:nowrap;overflow:hidden;font-family:Outfit;font-weight:600;font-size:${size}px;letter-spacing:${spacing}px;color:${color}">${esc(text)}</div></div>`;
}

export const bandRegion = (width, height) => ({ name: 'band', x: 0, y: height - BAND_HEIGHT, w: width, h: BAND_HEIGHT });
export const plateBg = (url) => `background:url('${cssUrl(url)}') center/cover no-repeat`;
