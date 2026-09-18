import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewBody, formatBodyHtml, buildDigestHtml, log } from '../../agents/daily-summary/index.js';

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
  const html = buildDigestHtml('2026-07-20', entries, [], [], null, null, null, null, 'https://dash', [], seoImpact, null);

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

// ── the digest's cluster line names a CATEGORY, so it prints category sales ───

const CLUSTER_DIGEST = {
  totals: { organic_revenue: 540.08, organic_revenue_delta: 357.9, organic_conversions: 8 },
  window: { start: '2026-07-25', end: '2026-08-21' },
  top_revenue: [],
  clusters: [
    {
      cluster: 'lotion', entry_page_organic_revenue: 313.49, revenue: 313.49,
      product_organic_revenue: 357, product_revenue_all_channels: 755.3,
    },
    {
      cluster: 'soap', entry_page_organic_revenue: 62.4, revenue: 62.4,
      product_organic_revenue: 62.4, product_revenue_all_channels: 123.5,
    },
  ],
};

test('the digest prints what each category sold, not what landed on pages named after it', () => {
  const html = buildDigestHtml('2026-08-22', [], [], [], null, null, null, null, 'https://dash', [], CLUSTER_DIGEST, null, { dataRoot: emptyRoot });
  assert.ok(html.includes('Sold by category'), 'the label says which question it answers');
  assert.ok(html.includes('$755.30'), 'all-channel product revenue shown');
  assert.ok(html.includes('$357.00'), 'organic product revenue shown');
});

test('a report written before product attribution still renders its old cluster line', () => {
  const legacy = {
    ...CLUSTER_DIGEST,
    clusters: CLUSTER_DIGEST.clusters.map(({
      product_organic_revenue, product_revenue_all_channels, ...c
    }) => c),
  };
  const html = buildDigestHtml('2026-08-22', [], [], [], null, null, null, null, 'https://dash', [], legacy, null, { dataRoot: emptyRoot });
  assert.ok(html.includes('By cluster (entry-page organic)'), 'labelled as the entry-page view');
  assert.ok(html.includes('$313.49'));
  assert.ok(!html.includes('Sold by category'));
});

// buildDigestHtml takes 12 injected arguments but ALSO read five paths off disk
// under the repo root. That made it machine-dependent: this test passed on a laptop
// with no data/reports and failed on the server, where those files exist — the same
// inputs producing different HTML. dataRoot makes the last five inputs injectable
// like the other twelve, so both directions below are pinned on any machine.
const emptyRoot = mkdtempSync(join(tmpdir(), 'digest-empty-'));

test('buildDigestHtml: quiet day collapses to a single "nothing moved" line', () => {
  const entries = [{ subject: 'Rank Tracker completed', status: 'success', ts: '2026-07-20T22:00:00Z' }];
  const html = buildDigestHtml('2026-07-20', entries, [], [], null, null, null, null, 'https://dash', [], null, null, { dataRoot: emptyRoot });
  assert.ok(html.includes('Nothing moved the needle'), 'quiet-day message shown');
  assert.ok(/1 task ran/.test(html), 'activity line still present');
});

// THE LLM COST BLOCK WAS REMOVED 2026-09-08, on the operator's instruction: the
// fleet moved off per-token API billing onto the monthly subscription, so agent run
// cost no longer constrains any decision. This test used to assert the block
// RENDERED; it now asserts it does not, so the section cannot be reinstated without
// somebody deliberately deleting this.
//
// Its last real appearance was also a false alarm, which is why nobody should miss
// it: the 2026-09-07 digest warned "$34.03/wk ⚠️ over $20 target" when $11.54 of the
// $17.19 day was ONE hand-run local script. A budget line that counts a human's
// ad-hoc run against an unattended-fleet target cannot be read correctly.
test('buildDigestHtml: the LLM cost block is gone, even with over-budget spend on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-cost-'));
  const usage = join(root, 'data', 'reports', 'llm-usage');
  mkdirSync(usage, { recursive: true });
  const rec = (cost) => JSON.stringify({ ts: '2026-07-20T10:00:00Z', agent: 'spendy', model: 'claude-opus-5', est_cost_usd: cost });
  // $30 in one day — a run-rate far above the old $20/wk target, so this fixture
  // would have rendered the block under every previous version of the digest.
  writeFileSync(join(usage, '2026-07-20.jsonl'), [rec(30)].join('\n') + '\n');

  const entries = [{ subject: 'Rank Tracker completed', status: 'success', ts: '2026-07-20T22:00:00Z' }];
  const html = buildDigestHtml('2026-07-20', entries, [], [], null, null, null, null, 'https://dash', [], null, null, { dataRoot: root });

  assert.ok(!html.includes('LLM Cost'), 'the cost block must not render');
  assert.ok(!html.includes('over $20 target'), 'the budget verdict must not render');
});

// The counterpart. This is exactly the server's state — data/meta-tests holds 9
// active tests, so abTestSection renders and the day is never quiet there. Pinning
// it stops the quiet-day assertion above from silently becoming unreachable.
test('buildDigestHtml: an active A/B test makes the day non-quiet', () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-active-'));
  mkdirSync(join(root, 'data', 'meta-tests'), { recursive: true });
  writeFileSync(join(root, 'data', 'meta-tests', 'sls-free-toothpaste.json'), JSON.stringify({
    slug: 'sls-free-toothpaste', status: 'active', variantA: 'A', variantB: 'B',
  }));

  const entries = [{ subject: 'Rank Tracker completed', status: 'success', ts: '2026-07-20T22:00:00Z' }];
  const html = buildDigestHtml('2026-07-20', entries, [], [], null, null, null, null, 'https://dash', [], null, null, { dataRoot: root });

  assert.ok(html.includes('Meta A/B Tests'), 'the on-disk test renders its section');
  assert.ok(/1 active test\b/.test(html), 'the active count comes from disk');
  assert.ok(!html.includes('Nothing moved the needle'), 'a day with a running test is not quiet');
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

// ── log: must write exactly once per call ────────────────────────────────────
// Regression: log() used to console.log AND appendFileSync to the same file the
// cron entry already redirects stdout into, so every line landed twice and a
// single run read as though the digest had been emailed twice.
test('log writes exactly one line per call', () => {
  const written = [];
  log('Daily summary sent.', (l) => written.push(l));
  assert.equal(written.length, 1);
  assert.match(written[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] Daily summary sent\.$/);
});

// ── the Optimization Queue is NOT a human's to-do list ───────────────────────
//
// The digest used to render every `status: 'pending'` item in
// data/performance-queue/ as an indigo "N items ready for review" block headed
// "Approve on the dashboard to push the updated content to Shopify".
//
// `agents/queue-autoapply` took that chore over: it runs daily with --apply as
// scheduler step 4d and drains the queue unattended. The block was never
// removed, and the cron clock guarantees it advertises work a robot finishes
// two hours later — performance-engine FILLS the queue at 07:30 UTC,
// daily-summary READS it at 13:00 UTC, queue-autoapply DRAINS it at 15:00 UTC.
//
// Measured on production 2026-09-18, the five rows that morning's email
// presented as "ready for review" were: one phantom (best-sls-free-toothpaste-2025,
// a post consolidated away whose Shopify article no longer exists, re-queued
// nightly and dismissed the same afternoon), three sitting on the self-clearing
// 30-day cooldown, and one genuinely parked item (gate_attempts: 3) that the
// block gave no distinguishing treatment. Four of five were never a human's task.
//
// Sean, verbatim: "I don't want to see the optimization queue. That should be
// handled automatically and should never surface as a manual task."
//
// This is a SOURCE SCAN rather than a render assertion because the strongest
// guarantee available is that the digest no longer reads the queue at all —
// `buildDigestHtml` does not take a perfQueue argument and `main()` does not
// load one. A render test could only pin the shape of a call that cannot be
// made. Same idiom as tests/lib/post-meta-readers-merged.test.js.
test('the daily digest never reads or renders the optimization queue', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', 'agents', 'daily-summary', 'index.js'),
    'utf8',
  );
  // Strip comments: the explanatory note above the former block names these
  // strings on purpose, and the rule documenting itself is not a regression.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  assert.ok(!/performance-queue/.test(code), 'must not read data/performance-queue/');
  assert.ok(!/loadPerformanceQueue/.test(code), 'the loader must stay deleted');
  assert.ok(!/Optimization Queue/.test(code), 'no Optimization Queue heading');
  assert.ok(!/ready for review/.test(code), 'nothing advertised as awaiting review');
  assert.ok(!/Approve on the dashboard/.test(code), 'no approve-on-the-dashboard instruction');
  assert.ok(!/#optimize/.test(code), 'no deep link into the queue tab');
});

test('buildDigestHtml no longer accepts a performance queue', () => {
  // Arity is the structural half of the guard above: re-adding the parameter
  // is the first move anyone reinstating the block would make.
  assert.equal(buildDigestHtml.length, 9, 'targetDate..dashboardUrl, then defaulted args');
});

test('a day whose only activity is a pending queue reads as a quiet day', () => {
  // Regression guard on the send gate: `perfQueue.length` used to be one of the
  // conditions that made a day count as "something happened". With the block
  // gone, a queue-only day has nothing to show a human, so it must fall through
  // to the quiet-day copy rather than emailing an empty shell.
  const html = buildDigestHtml(
    '2026-09-17', [], [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: emptyRoot },
  );
  assert.match(html, /Nothing moved the needle yesterday/, 'quiet-day copy shown');
});

test('blocked posts still reach the human — dropping the queue block kept that arm', () => {
  // decisionsBody was `queueSection + blockedSection`. Removing the queue half
  // must not take the blocked-post half with it: a post hard-blocked in the
  // editorial gate genuinely does need a person, and nothing else reports it.
  const blocked = [{
    slug: 'some-post',
    title: 'A Hard-Blocked Post',
    blockers: 'no_product_cta',
    reportPath: 'data/posts/some-post/editor-report.md',
  }];
  const html = buildDigestHtml(
    '2026-09-17', [], [], blocked, null, null, null, null,
    'https://dash', [], null, null, { dataRoot: emptyRoot },
  );
  assert.ok(html.includes('A Hard-Blocked Post'), 'blocked posts still surface');
  assert.ok(html.includes('Action Required'), 'under its own Action Required heading');
});

// ── the A/B block must state the VERDICT, not who "wins" ─────────────────────
//
// Two defects, both visible in the 2026-09-18 email:
//
// 1. "3 active tests running" sat directly above FIVE rows that were
//    recentConcluded — two different sets, no label between them, so the rows
//    read as though they were the active tests.
//
// 2. Every concluded row rendered `Variant <winner> wins`, derived from
//    `winner` alone. That collapses `flat` and `regressed` into one label,
//    because decideOutcome sets winner='A' for both. Measured on the real
//    production entries, EVERY concluded row was mislabelled:
//
//      fluoride-free-toothpaste   delta  0.0000  → "Variant A wins"
//      mens-natural-soap          delta  0.0000  → "Variant A wins"
//      natural-body-lotion        delta  0.0000  → "Variant A wins"
//      sls-free-toothpaste        delta  0.0000  → "Variant A wins"
//      unscented-lotion           delta +0.0009  → "Variant B wins" (GREEN)
//      vegan-body-lotion          delta +0.0006  → "Variant B wins" (GREEN)
//      best-non-toxic-body-lotion delta -0.0007  → "Variant A wins"
//      coconut oil as deodorant   delta -0.0126  → "Variant A wins"
//
//    The last one is a REAL regression past the 0.5pp dead-band, rendered as a
//    win. The two greens are noise inside the band, rendered as the rewrite
//    working — which is exactly what `npm run ctr-audit` says is not true of
//    any test on record.
//
// The dead-band is imported from lib/meta-ab-decision.js (classifyCtrDelta),
// never re-declared here.
const AB_ROOT_FIXTURES = [
  // exactly zero — the four-of-five case
  { slug: 'fluoride-free-toothpaste', status: 'concluded', winner: 'A', currentDelta: 0, concludedDate: '2026-08-09' },
  // positive but inside the ±0.5pp noise floor
  { slug: 'unscented-lotion', status: 'concluded', winner: 'B', currentDelta: 0.0009195065586043028, concludedDate: '2026-08-09' },
  // a genuine regression, well past the band
  { slug: 'coconut-oil-as-deodorant', status: 'concluded', winner: 'A', currentDelta: -0.0126, concludedDate: '2026-08-08' },
  // an active test, to pin the active/concluded split
  { slug: 'foaming-hand-soap', status: 'active', currentDelta: -0.002016848718497894 },
];

function abDigest() {
  const root = mkdtempSync(join(tmpdir(), 'digest-ab-verdict-'));
  mkdirSync(join(root, 'data', 'meta-tests'), { recursive: true });
  for (const t of AB_ROOT_FIXTURES) {
    writeFileSync(join(root, 'data', 'meta-tests', `${t.slug}.json`), JSON.stringify(t));
  }
  const entries = [{ subject: 'Rank Tracker completed', status: 'success', ts: '2026-09-17T22:00:00Z' }];
  return buildDigestHtml(
    '2026-09-17', entries, [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: root },
  );
}

// Scoped to the A/B section: the digest's CSS legitimately carries a
// `quick-wins` class for an unrelated block, so asserting over the whole
// document would fail on a feature this change has nothing to do with.
function abSection(html) {
  const start = html.indexOf('Meta A/B Tests');
  assert.ok(start > -1, 'the A/B section must render');
  const end = html.indexOf('<div class="footer">', start);
  return html.slice(start, end > -1 ? end : undefined);
}

test('the A/B block never calls a dead-band delta a win', () => {
  const block = abSection(abDigest());
  assert.ok(!/wins/i.test(block), 'the word "wins" must not appear in the A/B block');
  assert.ok(!/Variant A/i.test(block), 'no bare "Variant A" verdict');
  assert.ok(!/Variant B/i.test(block), 'no bare "Variant B" verdict');
});

test('a delta of exactly 0.00pp reads as no change', () => {
  const html = abDigest();
  const row = html.split('\n').find((l) => l.includes('fluoride-free-toothpaste')) || html;
  assert.match(row, /no change/i, 'a zero delta is no change, not a win');
});

test('a noise-level positive delta is not reported as an improvement', () => {
  const html = abDigest();
  const row = html.split('\n').find((l) => l.includes('unscented-lotion')) || html;
  assert.match(row, /no change/i, '+0.09pp is inside the ±0.5pp dead band');
  assert.ok(!/improved/i.test(row), 'must not claim the rewrite improved anything');
});

test('a real regression is reported as a regression', () => {
  const html = abDigest();
  const row = html.split('\n').find((l) => l.includes('coconut-oil-as-deodorant')) || html;
  assert.match(row, /regressed/i, '-1.26pp is past the dead band and must say so');
});

test('the active count is labelled separately from the concluded rows', () => {
  const html = abDigest();
  assert.match(html, /1 active test\b/, 'active count still shown');
  assert.match(html, /concluded/i, 'the concluded rows carry their own label');
  // The active test must not appear as a concluded row.
  const concludedHalf = html.slice(html.search(/concluded/i));
  assert.ok(!concludedHalf.includes('foaming-hand-soap'), 'an ACTIVE test is never listed as concluded');
});

test('the noise floor is stated so a reader can judge the deltas', () => {
  const html = abDigest();
  assert.match(html, /0\.5pp/, 'the dead-band width is named in the block');
});

// ── decisions the AUTOMATION has given up on ────────────────────────────────
//
// PR #907 removed the Optimization Queue block: the digest stopped reading
// data/performance-queue/ because it was printing a to-do list of work
// queue-autoapply finishes two hours later, every morning.
//
// This is the narrow case that survived. An item where the robot has
// permanently abandoned the work is not routine — no run will ever clear it,
// and before this it was indistinguishable in the report from an item merely
// waiting out a 30-day cooldown.
//
// Sean: "That should surface as a decision that needs to be made by me."
//
// TWO PROPERTIES KEEP THIS FROM BECOMING THE OLD BLOCK AGAIN:
//   1. It reads queue-autoapply's REPORT — what the robot says it gave up on —
//      never the queue directory, which is the fleet's workspace.
//   2. Only `needs_decision[]` renders. A cooldown, an over-cap item and an
//      unresolvable product count are absent from that array by construction.
//
// The fixture is the real production item, 2026-09-18: one of four pending.
const DECISION_ROOT = mkdtempSync(join(tmpdir(), 'digest-decisions-'));
function withDecisions(needsDecision) {
  const dir = join(DECISION_ROOT, String(Math.random()).slice(2));
  mkdirSync(join(dir, 'data', 'reports', 'queue-autoapply'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'reports', 'queue-autoapply', 'latest.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), needs_decision: needsDecision }),
  );
  return dir;
}

const STUCK = [{
  slug: 'seo-opp-best-organic-toothpaste-what-to-look-for-why-it-matters',
  title: 'SEO opportunity: best organic toothpaste',
  trigger: 'seo-opportunity',
  created_at: '2026-08-10T14:10:08Z',
  decision: 'editor-gate-exhausted',
  reason: 'editor gate has failed 3 times — needs a human',
  label: 'The editor gate failed 3 times — rewrite it, or write it off',
  gate_attempts: 3,
  last_gate_reason: 'the factual concerns blocker must be resolved: missing citations for USDA 95%/70% thresholds.',
}];

test('an item the automation gave up on reaches the human', () => {
  const html = buildDigestHtml(
    '2026-09-17', [], [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: withDecisions(STUCK) },
  );
  assert.ok(html.includes('SEO opportunity: best organic toothpaste'), 'the item is named');
  assert.match(html, /rewrite it, or write it off/, 'the DECISION is stated, not just the item');
  assert.match(html, /failed 3 times/i, 'why the automation stopped');
  assert.ok(!/ready for review/i.test(html), 'never framed as a review queue');
  assert.ok(!/Approve on the dashboard/i.test(html), 'never framed as an approval');
});

test('the block is silent when nothing is stuck', () => {
  const html = buildDigestHtml(
    '2026-09-17', [], [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: withDecisions([]) },
  );
  assert.ok(!/gave up|Needs your decision/i.test(html), 'no empty section');
  assert.match(html, /Nothing moved the needle yesterday/, 'an empty queue is a quiet day');
});

test('a missing queue-autoapply report is silent, not an error', () => {
  const html = buildDigestHtml(
    '2026-09-17', [], [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: emptyRoot },
  );
  assert.match(html, /Nothing moved the needle yesterday/);
});

test('the digest still never reads the performance queue directly', () => {
  // The guard from PR #907, restated against this change: surfacing stuck items
  // must come from the agent's report, never from the queue directory.
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', 'agents', 'daily-summary', 'index.js'),
    'utf8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  assert.ok(!/performance-queue/.test(code), 'must not read data/performance-queue/');
  assert.ok(!/ready for review/.test(code), 'the old framing must not return');
});
