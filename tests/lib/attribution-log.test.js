import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAttribution, readAttribution } from '../../lib/attribution-log.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'attr-'));
  return { path: join(dir, 'attribution.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('appendAttribution creates the file and writes one line per record', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([
      { ts: 't1', date: '2026-06-14', slug: 'a', keyword: 'a', signal_type: 'unmapped', strength: 5000, score: 40, action: 'inject', cluster: null },
      { ts: 't1', date: '2026-06-14', slug: 'b', keyword: 'b', signal_type: 'rank_drop', strength: 8, score: 24, action: 'promote', cluster: 'deodorant' },
    ], { path });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).slug, 'a');
  } finally { cleanup(); }
});

test('appendAttribution appends (does not overwrite) on a second call', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([{ slug: 'a', signal_type: 'unmapped' }], { path });
    appendAttribution([{ slug: 'b', signal_type: 'ai_gap' }], { path });
    assert.equal(readAttribution(path).length, 2);
  } finally { cleanup(); }
});

test('appendAttribution with empty array writes nothing / no error', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([], { path });
    assert.deepEqual(readAttribution(path), []);
  } finally { cleanup(); }
});

test('readAttribution returns [] for a missing file and skips malformed lines', () => {
  const { path, cleanup } = tmpFile();
  try {
    assert.deepEqual(readAttribution(join(path, 'nope.jsonl')), []);
    writeFileSync(path, '{"slug":"ok"}\nNOT JSON\n{"slug":"ok2"}\n');
    assert.deepEqual(readAttribution(path).map((r) => r.slug), ['ok', 'ok2']);
  } finally { cleanup(); }
});
