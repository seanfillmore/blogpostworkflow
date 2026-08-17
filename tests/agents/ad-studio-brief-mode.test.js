import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, buildRunReport } from '../../agents/ad-studio/index.js';
import { writeBrief, readBrief } from '../../lib/ad-brief.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-studio-brief-'));

test('--brief is parsed and is absent by default', () => {
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--formats', 'manifesto']).brief, null);
  assert.equal(parseArgs(['--brief', 'coconut-lotion-p1a1-123']).brief, 'coconut-lotion-p1a1-123');
});

// In brief mode the brief supplies the product AND the format, so demanding them again
// would make the operator restate what they already approved — and let the two disagree.
test('--brief mode does not require --product or --formats', () => {
  assert.doesNotThrow(() => parseArgs(['--brief', 'coconut-lotion-p1a1-123']));
});

test('a brief id with a path separator is refused at parse time', () => {
  assert.throws(() => parseArgs(['--brief', '../escape']), /brief/i);
});

// ── attribution ─────────────────────────────────────────────────────────────────────
//
// THE POINT OF THIS TASK. These fields cannot be reconstructed after an ad has run.

test('buildRunReport carries attribution onto every artifact row', () => {
  const attribution = {
    briefId: 'coconut-lotion-p1a1-123', personaId: 'p1', angleId: 'p1a1',
    awareness: 'problem-aware', format: 'problem-aware',
  };
  const report = buildRunReport({
    runId: 'r1',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    attribution,
    results: [{
      conceptSlug: 'problem-aware', format: 'problem-aware',
      variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-1x1.png', ok: true, errored: false, score: 4 }] }],
    }],
    renders: 2,
  });
  assert.deepEqual(report.attribution, attribution);
  const row = report.results[0].variations[0].artifacts[0];
  assert.equal(row.attribution.angleId, 'p1a1', 'each artifact must carry its own attribution');
  assert.equal(row.attribution.awareness, 'problem-aware');
});

// A run launched the old way must still work and must say so, rather than carrying a
// half-filled attribution that looks like data.
test('a run with no brief reports attribution as null, not a stub', () => {
  const report = buildRunReport({
    runId: 'r1', product: { handle: 'coconut-lotion' },
    results: [{ conceptSlug: 'manifesto', format: 'manifesto', variations: [{ n: 1, ok: true, artifacts: [] }] }],
    renders: 0,
  });
  assert.equal(report.attribution, null);
});

test('an approved brief round-trips through the store for rendering', () => {
  const root = freshRoot();
  writeBrief(root, {
    briefId: 'coconut-lotion-p1a1-123', product: 'coconut-lotion', state: 'approved',
    zones: { headline: 'A real headline' }, claims: [],
    format: { proposed: 'problem-aware', chosen: null },
    persona: { id: 'p1' }, angle: { id: 'p1a1', awareness: 'problem-aware' },
    gates: { health: { ok: true }, claims: { ok: true } },
  });
  const b = readBrief(root, 'coconut-lotion', 'coconut-lotion-p1a1-123');
  assert.equal(b.state, 'approved');
  assert.equal(b.zones.headline, 'A real headline');
});
