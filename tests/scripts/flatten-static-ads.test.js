import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { sizeDir, flatName, isRecordPath, flatten } from '../../scripts/flatten-static-ads.mjs';
import { libraryImageName } from '../../agents/ad-batch/output.js';

test('sizeDir: by real ratio', () => {
  assert.equal(sizeDir(1088, 1360), '4x5');
  assert.equal(sizeDir(1080, 1920), '9x16');
  assert.equal(sizeDir(1024, 1024), 'Other sizes');
});

test('flatName drops a lone generated file name and the 9x16 segment', () => {
  assert.equal(flatName('2026-11-09 Lotion', '03 What I Ordered/01-custom-01.png', { soleOfSize: true }), '2026-11-09 Lotion - 03 What I Ordered.png');
  assert.equal(flatName('2026-11-09 Lotion', '03 What I Ordered/9x16/01-custom-01.png', { soleOfSize: true }), '2026-11-09 Lotion - 03 What I Ordered.png');
  assert.equal(flatName('B', 'H/02-beach.png', { soleOfSize: false }), 'B - H - 02-beach.png');
  assert.equal(flatName('B', 'frame.jpg', { soleOfSize: true }), 'B - frame.jpg');
  assert.equal(isRecordPath('H/_rejected/x.png'), true);
  assert.equal(isRecordPath('H/_contact sheet.jpg'), true);
});

test('libraryImageName: one scene drops the index', () => {
  assert.equal(libraryImageName({ batchName: 'D P', conceptIndex: 2, concept: { headline: 'What I Ordered' }, sceneIndex: 0, sceneCount: 1 }), 'D P - 03 What I Ordered.png');
  assert.equal(libraryImageName({ batchName: 'D P', conceptIndex: 0, concept: { headline: 'H.' }, sceneIndex: 1, sceneCount: 4 }), 'D P - 01 H - 02.png');
});

test('flatten: moves ads by ratio, records intact, copy placed, run.json rewritten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flat-'));
  const b = join(root, 'Theme', '2026-11-09 Lotion');
  const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } }).png().toBuffer();
  mkdirSync(join(b, '01 H', '9x16'), { recursive: true }); mkdirSync(join(b, '01 H', '_rejected'), { recursive: true });
  writeFileSync(join(b, '01 H', '01-x.png'), await png(80, 100));
  writeFileSync(join(b, '01 H', '9x16', '01-x.png'), await png(90, 160));
  writeFileSync(join(b, '01 H', '_rejected', '01-y.png'), await png(80, 100));
  writeFileSync(join(b, 'meta-copy.md'), '# copy');
  writeFileSync(join(b, 'run.json'), JSON.stringify({ concepts: [{ dir: join(b, '01 H'), images: [{ file: join(b, '01 H', '01-x.png'), vertical: { file: join(b, '01 H', '9x16', '01-x.png') } }] }] }));
  const dry = await flatten(root, { log: () => {} });
  assert.equal(dry.images, 2);
  assert.ok(existsSync(join(b, '01 H', '01-x.png')), 'dry run moves nothing');
  await flatten(root, { apply: true, log: () => {} });
  const t = join(root, 'Theme');
  assert.deepEqual(readdirSync(join(t, '4x5')), ['2026-11-09 Lotion - 01 H.png']);
  assert.deepEqual(readdirSync(join(t, '9x16')), ['2026-11-09 Lotion - 01 H.png']);
  assert.ok(existsSync(join(t, 'Ad copy - 2026-11-09 Lotion.md')));
  assert.ok(existsSync(join(t, '_records', '2026-11-09 Lotion', '01 H', '_rejected', '01-y.png')));
  const run = JSON.parse(readFileSync(join(t, '_records', '2026-11-09 Lotion', 'run.json'), 'utf8'));
  assert.equal(run.concepts[0].images[0].file, join(t, '4x5', '2026-11-09 Lotion - 01 H.png'));
  assert.equal(run.concepts[0].images[0].vertical.file, join(t, '9x16', '2026-11-09 Lotion - 01 H.png'));
  assert.equal(run.concepts[0].dir, join(t, '_records', '2026-11-09 Lotion', '01 H'));
  const again = await flatten(root, { apply: true, log: () => {} });
  assert.equal(again.images, 0, 'idempotent');
});
