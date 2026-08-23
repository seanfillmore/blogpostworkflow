import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// agents/dashboard/public/js/dashboard.js is browser JS with no module system,
// so the two functions under test are lifted out by source and evaluated. Crude,
// but it pins a real crash rather than a paraphrase of one.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents/dashboard/public/js/dashboard.js'), 'utf8');

function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — did it get renamed?`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// eslint-disable-next-line no-new-func
const render = new Function(`${extract('esc')}\n${extract('renderPerformanceQueueCard')}\nreturn renderPerformanceQueueCard;`)();

// The exact shape agents/pdp-builder/index.js writes into
// data/performance-queue/: `type:` instead of `trigger:`, no `summary`, and a
// status the queue lifecycle does not define.
const PDP_ITEM = {
  slug: 'coconut-lotion',
  type: 'pdp-cluster',
  status: 'needs_rework',
  generated_at: '2026-08-01T00:00:00Z',
};

const REAL_ITEM = {
  slug: 'benefits-of-using-coconut-oil-lotion',
  title: 'Benefits Of Using Coconut Oil Lotion',
  trigger: 'quick-win',
  status: 'pending',
  summary: { what_changed: 'Tightened the intro.', why: 'Plain-language query.', projected_impact: 'CTR up from 0.17%.' },
};

test('a foreign-schema item does not take down the whole Optimization Queue', () => {
  // The defect: `i.summary.what_changed` with no guard threw inside .map(), so
  // ONE pdp-builder artifact blanked the card for all 21 real items.
  const html = render({ performanceQueue: [PDP_ITEM, REAL_ITEM] });
  assert.match(html, /Optimization Queue/);
  assert.match(html, /Benefits Of Using Coconut Oil Lotion/, 'the real item still renders');
  assert.match(html, /No summary recorded/, 'the foreign item renders a placeholder instead of throwing');
  assert.match(html, /pdp-cluster/, 'it falls back to `type` when there is no `trigger`');
});

test('a well-formed item renders all three summary rows unchanged', () => {
  const html = render({ performanceQueue: [REAL_ITEM] });
  assert.match(html, /What changed:<\/strong> Tightened the intro\./);
  assert.match(html, /Why:<\/strong> Plain-language query\./);
  assert.match(html, /Projected impact:<\/strong> CTR up from 0\.17%\./);
});

test('a partial summary renders the rows it has and omits the rest', () => {
  const html = render({ performanceQueue: [{ ...REAL_ITEM, summary: { what_changed: 'Only this.' } }] });
  assert.match(html, /Only this\./);
  assert.doesNotMatch(html, /Projected impact/);
});

test('an item with no title falls back to its slug rather than printing nothing', () => {
  const html = render({ performanceQueue: [{ slug: 'faqs', trigger: 'page-meta-rewrite', status: 'pending', summary: {} }] });
  assert.match(html, /faqs/);
});

test('an empty queue renders nothing at all', () => {
  assert.equal(render({ performanceQueue: [] }), '');
  assert.equal(render({}), '');
});
