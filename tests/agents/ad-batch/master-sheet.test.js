import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { collectCreatives, buildSheetHtml } from '../../../agents/ad-batch/master-sheet.js';

// A fake library: path -> children (dirs) or null (file).
function fakeFs(tree) {
  const kids = (p) => tree[p];
  return { list: (p) => Object.keys(kids(p) || {}), isDir: (p) => kids(p) !== null && kids(p) !== undefined && typeof kids(p) === 'object' };
}

function build(root, spec, out = {}) {
  out[root] = {};
  for (const [name, v] of Object.entries(spec)) {
    const p = join(root, name);
    out[root][name] = true;
    if (v && typeof v === 'object') build(p, v, out); else out[p] = null;
  }
  return out;
}

const ROOT = '/lib';
const tree = build(ROOT, {
  'Soft, Hydrated Skin': {
    '2026-10-01 Cream': { '01 Old headline': { '01-a.png': 1, '_contact sheet.jpg': 1, 'scenes.md': 1 } },
    '2026-11-02 Cream': {
      '01 New headline': { '02-b.png': 1, '01-a.png': 1, '_rejected': { '03-c.png': 1 } },
      'run.json': 1,
    },
  },
  '_New (to sort)': { '2026-11-01 Soap': { '01 X': { '01-a.jpg': 1 } } },
  'Empty': { 'notes.md': 1 },
  '_All Creatives.pdf': 1,
});

test('collectCreatives: skips _rejected, _-files and non-images; keeps _New; newest batch first', () => {
  const groups = collectCreatives(ROOT, fakeFs(tree));
  assert.deepEqual(groups.map(g => g.message), ['Soft, Hydrated Skin', '_New (to sort)']);
  const soft = groups[0].items.map(i => `${i.folder} | ${i.file}`);
  assert.deepEqual(soft, [
    '2026-11-02 Cream / 01 New headline | 01-a.png',
    '2026-11-02 Cream / 01 New headline | 02-b.png',
    '2026-10-01 Cream / 01 Old headline | 01-a.png',
  ]);
});

test('buildSheetHtml: captions every image with its folder and escapes names', () => {
  const groups = [{ message: 'A & B', items: [{ path: '/x.png', file: '<x>.png', folder: 'batch / head' }] }];
  const html = buildSheetHtml(groups, new Map([['/x.png', 'data:image/jpeg;base64,AA']]), { generatedAt: new Date('2026-11-02T00:00:00Z') });
  assert.match(html, /A &amp; B/);
  assert.match(html, /&lt;x&gt;\.png/);
  assert.match(html, /batch \/ head/);
  assert.match(html, /1 creatives in 1 message folders · generated 2026-11-02/);
});
