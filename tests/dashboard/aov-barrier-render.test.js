import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// The Ads tab's "no viable campaigns" card. It used to render "Max CPC @ 2% CVR —
// long-tail threshold" and "@ 3% CVR — branded threshold": benchmark rates 3-4x the
// store's measured clean commercial CVR, so every CPC it quoted as affordable was
// 3-4x too high. It now renders break-even CPC at the MEASURED rate the analyzer
// wrote, and must still render the OLD barrier file (the one on the server is from
// 2026-04-25) without throwing — and without resurrecting its benchmark numbers.
//
// dashboard.js is browser JS with no module system, so the functions are lifted out
// by source, the same way tests/dashboard/queue-card-render.test.js does it.
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
const render = new Function(`${extract('esc')}\n${extract('renderAovBarrierHtml')}\nreturn renderAovBarrierHtml;`)();

// Byte-for-byte the barrier on production today.
const OLD_BARRIER = {
  date: '2026-04-25',
  aov: 46.95230769230769,
  minRoas: 0.85,
  breakEvenCpa: 55.24,
  breakEvenCpc: { at2pctCvr: 1.1, at3pctCvr: 1.66, at5pctCvr: 2.76 },
  proposalsAnalyzed: 2,
  proposalsSaved: 0,
  message: 'All 2 proposals rejected. At $46.95 AOV and 0.85x minimum ROAS, campaigns need CPC ≤ $1.10 at 2% CVR or ≤ $1.66 at 3% CVR. Most natural skincare keywords cost $0.80–$1.50 CPC. Consider increasing AOV via bundles or upsells.',
};

const NEW_BARRIER = {
  date: '2026-09-20',
  aov: 56.08,
  minRoas: 0.85,
  breakEvenCpa: 65.98,
  measuredCvr: {
    basis: 'clean US shoppable commercial traffic',
    window: { start: '2026-08-04', end: '2026-09-18' },
    orders: 4, sessions: 567, point: 4 / 567, lower: 0.0027467, upper: 0.0179974, interval: '95% Wilson',
  },
  breakEvenCpcMeasured: { atPoint: 0.47, atLower: 0.18, atUpper: 1.19 },
  proposalsAnalyzed: 3,
  proposalsSaved: 0,
  message: 'All 3 proposals rejected.',
};

test('a NEW barrier renders break-even CPC at the measured CVR, with its sample and window', () => {
  const html = render(NEW_BARRIER);
  assert.match(html, /\$0\.47/);
  assert.match(html, /\$0\.18/);
  assert.match(html, /\$1\.19/);
  assert.match(html, /0\.71%/);
  assert.match(html, /4 orders \/ 567 sessions/);
  assert.match(html, /2026-08-04/);
  assert.doesNotMatch(html, /2% CVR|3% CVR|8–15%/);
});

test('an OLD barrier renders without throwing and does not quote its benchmark thresholds', () => {
  const html = render(OLD_BARRIER);
  assert.match(html, /No viable campaigns/);
  assert.match(html, /\$46\.95/);
  assert.match(html, /not measured/i);
  assert.doesNotMatch(html, /Max CPC @ 2% CVR|Max CPC @ 3% CVR|long-tail threshold|branded threshold/);
  assert.doesNotMatch(html, /\$1\.10|\$1\.66/);
});

test('a barrier missing even the AOV still renders rather than blanking the Ads tab', () => {
  assert.doesNotThrow(() => render({ message: 'x' }));
});

test('the rendering site calls the helper instead of hardcoding benchmark thresholds', () => {
  assert.match(SRC, /renderAovBarrierHtml\(aovBarrier\)/);
  assert.doesNotMatch(SRC, /Max CPC @ 2% CVR/);
});
