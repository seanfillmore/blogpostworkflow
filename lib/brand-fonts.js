//
// The brand faces, inlined as @font-face CSS so a Puppeteer render never depends on a
// network font or a locally installed one. Extracted from scripts/render-frame.mjs so the
// ad-concepts typesetter sets copy in the same faces the PDP gallery frames use.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND_FONT_DIR = join(ROOT, 'data', 'brand', 'fonts');

export const BRAND_FACES = Object.freeze({
  'cabin-400.woff2': ['Cabin', 400], 'cabin-700.woff2': ['Cabin', 700],
  'outfit-300.woff2': ['Outfit', 300], 'outfit-400.woff2': ['Outfit', 400], 'outfit-600.woff2': ['Outfit', 600],
});

export function fontFaceCss({ fontDir = BRAND_FONT_DIR } = {}) {
  const present = readdirSync(fontDir).filter((f) => f.endsWith('.woff2'));
  const missing = Object.keys(BRAND_FACES).filter((f) => !present.includes(f));
  if (missing.length) throw new Error(`missing brand fonts in ${fontDir}: ${missing.join(', ')}`);
  return Object.entries(BRAND_FACES).map(([file, [family, weight]]) => {
    const b64 = readFileSync(join(fontDir, file)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;`
      + `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  }).join('\n');
}
