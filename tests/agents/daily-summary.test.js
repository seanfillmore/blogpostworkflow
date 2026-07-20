import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { previewBody, formatBodyHtml, buildDigestHtml } from '../../agents/daily-summary/index.js';

// ── buildDigestHtml: lean, revenue-first digest (only needle-movers) ──────────

test('buildDigestHtml: surfaces revenue + failures, drops the routine listing', () => {
  const entries = [
    { subject: 'Content Refresh completed', status: 'success', ts: '2026-07-20T22:00:00Z', body: 'refreshed 1 post' },
    { subject: 'Publisher failed', status: 'error', ts: '2026-07-20T22:01:00Z', body: 'Shopify API 404' },
    { subject: 'Image Generator completed', status: 'success', ts: '2026-07-20T22:02:00Z' },
  ];
  const seoImpact = {
    totals: { organic_revenue: 157, organic_revenue_delta: -20, organic_conversions: 27 },
    window: { start: '2026-06-21', end: '2026-07-18' },
    top_revenue: [{ revenue: 132, path: '/', conversions: 5, sessions: 45 }],
  };
  const html = buildDigestHtml('2026-07-20', entries, [], [], null, null, null, null, [], 'https://dash', [], seoImpact, null);

  assert.ok(html.includes('Organic Revenue'), 'revenue block shown');
  assert.ok(html.includes('$157'), 'revenue number shown');
  assert.ok(html.includes('Publisher failed'), 'error surfaced');
  assert.ok(html.includes('Failures'), 'failures section present');
  // routine successes are collapsed, not listed
  assert.ok(!html.includes('Content Pipeline'), 'no verbose pipeline section');
  assert.ok(!html.includes('Image Generator completed'), 'routine success not individually listed');
  // single activity line replaces the full listing
  assert.ok(/3 tasks ran/.test(html), 'footer shows task count');
  assert.ok(html.includes('1 error'), 'footer shows error count');
});

test('buildDigestHtml: quiet day collapses to a single "nothing moved" line', () => {
  const entries = [{ subject: 'Rank Tracker completed', status: 'success', ts: '2026-07-20T22:00:00Z' }];
  const html = buildDigestHtml('2026-07-20', entries, [], [], null, null, null, null, [], 'https://dash', [], null, null);
  assert.ok(html.includes('Nothing moved the needle'), 'quiet-day message shown');
  assert.ok(/1 task ran/.test(html), 'activity line still present');
});

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

test('previewBody: drops markdown horizontal-rule lines', () => {
  assert.equal(previewBody('above\n---\nbelow'), 'above\nbelow');
  assert.equal(previewBody('above\n***\nbelow'), 'above\nbelow');
});

// ── formatBodyHtml: markdown noise → clean inline HTML ─────────────────────────

test('formatBodyHtml: converts **bold** to <strong>', () => {
  assert.equal(formatBodyHtml('**Run date:** June 12'), '<strong>Run date:</strong> June 12');
});

test('formatBodyHtml: turns markdown headings into bold, dropping the # markers', () => {
  assert.equal(formatBodyHtml('# Content Refresh Report'), '<strong>Content Refresh Report</strong>');
  assert.equal(formatBodyHtml('## 💡 Saved locally — "X"'), '<strong>💡 Saved locally — "X"</strong>');
});

test('formatBodyHtml: converts list markers to bullets', () => {
  assert.equal(formatBodyHtml('- first\n- second'), '• first\n• second');
});

test('formatBodyHtml: escapes HTML in the body (no injection)', () => {
  assert.equal(formatBodyHtml('a <script>alert(1)</script> b'), 'a &lt;script&gt;alert(1)&lt;/script&gt; b');
});

test('formatBodyHtml: strips a stray unmatched ** rather than leaving it raw', () => {
  assert.equal(formatBodyHtml('**oops unmatched'), 'oops unmatched');
});

test('formatBodyHtml: preserves line breaks (caller renders with pre-wrap)', () => {
  const out = formatBodyHtml('# Title\n**Mode:** Dry run');
  assert.equal(out, '<strong>Title</strong>\n<strong>Mode:</strong> Dry run');
});

test('formatBodyHtml: empty input returns empty string', () => {
  assert.equal(formatBodyHtml(''), '');
  assert.equal(formatBodyHtml(null), '');
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
