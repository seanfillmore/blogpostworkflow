import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_UA_PATTERNS,
  BURST_MIN_BEACONS,
  bucketKey,
  burstBuckets,
  classifyUserAgent,
  clientLabel,
  exclusionLine,
  partitionBeacons,
} from '../../lib/rum-bot.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const beacon = (over = {}) => ({
  ts: '2026-09-17T16:12:00.000Z',
  path: '/products/coconut-lotion',
  template: 'product',
  device: 'desktop',
  vw: 1366,
  bot: false,
  metrics: [{ name: 'TTFB', value: 300 }],
  ...over,
});

test('automation user agents are recognised', () => {
  for (const ua of [
    HEADLESS,
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36 Chrome-Lighthouse',
    'Mozilla/5.0 (X11; Linux x86_64) PhantomJS/2.1.1',
  ]) {
    assert.equal(classifyUserAgent(ua).bot, true, ua);
    assert.ok(classifyUserAgent(ua).reason, 'a bot verdict names a reason');
  }
});

test('ordinary browsers are never called bots', () => {
  for (const ua of [
    CHROME,
    IPHONE,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
  ]) {
    assert.equal(classifyUserAgent(ua).bot, false, ua);
  }
});

test('an absent user agent fails OPEN — unknown is not a bot', () => {
  for (const ua of [undefined, null, '', 0, {}]) {
    assert.deepEqual(classifyUserAgent(ua), { bot: false, reason: null });
  }
});

test('every automation pattern carries a reason string', () => {
  for (const p of AUTOMATION_UA_PATTERNS) {
    assert.ok(p.re instanceof RegExp);
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length);
  }
});

test('clientLabel keeps a coarse family and NEVER the raw agent or an IP', () => {
  assert.equal(clientLabel(CHROME), 'chrome/145');
  assert.equal(clientLabel(HEADLESS), 'headless/141');
  assert.equal(clientLabel(IPHONE), 'safari/17');
  assert.equal(clientLabel('Mozilla/5.0 Firefox/128.0'), 'firefox/128');
  assert.equal(clientLabel('something unparseable'), 'other');
  assert.equal(clientLabel(''), null);
  // The point of the label: it cannot reconstruct the agent it came from.
  assert.ok(!clientLabel(CHROME).includes('Macintosh'));
  assert.ok(clientLabel(CHROME).length <= 24);
});

test('bucketKey returns null for anything it cannot bucket, so it fails open', () => {
  assert.equal(bucketKey(beacon()), '1366|desktop|2026-09-17T16');
  assert.equal(bucketKey({ ...beacon(), ts: undefined }), null);
  assert.equal(bucketKey({ ...beacon(), vw: null }), null);
  assert.equal(bucketKey({ ...beacon(), ts: 'nonsense' }), null);
  assert.equal(bucketKey(null), null);
  assert.equal(bucketKey('a string'), null);
});

test('a burst is one viewport+device exceeding the floor within one UTC hour', () => {
  const sweep = Array.from({ length: BURST_MIN_BEACONS }, () => beacon());
  assert.equal(burstBuckets(sweep).size, 1);

  const justUnder = Array.from({ length: BURST_MIN_BEACONS - 1 }, () => beacon());
  assert.equal(burstBuckets(justUnder).size, 0, 'the floor is inclusive, and one below it is human');
});

test('the same volume spread across hours is NOT a burst', () => {
  const spread = Array.from({ length: BURST_MIN_BEACONS * 2 }, (_, i) =>
    beacon({ ts: `2026-09-17T${String(i % 24).padStart(2, '0')}:00:00.000Z` }));
  assert.equal(burstBuckets(spread).size, 0);
});

test('different viewports in one hour are counted separately', () => {
  const mixed = [
    ...Array.from({ length: 30 }, () => beacon({ vw: 1366 })),
    ...Array.from({ length: 30 }, () => beacon({ vw: 1920 })),
  ];
  assert.equal(burstBuckets(mixed).size, 0, 'two ordinary cohorts are not one sweep');
});

test('partitionBeacons splits on the UA flag and on bursts, and names both', () => {
  const list = [
    beacon(),
    beacon({ bot: true, botReason: 'headless-chrome' }),
    ...Array.from({ length: BURST_MIN_BEACONS }, () => beacon({ vw: 800, ts: '2026-09-15T04:30:00.000Z' })),
  ];
  const split = partitionBeacons(list);
  assert.equal(split.human.length, 1);
  assert.equal(split.machine.length, BURST_MIN_BEACONS + 1);
  assert.equal(split.reasons['headless-chrome'], 1);
  assert.equal(split.reasons.burst, BURST_MIN_BEACONS);
  assert.equal(split.bursts[0].views, BURST_MIN_BEACONS);
});

test('a beacon predating the bot flag is treated as human, not as a bot', () => {
  // Every beacon written before this shipped has no `bot` key at all.
  const legacy = { ts: '2026-09-01T10:00:00.000Z', path: '/', device: 'mobile', vw: 390, metrics: [] };
  const split = partitionBeacons([legacy]);
  assert.equal(split.human.length, 1);
  assert.equal(split.machine.length, 0);
});

test('partitionBeacons never throws on junk and never mutates its input', () => {
  const input = [null, undefined, 'x', 42, beacon()];
  const frozen = JSON.stringify(input);
  const split = partitionBeacons(input);
  assert.equal(split.human.length + split.machine.length, input.length);
  assert.equal(JSON.stringify(input), frozen);
  assert.deepEqual(partitionBeacons(undefined).human, []);
  assert.deepEqual(partitionBeacons('not an array').machine, []);
});

test('exclusionLine states the filter did nothing when it did nothing', () => {
  const line = exclusionLine(partitionBeacons([beacon(), beacon()]));
  assert.match(line, /0 of 2 beacons excluded/);
});

test('exclusionLine names the count, the share and every reason', () => {
  const list = [
    beacon(),
    beacon({ bot: true, botReason: 'crawler' }),
    ...Array.from({ length: BURST_MIN_BEACONS }, () => beacon({ vw: 800, ts: '2026-09-15T05:00:00.000Z' })),
  ];
  const line = exclusionLine(partitionBeacons(list));
  assert.match(line, /crawler 1/);
  assert.match(line, new RegExp(`burst ${BURST_MIN_BEACONS}`));
  assert.match(line, /1 real-visitor beacons remain/);
  assert.match(line, /viewport-hour/);
});

test('the burst floor stays above the busiest hour a real audience produced', () => {
  // Measured 2026-09-18 over 45 days / 46,368 beacons: the site's median UTC
  // hour is 19 beacons ACROSS ALL viewports and its p75 is 37, while the largest
  // single viewport-hour that inspects as human is 39. A floor at or below that
  // starts discarding people; this test is what stops it drifting down.
  assert.ok(BURST_MIN_BEACONS > 39, 'floor must clear the largest human viewport-hour on record');
  assert.ok(BURST_MIN_BEACONS >= 2 * 19, 'floor is twice the whole site\'s median hour');
});
