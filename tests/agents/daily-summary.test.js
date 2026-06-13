import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { previewBody } from '../../agents/daily-summary/index.js';

test('previewBody: empty or missing body returns empty string', () => {
  assert.equal(previewBody(''), '');
  assert.equal(previewBody(null), '');
  assert.equal(previewBody(undefined), '');
});

test('previewBody: short body is returned intact (trimmed)', () => {
  const body = '# Report\n**Run date:** June 12, 2026\nPosts refreshed: 1';
  assert.equal(previewBody(body), body);
});

test('previewBody: collapses runs of blank lines', () => {
  const body = 'line one\n\n\n\nline two';
  assert.equal(previewBody(body), 'line one\n\nline two');
});

test('previewBody: truncates to whole lines and appends an ellipsis', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const out = previewBody(lines.join('\n'), { maxLines: 8 });
  const outLines = out.split('\n');
  // never more than maxLines of content (ellipsis appended to the last kept line)
  assert.equal(outLines.length, 8);
  assert.ok(out.endsWith('…'), 'should signal truncation with an ellipsis');
  assert.ok(out.includes('line 8'));
  assert.ok(!out.includes('line 9'));
});

test('previewBody: never cuts a line in half (no partial trailing line)', () => {
  // the bug: a fixed pixel max-height clipped mid-line. The server-side preview
  // must only ever end on a complete line (optionally + " …"), never a fragment.
  const lines = Array.from({ length: 12 }, (_, i) => `Saved locally — "Title number ${i + 1} that is fairly long"`);
  const out = previewBody(lines.join('\n'), { maxLines: 8 });
  for (const l of out.replace(/ …$/, '').split('\n')) {
    // every retained line is one of the originals in full — no fragments
    assert.ok(/^Saved locally — "Title number \d+ that is fairly long"$/.test(l), `fragment: ${l}`);
  }
});

test('previewBody: enforces a character cap even within the line budget', () => {
  const huge = 'x'.repeat(2000);
  const out = previewBody(huge, { maxLines: 8, maxChars: 600 });
  assert.ok(out.length <= 602, `length ${out.length} should be capped`);
  assert.ok(out.endsWith('…'));
});

test('previewBody: keeps the "Saved locally" title line that was being clipped', () => {
  const body = [
    '# Content Refresh Report — Real Skin Care',
    '**Run date:** June 12, 2026',
    '**Mode:** Dry run',
    '**Posts refreshed:** 1',
    '',
    '---',
    '',
    '## 💡 Saved locally — "SLS-Free Toothpaste List: Best Natural Options 2026"',
  ].join('\n');
  const out = previewBody(body);
  assert.ok(out.includes('Best Natural Options 2026"'), 'the full title must survive truncation');
});
