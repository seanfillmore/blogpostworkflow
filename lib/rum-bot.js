/**
 * Tell a real visitor's Core Web Vitals beacon from a machine's.
 *
 * WHY THIS EXISTS. RUM is this project's field truth for speed — CLAUDE.md sends
 * every perf decision here rather than to lab PageSpeed. Measured on 2026-09-18
 * over the trailing 14 days, **47% of the beacons were machines**, and they are
 * not a uniform tax: bots are desktop-shaped and slow, so they landed almost
 * entirely on the desktop figures. Unfiltered, desktop TTFB p75 read **1488ms**;
 * with the machines removed the same window reads **845ms**. The fleet spent a
 * session investigating a server-response problem that belonged to a bot farm.
 *
 * TWO SIGNALS, deliberately different in character:
 *
 * 1. THE USER AGENT, stamped at ingest (`bot: true` on the stored record). This
 *    is precise and has no false positives — a string saying `HeadlessChrome` is
 *    not a customer. It is also easily evaded, and was: the 2026-09-17 wave sent
 *    an ordinary `Chrome/145` UA.
 *
 * 2. A BURST OF VIEWS FROM ONE VIEWPORT IN ONE HOUR, applied here at aggregation
 *    time because no single beacon can see it. The 2026-09-15 giveaway-entry wave
 *    (2,948 disqualified entries — see the giveaway fraud record) and the
 *    2026-09-17 product sweep were both **hundreds of distinct IPs sharing one
 *    user agent**, 2 beacons apiece. Per-request rate limiting cannot see that
 *    shape; an hourly bucket can.
 *
 * THE THRESHOLD IS DERIVED, NOT PICKED. Measured across 45 days / 46,368 beacons:
 * the WHOLE SITE's median UTC hour is **19 beacons** across every viewport, p75 is
 * 37. So `BURST_MIN_BEACONS = 50` means one screen size alone out-producing the
 * entire site's median hour by 2.6x, which no real audience of ~33 sessions/day
 * does. The largest bucket that looks human on inspection (several distinct paths,
 * ordinary phone or laptop width) is 39. Every one of the 18 buckets at or above
 * 50 in those 45 days sits inside a visible sweep. There is NO clean gap in the
 * distribution — it is continuous from 39 upward — so this boundary is a judgement
 * backed by a rate, and lowering it starts discarding plausible people.
 *
 * IT FAILS OPEN, ALWAYS. A beacon with no timestamp, no viewport or an unreadable
 * shape is counted as HUMAN. The dangerous direction here is not "a bot got in" —
 * that only dilutes a percentile — it is silently deleting real visitors until the
 * site looks faster than it is, which is the one outcome a speed metric must never
 * produce. Same doctrine as `PRODUCT_NOUNS` in lib/product-category-terms.js:
 * unknown means allow.
 *
 * NOTHING HERE DROPS DATA. The raw beacon is stored either way; this module only
 * decides which rows a percentile is computed over, and every caller reports the
 * excluded count rather than quietly shrinking its n.
 */

/**
 * User-agent tokens that name an automated client outright. Each is a statement
 * about the CLIENT, never about behaviour — a slow human is not a bot.
 */
export const AUTOMATION_UA_PATTERNS = [
  { re: /HeadlessChrome/i, reason: 'headless-chrome' },
  { re: /\bPhantomJS\b/i, reason: 'phantomjs' },
  { re: /\bPuppeteer\b/i, reason: 'puppeteer' },
  { re: /\bPlaywright\b/i, reason: 'playwright' },
  { re: /\bSelenium\b|WebDriver/i, reason: 'webdriver' },
  { re: /Chrome-Lighthouse|\bLighthouse\b|PageSpeed|GTmetrix|Pingdom/i, reason: 'synthetic-monitor' },
  { re: /\bbot\b|\bbots\b|spider|crawler|Slurp|Bytespider/i, reason: 'crawler' },
  { re: /curl\/|\bwget\b|python-requests|aiohttp|axios\/|node-fetch|Go-http-client|okhttp|Java\//i, reason: 'http-client' },
];

/** One viewport+device producing this many views in a single UTC hour is a sweep. */
export const BURST_MIN_BEACONS = 50;

/**
 * Classify a user agent. Returns `{ bot, reason }`; an absent or empty UA is NOT
 * called a bot — plenty of privacy tooling strips it, and see the fail-open rule.
 */
export function classifyUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return { bot: false, reason: null };
  for (const { re, reason } of AUTOMATION_UA_PATTERNS) {
    if (re.test(ua)) return { bot: true, reason };
  }
  return { bot: false, reason: null };
}

/**
 * A coarse client label — browser family plus major version, e.g. `chrome/152`.
 *
 * Stored INSTEAD OF the raw user agent, and no IP is stored at all: these files
 * are archived offsite weekly, so the same rule applies as to the Shopify order
 * snapshots, which carry a product title but never a `sku` or buyer-typed
 * `properties`. A family label is enough to recognise a farm sharing one spoofed
 * UA after the fact; it is not enough to identify a person.
 */
export function clientLabel(ua) {
  if (typeof ua !== 'string' || !ua) return null;
  const m = ua.match(/(HeadlessChrome|Edg|OPR|Chrome|Firefox|Version|Safari)\/(\d+)/);
  if (!m) return 'other';
  const family = { Edg: 'edge', OPR: 'opera', Version: 'safari', HeadlessChrome: 'headless' }[m[1]]
    || m[1].toLowerCase();
  return `${family}/${m[2]}`.slice(0, 24);
}

/** `<viewport>|<device>|<UTC hour>`, or null when the beacon cannot be bucketed. */
export function bucketKey(beacon) {
  if (!beacon || typeof beacon !== 'object') return null;
  const ts = typeof beacon.ts === 'string' ? beacon.ts.slice(0, 13) : null;
  if (!ts || ts.length !== 13) return null;
  if (!Number.isFinite(beacon.vw)) return null;
  return `${beacon.vw}|${beacon.device || 'unknown'}|${ts}`;
}

/** Bucket keys whose view count reaches the burst floor. */
export function burstBuckets(beacons, { min = BURST_MIN_BEACONS } = {}) {
  const counts = new Map();
  for (const b of beacons || []) {
    const key = bucketKey(b);
    if (key == null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = new Map();
  for (const [key, n] of counts) if (n >= min) out.set(key, n);
  return out;
}

/**
 * Split beacons into the ones a percentile should be computed over and the ones
 * it should not. Never throws, never mutates, and anything it cannot judge is
 * returned as human.
 */
export function partitionBeacons(beacons, { min = BURST_MIN_BEACONS } = {}) {
  const list = Array.isArray(beacons) ? beacons : [];
  const bursts = burstBuckets(list, { min });

  const human = [];
  const machine = [];
  const reasons = {};
  const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };

  for (const b of list) {
    const uaBot = b?.bot === true;
    const key = bucketKey(b);
    const inBurst = key != null && bursts.has(key);
    if (uaBot) {
      bump(b.botReason || 'automation-ua');
      machine.push(b);
    } else if (inBurst) {
      bump('burst');
      machine.push(b);
    } else {
      human.push(b);
    }
  }

  return {
    human,
    machine,
    reasons,
    bursts: [...bursts.entries()]
      .map(([key, views]) => ({ key, views }))
      .sort((a, b) => b.views - a.views),
    min,
  };
}

/** One line for a report or digest body, naming what was withheld and why. */
export function exclusionLine({ human, machine, reasons, bursts, min }) {
  const total = human.length + machine.length;
  if (!machine.length) {
    return `Bot filter: 0 of ${total} beacons excluded — all figures are from real visitors.`;
  }
  const why = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${n}`)
    .join(', ');
  const pct = ((100 * machine.length) / total).toFixed(1);
  return `Bot filter: **${machine.length} of ${total} beacons (${pct}%) excluded as machine traffic** `
    + `(${why}); ${human.length} real-visitor beacons remain. `
    + `${bursts.length} viewport-hour(s) exceeded ${min} views.`;
}
