import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fontFaceCss, BRAND_FACES, BRAND_FONT_DIR } from '../../lib/brand-fonts.js';

test('inlines every brand face from the real font directory', () => {
  const css = fontFaceCss();
  for (const [, [family, weight]] of Object.entries(BRAND_FACES)) {
    assert.match(css, new RegExp(`font-family:'${family}';font-weight:${weight}`));
  }
  assert.match(css, /src:url\(data:font\/woff2;base64,/);
  assert.ok(BRAND_FONT_DIR.endsWith(join('data', 'brand', 'fonts')));
});

test('throws naming the missing files when a face is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fonts-'));
  writeFileSync(join(dir, 'cabin-400.woff2'), 'x');
  assert.throws(() => fontFaceCss({ fontDir: dir }), /missing brand fonts.*cabin-700\.woff2/);
});
