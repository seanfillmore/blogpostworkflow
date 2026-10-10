import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN, ARTICLES, SUMMARY, decideSummary, main } from '../../scripts/remediate-whitening-claims-2026-10-10.mjs';
import { PLAN as AMZ, B3_BEFORE, B3_AFTER } from '../../scripts/amazon/remove-toothpaste-stain-claim-2026-10-10.mjs';
import { gateEntry } from '../../scripts/remediate-toothpaste-safety-claims.mjs';

const WHITE = /whiten|\bstains?\b|bleach|whiter|brighter/i;

test('every BEFORE carried a whitening or drug-property claim; no AFTER does', () => {
  for (const e of PLAN) {
    assert.ok(WHITE.test(e.before) || /antimicrobial|active ingredients/.test(e.before), `${e.id}: precondition`);
    assert.doesNotMatch(e.after.replace(/not a whitening product/, ''), /whiten|stain removal|antimicrobial|active ingredients/i, e.id);
    assert.deepEqual(gateEntry(e), [], e.id);
    assert.ok(ARTICLES[e.handle], e.id);
    assert.doesNotMatch(e.after, /—/);
  }
  assert.match(SUMMARY.before, /whiten/);
  assert.doesNotMatch(SUMMARY.after, /whiten|protect|—/);
});

test('the Amazon bullet: only "lifts surface stains" goes, on all three toothpastes', () => {
  assert.equal(AMZ.length, 3);
  assert.match(B3_BEFORE, /lifts surface stains/);
  assert.doesNotMatch(B3_AFTER, WHITE);
  for (const e of AMZ) {
    assert.equal(e.before.bullet_point[2], B3_BEFORE);
    assert.equal(e.after.bullet_point[2], B3_AFTER);
    [0, 1, 3, 4].forEach((i) => assert.equal(e.after.bullet_point[i], e.before.bullet_point[i]));
  }
});

test('excerpt: apply on BEFORE, no-op on AFTER, skip on anything else', () => {
  assert.equal(decideSummary(SUMMARY.before).action, 'apply');
  assert.equal(decideSummary(SUMMARY.after).action, 'already-applied');
  assert.equal(decideSummary('edited by hand').action, 'skip');
});

test('apply writes bodies and the excerpt once, verified, and is idempotent', async () => {
  const bodies = {}; const summaries = { [SUMMARY.articleId]: SUMMARY.before };
  for (const [h, a] of Object.entries(ARTICLES)) bodies[a.articleId] = PLAN.filter((e) => e.handle === h).map((e) => `<p>${e.before}</p>`).join('\n');
  const mk = () => { const c = { n: 0 }; return { c, api: {
    getArticle: async (_b, id) => ({ body_html: bodies[id], summary_html: summaries[id] }),
    updateArticle: async (_b, id, f) => { c.n += 1; if (f.body_html) bodies[id] = f.body_html; if (f.summary_html) summaries[id] = f.summary_html; return {}; },
  } }; };
  const root = mkdtempSync(join(tmpdir(), 'wh-'));
  const wet = mk(); await main({ shopify: wet.api, argv: ['--apply'], root, log: () => {} });
  assert.equal(wet.c.n, Object.keys(ARTICLES).length + 1);
  assert.equal(summaries[SUMMARY.articleId], SUMMARY.after);
  const again = mk(); await main({ shopify: again.api, argv: ['--apply'], root, log: () => {} });
  assert.equal(again.c.n, 0);
});
