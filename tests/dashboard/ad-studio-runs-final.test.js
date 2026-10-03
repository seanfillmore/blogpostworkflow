import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun } from '../../agents/dashboard/lib/ad-studio-runs.js';

test('a concepts run shows the typeset final as a trusted comp', () => {
  const root = mkdtempSync(join(tmpdir(), 'runs-'));
  const run = join(root, 'concepts-x'); const v = join(run, 'a', 'v1');
  mkdirSync(v, { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ kind: 'concepts', generatedAt: '2026-10-03', product: { handle: 'x', title: 'X' }, totals: {}, results: [], rejectedConcepts: [] }));
  writeFileSync(join(run, 'a', 'copy.json'), JSON.stringify({ zones: {}, claims: [] }));
  writeFileSync(join(v, 'meta-plate-take1-4x5.jpg'), 'x');
  writeFileSync(join(v, 'meta-final-take1-4x5.jpg'), 'x');
  writeFileSync(join(v, 'proof.json'), JSON.stringify({ 'meta-plate-take1-4x5.jpg': { ok: true, reasons: [] } }));
  const r = readRun(root, 'concepts-x');
  const t = r.concepts[0].variations[0].targets[0];
  assert.equal(t.comp, 'meta-final-take1-4x5.jpg');
  assert.equal(t.compTrusted, true);
  assert.equal(t.ratio, '4x5');
});
