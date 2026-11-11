/**
 * Which cron job produces what, and which ones the recap reviewer may re-run.
 *
 * A re-run is only safe for READ-ONLY producers: collectors, drift checks and
 * report writers whose output is a file the digest reads. Anything that sends
 * email, posts, publishes or edits a live page is on NEVER_RERUN, and the
 * allowlist is checked AFTER it so an entry can never be both. A failed
 * outreach agent that is re-run sends the message twice; that is why the
 * default is "no".
 *
 * Pure: the crontab text is passed in by the caller.
 */

/**
 * `crontab -l` text -> Map<repo-relative script, { schedule, command }>.
 * The command keeps its args and drops the `>> log` redirect. First line wins
 * when a script appears twice.
 */
export function parseCrontab(text) {
  const jobs = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+.*?(?:^|[\s&;"])((?:\/\S*\/)?node)\s+(\S+)([^>]*)/);
    if (!m) continue;
    const [, schedule, node, script, rest] = m;
    if (jobs.has(script)) continue;
    jobs.set(script, { schedule, command: `${node} ${script}${rest}`.trim() });
  }
  return jobs;
}

/** One re-run (Unit A, and the post-deploy verification of a fix) may take this long. */
export const RERUN_TIMEOUT_MS = 20 * 60_000;

export const NEVER_RERUN = Object.freeze(new Set([
  'agents/creator-outreach/index.js',
  'agents/press-outreach/index.js',
  'agents/ugc-reels/index.js',
  'agents/social-poster/index.js',
  'agents/instagram-dm/index.js',
  'agents/founder-notes/index.js',
  'agents/amazon-review-requests/index.js',
  'agents/publisher/index.js',
  'agents/calendar-runner/index.js',
  'agents/meta-optimizer/index.js',
  'agents/queue-autoapply/index.js',
]));

const RERUN_AGENTS = new Set([
  'rank-tracker', 'post-performance', 'seo-impact', 'gsc-opportunity',
  'quick-win-targeter', 'indexing-checker', 'keyword-index-builder',
  'trybe-review', // read-only reporting here: it never approves or rejects
]);

export function isRerunnable(source) {
  if (!source || NEVER_RERUN.has(source)) return false;
  if (/^scripts\/check-[^/]+\.mjs$/.test(source)) return true;
  const m = source.match(/^agents\/([^/]+)\/index\.js$/);
  return !!m && (m[1].endsWith('-collector') || RERUN_AGENTS.has(m[1]));
}

// checkSystemHealth() feeds and reports -> the script that writes them.
const FEEDS = {
  'rank-snapshots': 'agents/rank-tracker/index.js',
  gsc: 'agents/gsc-collector/index.js',
  ga4: 'agents/ga4-collector/index.js',
  clarity: 'agents/clarity-collector/index.js',
  shopify: 'agents/shopify-collector/index.js',
  'google-ads': 'agents/google-ads-collector/index.js',
  'gsc-opportunity report': 'agents/gsc-opportunity/index.js',
  'quick-wins report': 'agents/quick-win-targeter/index.js',
  'seo-impact report': 'agents/seo-impact/index.js',
  'publish-drift report': 'agents/publish-drift/index.js',
  'pipeline-prioritizer report': 'agents/pipeline-prioritizer/index.js',
};

/**
 * The feed or report a health row is about: 'Data feed "gsc" is stale' -> 'gsc'.
 * The rest of the title (stale, missing, N days old) changes from run to run,
 * so verification compares this name, never the whole title.
 */
export function feedNameOf(healthTitle) {
  const m = String(healthTitle || '').match(/^(?:Data feed|Analysis report) "([^"]+)"/);
  return m ? m[1] : null;
}

/** Health-row title -> producer script, or null when unknown. */
export function collectorFor(healthTitle) {
  const name = feedNameOf(healthTitle);
  return (name && FEEDS[name]) || null;
}

/**
 * `crontab` command text -> argv. Strips only shell redirects (`2>&1`, `>> log`,
 * `> log`) and quotes; an ordinary argument such as `--limit 5` is never touched.
 */
export function splitCommand(command) {
  const text = ` ${String(command || '')}`
    .replace(/\s\d*>&\d+/g, ' ')
    .replace(/\s\d*>>?\s*\S+/g, ' ');
  return text.trim().split(/\s+/).filter(Boolean).map((p) => p.replace(/^["']|["']$/g, ''));
}
