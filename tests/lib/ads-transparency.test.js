import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShownDate, daysRunning, isRecentlyShown, unescapePreviewJs,
  decodePla, extractPreviewMedia, normaliseAd, sortByLongevity,
} from '../../lib/ads-transparency.js';

// Build a pla= payload the way Google does: flat length-delimited strings.
function pla(fields) {
  const parts = [];
  for (const [num, str] of Object.entries(fields)) {
    const b = Buffer.from(str, 'utf8');
    const len = [];
    let n = b.length;
    do { let c = n & 0x7f; n >>= 7; if (n) c |= 0x80; len.push(c); } while (n);
    parts.push(Buffer.from([(Number(num) << 3) | 2, ...len]), b);
  }
  return Buffer.concat(parts).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('parses DataForSEO date stamps', () => {
  assert.equal(parseShownDate('2024-01-29 08:00:00 +00:00').toISOString(), '2024-01-29T08:00:00.000Z');
  assert.equal(parseShownDate(null), null);
  assert.equal(parseShownDate('garbage'), null);
});

test('days running is null, not 0, when a date is unreadable', () => {
  assert.equal(daysRunning('2024-01-29 08:00:00 +00:00', '2026-10-20 22:47:21 +00:00'), 996);
  assert.equal(daysRunning('2024-01-29 08:00:00 +00:00', null), null);
});

test('live means shown within the last week', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  assert.equal(isRecentlyShown('2026-10-20 22:47:21 +00:00', { now }), true);
  assert.equal(isRecentlyShown('2026-02-25 14:40:12 +00:00', { now }), false);
});

test('unescapes the encodings content.js uses', () => {
  assert.equal(unescapePreviewJs('q\\x3dtbn:A\\x26b'), 'q=tbn:A&b');
  assert.equal(unescapePreviewJs('q\\\\u003dtbn'), 'q=tbn');
  assert.equal(unescapePreviewJs('https:\\/\\/x'), 'https://x');
});

test('decodes a Shopping payload into image, title and merchant', () => {
  const b64 = pla({ 1: 'https://encrypted-tbn2.gstatic.com/shopping?q=tbn:ABC', 2: 'Natural Deodorant Cream 3 Pack', 3: 'PiperWai', 4: 'Google' });
  assert.deepEqual(decodePla(b64), {
    image: 'https://encrypted-tbn2.gstatic.com/shopping?q=tbn:ABC',
    title: 'Natural Deodorant Cream 3 Pack',
    merchant: 'PiperWai',
  });
  assert.equal(decodePla(''), null);
});

test('extracts YouTube ids from a video preview', () => {
  const js = 'x="https:\\/\\/i.ytimg.com\\/vi\\/S1k6RVYUP3E\\/hqdefault.jpg";y="https://i.ytimg.com/vi/S1k6RVYUP3E/hqdefault.jpg"';
  assert.deepEqual(extractPreviewMedia(js).youtubeIds, ['S1k6RVYUP3E']);
});

test('extracts a Shopping ad and does not repeat its photo as a loose image', () => {
  const img = 'https://encrypted-tbn2.gstatic.com/shopping?q=tbn:ANd9GcQH';
  const b64 = pla({ 1: img, 2: 'Wellnesse Toothpaste 4 Pack', 3: 'Wellnesse' });
  const js = `a="https://ads-rendering-prod.corp.google.com/pla?hl%3Den%26pla%3D${b64}";b="${img.replace('=', '\\x3d')}"`;
  const m = extractPreviewMedia(js);
  assert.equal(m.shopping.length, 1);
  assert.equal(m.shopping[0].title, 'Wellnesse Toothpaste 4 Pack');
  assert.deepEqual(m.images, []);
});

test('extracts display banner and image-extension URLs', () => {
  const js = 'a="//tpc.googlesyndication.com/simgad/12145999361270273879";b="url(https://encrypted-tbn1.gstatic.com/images?q\\x3dtbn:ANd9GcQ0q);"';
  assert.deepEqual(extractPreviewMedia(js).images, [
    'https://tpc.googlesyndication.com/simgad/12145999361270273879',
    'https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcQ0q',
  ]);
});

test('normalises a row and sorts longest-running first, unknown last', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const rows = [
    { title: 'A', format: 'text', first_shown: '2026-09-01 00:00:00 +00:00', last_shown: '2026-10-20 00:00:00 +00:00' },
    { title: 'B', format: 'video', first_shown: null, last_shown: '2026-10-20 00:00:00 +00:00' },
    { title: 'C', format: 'image', first_shown: '2024-01-01 00:00:00 +00:00', last_shown: '2026-10-20 00:00:00 +00:00', preview_image: { url: 'https://tpc.googlesyndication.com/archive/simgad/1' } },
  ].map((r) => normaliseAd(r, { now }));
  assert.equal(rows[2].previewImage, 'https://tpc.googlesyndication.com/archive/simgad/1');
  assert.equal(rows[0].live, true);
  assert.deepEqual(sortByLongevity(rows).map((r) => r.advertiser), ['C', 'A', 'B']);
});
