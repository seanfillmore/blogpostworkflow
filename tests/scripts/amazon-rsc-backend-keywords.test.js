import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN, MAX_BYTES, main } from '../../scripts/amazon/apply-rsc-backend-keywords-2026-10-10.mjs';
import { PLAN as COPY_PLAN } from '../../scripts/amazon/remediate-rsc-listing-copy.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const words = (s) => s.toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, ' ').split(/\s+/).filter(Boolean);
const BRANDS = /\b(native|dove|secret|degree|crystal|schmidt|lume|tom|toms|sensodyne|crest|colgate|hello|cerave|aveeno|eucerin|vaseline|jergens|nivea|weleda|attitude|desert|kopari|boka|davids|risewell|alaffia|wild|carpe|vanicream)\b/;

test('covers the 11 SKUs rewritten on 2026-10-10', () => {
  assert.deepEqual(PLAN.map((e) => e.sku).sort(), COPY_PLAN.map((e) => e.sku).sort());
});

test('each value is under 250 bytes, has no duplicate words and no commas', () => {
  for (const e of PLAN) {
    const v = e.after.generic_keyword;
    assert.ok(Buffer.byteLength(v) <= MAX_BYTES, `${e.sku}: ${Buffer.byteLength(v)}`);
    assert.equal(new Set(words(v)).size, words(v).length, `${e.sku} repeats a word`);
    assert.doesNotMatch(v, /,/);
  }
});

test('no backend word repeats the listing title or bullets (Amazon already indexes those)', () => {
  for (const e of PLAN) {
    const copy = COPY_PLAN.find((c) => c.sku === e.sku).after;
    const visible = new Set(words([copy.item_name, ...copy.bullet_point].join(' ')));
    const dupes = words(e.after.generic_keyword).filter((w) => visible.has(w));
    assert.deepEqual(dupes, [], e.sku);
  }
});

test('operator and policy exclusions: no whitening, no brands, no false attributes, no claim words', () => {
  for (const e of PLAN) {
    const v = e.after.generic_keyword;
    assert.doesNotMatch(v, /whiten|stain|bleach/i, `${e.sku}: no basis for whitening (operator, 2026-10-10)`);
    assert.doesNotMatch(v, BRANDS, `${e.sku}: brand name`);
    assert.doesNotMatch(v, /xylitol|cruelty|scar|firming|eczema|antibacterial|cavit/i, e.sku);
    if (e.sku.startsWith('RSC-DE-')) assert.doesNotMatch(v, /unscented/, `${e.sku}: deodorants are scented`);
    assert.equal(checkSeoCopyFields({ keywords: v }).ok, true, e.sku);
  }
});

test('the demand that motivated this is indexed', () => {
  const by = (p) => PLAN.filter((e) => e.sku.startsWith(p)).map((e) => e.after.generic_keyword);
  for (const v of by('RSC-DE-')) assert.match(v, /\bmens\b.*desodorante sin aluminio mujer/);
  for (const v of by('RSC-TP-')) assert.match(v, /\bchildren\b/);
  for (const v of by('RSC-LO-')) assert.match(v, /\bwomen\b/);
});

test('preview by default; a value edited since capture is skipped', async () => {
  const calls = [];
  const spapi = {
    getClient: async () => ({}), getMarketplaceId: () => 'M',
    request: async (_c, method, path) => {
      calls.push({ method, path });
      if (method === 'PATCH') return { status: 'VALID', issues: [] };
      const sku = decodeURIComponent(path.split('/').pop());
      const e = PLAN.find((x) => x.sku === sku);
      const value = sku === 'RSC-DE-CL-02' ? 'edited by hand' : e.before.generic_keyword;
      return { summaries: [{ productType: 'X' }], attributes: { generic_keyword: [{ value, language_tag: 'en_US', marketplace_id: 'M' }] } };
    },
  };
  const r = await main({ spapi, argv: [], sellerId: 'S', outDir: mkdtempSync(join(tmpdir(), 'kw-')) });
  assert.equal(r.results.find((x) => x.sku === 'RSC-DE-CL-02').action, 'skip');
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, PLAN.length - 1);
  for (const p of patches) assert.match(p.path, /mode=VALIDATION_PREVIEW/);
});
