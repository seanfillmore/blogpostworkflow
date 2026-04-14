/**
 * Rank Tracker Agent
 *
 * Snapshots Ahrefs keyword positions for every published post, compares with
 * the previous snapshot to surface position changes, and flags posts for:
 *   - 🚀 Quick win  — positions 11–20, within reach of page 1 with small effort
 *   - 🔄 Refresh    — positions 21–50, stagnant; content update likely needed
 *   - ❌ Not ranking — no Ahrefs data for this post/keyword
 *   - ✅ Page 1      — positions 1–10, monitor and protect
 *
 * Snapshots saved to: data/rank-snapshots/YYYY-MM-DD.json
 * Report saved to:    data/reports/rank-tracker-report.md
 *
 * Keyword data:
 *   Drop a CSV into data/keyword-tracker/ with at least these columns:
 *     keyword   — the search term
 *     position  — current rank (number)
 *     volume    — monthly search volume (optional)
 *     url       — ranking URL (optional)
 *
 *   Compatible with Ahrefs Rank Tracker exports, Keywords Explorer exports,
 *   or any spreadsheet exported as CSV.
 *   The most recently modified CSV in the folder is used automatically.
 *
 * Usage:
 *   node agents/rank-tracker/index.js
 *   node agents/rank-tracker/index.js --compare 2026-02-01   # diff against specific date
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getRankedKeywords } from '../../lib/dataforseo.js';

// GSC is optional — gracefully skip if not configured
let gsc = null;
async function loadGSC() {
  try {
    gsc = await import('../../lib/gsc.js');
  } catch {
    // Not configured — agents continue without GSC data
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'rank-snapshots');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'rank-tracker');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');

import { listAllSlugs, getPostMeta as getPostMetaLib, POSTS_DIR } from '../../lib/posts.js';
const TRACKER_DIR = join(ROOT, 'data', 'keyword-tracker');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const compareIdx = args.indexOf('--compare');
const compareDate = compareIdx !== -1 ? args[compareIdx + 1] : null;
const deviceIdx = args.indexOf('--device');
const deviceArg = deviceIdx !== -1 ? args[deviceIdx + 1] : null; // 'desktop', 'mobile', or null for both
const DEVICES = deviceArg ? [deviceArg] : ['desktop', 'mobile'];

// ── csv helpers (reused from content-researcher) ──────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const fields = [];
    let inQuote = false, cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i]?.replace(/^"|"$/g, '') ?? ''; });
    return row;
  });
}

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function g(row, ...keys) {
  for (const k of keys) if (k in row && row[k] !== '') return row[k];
  return null;
}

/**
 * Load the keyword tracker CSV from data/keyword-tracker/.
 * Returns a Map of keyword (lowercase) → { position, volume, url }.
 *
 * Expected CSV columns (case-insensitive):
 *   keyword   — the search term
 *   position  — current rank (number)
 *   volume    — monthly search volume (optional)
 *   url       — ranking URL (optional)
 *
 * Compatible with Ahrefs Rank Tracker exports and manual spreadsheets.
 */
function loadKeywordTrackerCsv() {
  if (!existsSync(TRACKER_DIR)) return { map: new Map(), filename: null };

  const files = readdirSync(TRACKER_DIR)
    .filter((f) => f.endsWith('.csv') || f.endsWith('.tsv'))
    .sort((a, b) => {
      // Prefer most recently modified
      const sa = statSync(join(TRACKER_DIR, a)).mtimeMs;
      const sb = statSync(join(TRACKER_DIR, b)).mtimeMs;
      return sb - sa;
    });

  if (files.length === 0) return { map: new Map(), filename: null };

  const filename = files[0];
  const content = readFileSync(join(TRACKER_DIR, filename), 'utf8');
  const rows = parseCSV(content);
  const map = new Map();

  for (const row of rows) {
    const keyword = g(row, 'keyword', 'keywords', 'query', 'term');
    if (!keyword) continue;
    const position     = num(g(row, 'current position', 'position', 'rank', 'pos'));
    const volume       = num(g(row, 'volume', 'search volume', 'vol', 'monthly volume'));
    const url          = g(row, 'current url', 'url', 'landing page', 'page') || null;
    const kd           = num(g(row, 'kd', 'keyword difficulty', 'difficulty'));
    const cpc          = num(g(row, 'cpc', 'cost per click'));
    const traffic      = num(g(row, 'current organic traffic', 'organic traffic', 'traffic'));
    const trafficPrev  = num(g(row, 'previous organic traffic'));
    const trafficChange= num(g(row, 'organic traffic change', 'traffic change'));
    const positionPrev = num(g(row, 'previous position'));
    const positionChange=num(g(row, 'position change'));
    const urlPrev      = g(row, 'previous url') || null;
    const serpFeatures = g(row, 'serp features', 'serp feature') || null;
    const country      = g(row, 'country') || null;
    const datePrev     = g(row, 'previous date') || null;
    const dateCurr     = g(row, 'current date') || null;
    const intents      = [];
    if (g(row, 'informational')  === 'true') intents.push('Informational');
    if (g(row, 'commercial')     === 'true') intents.push('Commercial');
    if (g(row, 'transactional')  === 'true') intents.push('Transactional');
    if (g(row, 'navigational')   === 'true') intents.push('Navigational');
    if (g(row, 'branded')        === 'true') intents.push('Branded');
    if (g(row, 'local')          === 'true') intents.push('Local');
    map.set(keyword.toLowerCase().trim(), {
      position, volume, url, kd, cpc, traffic, trafficPrev, trafficChange,
      positionPrev, positionChange, urlPrev, serpFeatures, country,
      datePrev, dateCurr, intents,
    });
  }

  return { map, filename };
}

async function fetchLiveKeywordData(device = 'desktop') {
  try {
    const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    console.log(`  Fetching live ${device} keyword data from DataForSEO for ${domain}...`);
    // 5000 is well above this domain's current organic footprint (~1k) and
    // leaves headroom as the site grows. getRankedKeywords paginates internally
    // (DataForSEO's per-request max is 1000), so this is still a single logical
    // call from our side — it just spans multiple API pages when needed.
    const keywords = await getRankedKeywords(domain, { limit: 5000, device });
    const map = new Map();
    for (const kw of keywords) {
      map.set(kw.keyword.toLowerCase().trim(), {
        position: kw.position,
        volume: kw.volume,
        url: kw.url,
        kd: kw.kd,
        cpc: kw.cpc,
        traffic: kw.traffic,
        trafficPrev: null,
        trafficChange: null,
        positionPrev: null,
        positionChange: null,
        urlPrev: null,
        serpFeatures: kw.serpFeatures?.length ? kw.serpFeatures.join(',') : null,
        country: null,
        datePrev: null,
        dateCurr: null,
        intents: kw.intent ? [kw.intent] : [],
      });
    }
    return { map, filename: `DataForSEO API (${device})` };
  } catch (err) {
    console.log(`  ⚠️ DataForSEO ${device} fetch failed: ${err.message}`);
    return { map: new Map(), filename: null };
  }
}

// ── local data ────────────────────────────────────────────────────────────────

function loadBlogIndex() {
  try {
    const blogs = JSON.parse(readFileSync(join(ROOT, 'data', 'blog-index.json'), 'utf8'));
    // Map title (normalized) → handle for fallback lookup
    const map = new Map();
    for (const blog of blogs) {
      for (const a of (blog.articles || [])) {
        const key = a.title?.toLowerCase().trim();
        if (key) map.set(key, { handle: a.handle, blogHandle: blog.handle });
      }
    }
    return map;
  } catch { return new Map(); }
}

// Load brief volume for a slug (fallback when keyword isn't in CSV yet)
function loadBriefVolume(slug) {
  try {
    const p = join(BRIEFS_DIR, `${slug}.json`);
    if (!existsSync(p)) return null;
    const brief = JSON.parse(readFileSync(p, 'utf8'));
    return brief.search_volume ?? brief.volume ?? null;
  } catch { return null; }
}

function loadPublishedPosts() {
  return listAllSlugs()
    .map((slug) => {
      try {
        const meta = getPostMetaLib(slug);
        if (!meta) return null;
        // Only track posts that have been published to Shopify
        if (!meta.shopify_article_id) return null;
        return {
          slug,
          title: meta.title,
          keyword: meta.target_keyword,
          shopify_handle: meta.shopify_handle,
          shopify_blog_handle: meta.shopify_blog_handle || 'news',
          published_at: meta.shopify_publish_at || meta.uploaded_at,
          brief_volume: loadBriefVolume(slug),
        };
      } catch { return null; }
    })
    .filter(Boolean);
}

function buildCanonicalUrl(post, blogIndex) {
  // Prefer saved shopify_handle; fall back to blog-index lookup by title
  let handle = post.shopify_handle;
  let blogHandle = post.shopify_blog_handle || 'news';

  if (!handle && post.title) {
    const entry = blogIndex.get(post.title.toLowerCase().trim());
    if (entry) {
      handle = entry.handle;
      blogHandle = entry.blogHandle || blogHandle;
    }
  }

  handle = handle || post.slug;
  return `${config.url}/blogs/${blogHandle}/${handle}`;
}

// ── snapshot management ───────────────────────────────────────────────────────

/**
 * Match snapshot filenames for a given device.
 * Device-suffixed files (YYYY-MM-DD-desktop.json) are always device-specific.
 * Legacy plain-date files (YYYY-MM-DD.json) are treated as 'desktop' for
 * backward compatibility — those snapshots were written before Phase 2.
 */
function snapshotFilesForDevice(device) {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  const all = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'));
  const suffix = `-${device}.json`;
  const deviceFiles = all.filter((f) => f.endsWith(suffix));
  const legacyFiles = device === 'desktop'
    ? all.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  // Sort ascending by date portion
  return [...deviceFiles, ...legacyFiles].sort((a, b) => {
    const dateA = a.slice(0, 10);
    const dateB = b.slice(0, 10);
    return dateA.localeCompare(dateB);
  });
}

function loadLatestSnapshot(beforeDate, device = 'desktop') {
  const files = snapshotFilesForDevice(device);
  if (files.length === 0) return null;

  if (beforeDate) {
    const eligible = files.filter((f) => f.slice(0, 10) < beforeDate);
    if (eligible.length === 0) return null;
    return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, eligible[eligible.length - 1]), 'utf8'));
  }

  return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, files[files.length - 1]), 'utf8'));
}

function loadSnapshotByDate(date, device = 'desktop') {
  const devicePath = join(SNAPSHOTS_DIR, `${date}-${device}.json`);
  if (existsSync(devicePath)) return JSON.parse(readFileSync(devicePath, 'utf8'));
  // Fall back to legacy plain-date file (treated as desktop)
  if (device === 'desktop') {
    const legacyPath = join(SNAPSHOTS_DIR, `${date}.json`);
    if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, 'utf8'));
  }
  return null;
}

// ── classification ────────────────────────────────────────────────────────────

function classifyPosition(position) {
  if (!position) return { tier: 'not_ranking', label: '❌ Not ranking', icon: '❌' };
  if (position <= 3)  return { tier: 'top3',        label: '🥇 Top 3',      icon: '🥇' };
  if (position <= 10) return { tier: 'page1',        label: '✅ Page 1',     icon: '✅' };
  if (position <= 20) return { tier: 'quick_win',    label: '🚀 Quick win',  icon: '🚀' };
  if (position <= 50) return { tier: 'refresh',      label: '🔄 Needs work', icon: '🔄' };
  return { tier: 'buried', label: '📉 Buried 50+', icon: '📉' };
}

function formatDelta(current, previous) {
  if (!previous || !current) return '—';
  const delta = previous - current; // positive = improved (lower position number = better)
  if (delta === 0) return '→ 0';
  return delta > 0 ? `↑ ${delta}` : `↓ ${Math.abs(delta)}`;
}

// ── report builder ────────────────────────────────────────────────────────────

function buildReport(entries, today, previousDate, discovery = null) {
  const lines = [];

  const onPage1 = entries.filter((e) => e.position && e.position <= 10).length;
  const quickWins = entries.filter((e) => e.position && e.position > 10 && e.position <= 20).length;
  const needsWork = entries.filter((e) => e.position && e.position > 20).length;
  const notRanking = entries.filter((e) => !e.position).length;

  lines.push(`# Rank Tracker Report — ${config.name}`);
  lines.push(`**Snapshot date:** ${today}`);
  if (previousDate) lines.push(`**Compared with:** ${previousDate}`);
  lines.push(`**Posts tracked:** ${entries.length}`);
  const csvEntries = entries.filter((e) => e.dataSource === 'csv');
  if (csvEntries.length > 0) {
    lines.push(`**Data source:** Keyword tracker CSV — update \`data/keyword-tracker/\` with a fresh export to refresh positions`);
  }
  lines.push('');
  lines.push(`| ✅ Page 1 | 🚀 Quick wins | 🔄 Needs work | ❌ Not ranking |`);
  lines.push(`|----------|--------------|--------------|---------------|`);
  lines.push(`| ${onPage1} | ${quickWins} | ${needsWork} | ${notRanking} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Rankings table ──────────────────────────────────────────────────────────
  lines.push('## Keyword Rankings\n');
  lines.push('| Post | Target Keyword | Position | Change | Vol/mo | Status |');
  lines.push('|------|---------------|----------|--------|--------|--------|');

  const sorted = [...entries].sort((a, b) => {
    if (!a.position && !b.position) return 0;
    if (!a.position) return 1;
    if (!b.position) return -1;
    return a.position - b.position;
  });

  for (const e of sorted) {
    const { icon } = classifyPosition(e.position);
    const pos = e.position ? `#${e.position}` : '—';
    const delta = formatDelta(e.position, e.previousPosition);
    const vol = e.volume ? e.volume.toLocaleString() : '—';
    lines.push(`| ${e.title?.slice(0, 45) ?? e.slug} | ${e.keyword} | ${pos} | ${delta} | ${vol} | ${icon} |`);
  }
  lines.push('');

  // ── Action items ────────────────────────────────────────────────────────────
  const quickWinPosts = sorted.filter((e) => e.position && e.position > 10 && e.position <= 20);
  const refreshPosts = sorted.filter((e) => e.position && e.position > 20);
  const notRankingPosts = sorted.filter((e) => !e.position);
  const movers = sorted.filter((e) => {
    if (!e.position || !e.previousPosition) return false;
    return Math.abs(e.previousPosition - e.position) >= 5;
  });

  lines.push('---');
  lines.push('');
  lines.push('## Priority Actions\n');

  if (quickWinPosts.length > 0) {
    lines.push('### 🚀 Quick Wins — Push to Page 1\n');
    lines.push('These posts rank positions 11–20. A targeted internal link boost or minor content update could move them to page 1.\n');
    for (const e of quickWinPosts) {
      lines.push(`- **"${e.keyword}"** — currently #${e.position}`);
      lines.push(`  - [${e.title}](${e.url})`);
      lines.push(`  - Action: add 2–3 internal links from related posts pointing to this URL; consider expanding the H2 that targets this keyword`);
    }
    lines.push('');
  }

  if (refreshPosts.length > 0) {
    lines.push('### 🔄 Content Refresh — Positions 21–50\n');
    for (const e of refreshPosts) {
      const daysPublished = e.published_at
        ? Math.round((Date.now() - new Date(e.published_at)) / (1000 * 60 * 60 * 24))
        : null;
      const age = daysPublished ? ` (${daysPublished} days old)` : '';
      lines.push(`- **"${e.keyword}"** — #${e.position}${age}`);
      lines.push(`  - [${e.title}](${e.url})`);
    }
    lines.push('');
  }

  if (notRankingPosts.length > 0) {
    lines.push('### ❌ Not Yet Ranking\n');
    lines.push('These posts have no ranking data detected. May be too new or not yet indexed.\n');
    for (const e of notRankingPosts) {
      lines.push(`- **${e.title}** — keyword: "${e.keyword}"`);
      lines.push(`  - URL checked: ${e.url}`);
    }
    lines.push('');
  }

  if (movers.length > 0) {
    lines.push('### 📊 Notable Movers (±5 positions)\n');
    for (const e of movers) {
      const delta = e.previousPosition - e.position;
      const dir = delta > 0 ? `↑ improved ${delta} spots` : `↓ dropped ${Math.abs(delta)} spots`;
      lines.push(`- **"${e.keyword}"** — ${dir} (${e.previousPosition} → ${e.position})`);
    }
    lines.push('');
  }

  // ── GSC Insights ────────────────────────────────────────────────────────────
  const gscEntries = entries.filter((e) => e.gsc_impressions !== null);
  if (gscEntries.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## GSC Insights (90-day)\n');
    lines.push('| Post | GSC Position | Impressions | Clicks | CTR |');
    lines.push('|------|-------------|-------------|--------|-----|');
    const sortedGsc = [...gscEntries].sort((a, b) => (b.gsc_impressions ?? 0) - (a.gsc_impressions ?? 0));
    for (const e of sortedGsc) {
      const gscPos = e.gsc_position ? `#${e.gsc_position}` : '—';
      const ctr = e.gsc_ctr ? `${(e.gsc_ctr * 100).toFixed(1)}%` : '—';
      lines.push(`| ${e.title?.slice(0, 40) ?? e.slug} | ${gscPos} | ${(e.gsc_impressions ?? 0).toLocaleString()} | ${(e.gsc_clicks ?? 0).toLocaleString()} | ${ctr} |`);
    }
    lines.push('');

    // Low CTR opportunities — high impressions but < 3% CTR
    const lowCtr = sortedGsc.filter((e) => e.gsc_impressions > 200 && e.gsc_ctr < 0.03);
    if (lowCtr.length > 0) {
      lines.push('### 🎯 Low CTR Opportunities\n');
      lines.push('These pages have significant impressions but low click-through rates. Improving the title tag and meta description could unlock substantial traffic without new content.\n');
      for (const e of lowCtr) {
        const ctr = `${(e.gsc_ctr * 100).toFixed(1)}%`;
        lines.push(`- **${e.title}** — ${e.gsc_impressions.toLocaleString()} impressions, ${ctr} CTR (#${e.gsc_position ?? '?'} avg position)`);
        lines.push(`  - Action: rewrite title/meta to be more compelling and keyword-specific`);
      }
      lines.push('');
    }
  }

  // ── Cluster summary ─────────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## Cluster Performance\n');

  const clusters = {};
  for (const e of entries) {
    const kw = e.keyword?.toLowerCase() ?? '';
    let cluster = 'Other';
    if (kw.includes('deodorant')) cluster = 'Deodorant';
    else if (kw.includes('toothpaste') || kw.includes('fluoride') || kw.includes('sls') || kw.includes('oral')) cluster = 'Toothpaste';
    else if (kw.includes('lip')) cluster = 'Lip Balm';
    else if (kw.includes('soap') || kw.includes('bar soap')) cluster = 'Bar Soap';
    else if (kw.includes('lotion') || kw.includes('moisturizer')) cluster = 'Body Lotion';
    else if (kw.includes('coconut')) cluster = 'Coconut Oil';

    if (!clusters[cluster]) clusters[cluster] = [];
    clusters[cluster].push(e);
  }

  lines.push('| Cluster | Posts | Avg Position | Page 1 | Quick Wins |');
  lines.push('|---------|-------|-------------|--------|------------|');

  for (const [name, posts] of Object.entries(clusters)) {
    const ranked = posts.filter((p) => p.position);
    const avgPos = ranked.length
      ? Math.round(ranked.reduce((s, p) => s + p.position, 0) / ranked.length)
      : null;
    const p1 = posts.filter((p) => p.position && p.position <= 10).length;
    const qw = posts.filter((p) => p.position && p.position > 10 && p.position <= 20).length;
    lines.push(`| ${name} | ${posts.length} | ${avgPos ? `#${avgPos}` : '—'} | ${p1} | ${qw} |`);
  }

  lines.push('');
  // Keyword discovery — new rankings since previous snapshot. Big leading
  // signal for whether recent content/linking work is earning Google's trust.
  if (discovery && (discovery.newKeywords.length || discovery.lostKeywords.length)) {
    lines.push('---');
    lines.push('');
    lines.push('## Keyword Discovery');
    lines.push('');
    lines.push(`Compared with the ${previousDate} snapshot.`);
    lines.push('');
    if (discovery.newKeywords.length) {
      lines.push(`### 🆕 New rankings (${discovery.newKeywords.length})`);
      lines.push('');
      lines.push('Keywords Google is now ranking us for that weren\'t in the previous snapshot.');
      lines.push('');
      lines.push('| Keyword | Position | Volume | URL |');
      lines.push('|---------|---------:|-------:|-----|');
      for (const k of discovery.newKeywords.slice(0, 25)) {
        const url = k.url ? `\`${k.url}\`` : '—';
        lines.push(`| ${k.keyword} | #${k.position} | ${k.volume?.toLocaleString() ?? '—'} | ${url} |`);
      }
      if (discovery.newKeywords.length > 25) {
        lines.push('');
        lines.push(`_…and ${discovery.newKeywords.length - 25} more. See \`data/reports/rank-tracker/new-rankings-<device>.json\` for the full list._`);
      }
      lines.push('');
    }
    if (discovery.lostKeywords.length) {
      lines.push(`### 📉 Lost rankings (${discovery.lostKeywords.length})`);
      lines.push('');
      lines.push('Keywords we ranked for last snapshot that have disappeared. Some noise is normal (DataForSEO refresh cycles, positions falling past their tracked cutoff); a sudden bulk disappearance usually means a real penalty.');
      lines.push('');
      lines.push('| Keyword | Prev Position | Volume | URL |');
      lines.push('|---------|--------------:|-------:|-----|');
      for (const k of discovery.lostKeywords.slice(0, 25)) {
        const url = k.url ? `\`${k.url}\`` : '—';
        lines.push(`| ${k.keyword} | #${k.position} | ${k.volume?.toLocaleString() ?? '—'} | ${url} |`);
      }
      if (discovery.lostKeywords.length > 25) {
        lines.push('');
        lines.push(`_…and ${discovery.lostKeywords.length - 25} more._`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Next run: \`node agents/rank-tracker/index.js\`*`);

  return lines.join('\n');
}

// ── keyword-discovery diff ───────────────────────────────────────────────────

/**
 * Compare the ranking-keyword set in two snapshots and produce a discovery
 * report: keywords that newly appeared (Google started ranking the domain for
 * them) and keywords that disappeared (ranked last time, don't any more).
 *
 * Caveats:
 *   - "new" is the strong signal — something we didn't rank for now ranks.
 *   - "lost" is noisier: the keyword could have fallen past DataForSEO's
 *     tracked position, or the DB refresh cycle may have dropped it briefly.
 *     Still surfaced — a sudden bulk disappearance usually means a real
 *     penalty, and false positives are easy to triage by spot-checking.
 */
function diffRankingKeywords(current, previous) {
  const keysOf = (snap) => {
    const combined = [...(snap.posts || []), ...(snap.allKeywords || [])];
    const byKw = new Map();
    for (const k of combined) {
      if (!k.position) continue;
      const kw = (k.keyword || '').toLowerCase().trim();
      if (!kw) continue;
      // When a keyword appears in both posts and allKeywords (shouldn't, but
      // defensive), prefer the first occurrence.
      if (!byKw.has(kw)) byKw.set(kw, k);
    }
    return byKw;
  };

  const curMap = keysOf(current);
  const prevMap = keysOf(previous);

  const newKeywords = [];
  for (const [kw, entry] of curMap) {
    if (!prevMap.has(kw)) newKeywords.push(entry);
  }
  const lostKeywords = [];
  for (const [kw, entry] of prevMap) {
    if (!curMap.has(kw)) lostKeywords.push(entry);
  }
  // Sort by volume desc — highest-traffic discoveries first.
  const byVolume = (a, b) => (b.volume || 0) - (a.volume || 0);
  newKeywords.sort(byVolume);
  lostKeywords.sort(byVolume);
  return { newKeywords, lostKeywords };
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Run the rank-tracking pipeline for a single device (desktop or mobile).
 * Each device produces its own snapshot file (`YYYY-MM-DD-<device>.json`)
 * and markdown report. GSC metrics are identical across devices, so the
 * caller can cache them and pass them in to avoid redundant API calls.
 */
async function runForDevice({ device, today, posts, blogIndex, gscCache, isSoleDevice }) {
  console.log(`\n━━ ${device.toUpperCase()} ━━`);

  // Load keyword data — try DataForSEO API first, fall back to CSV (CSV is
  // legacy desktop-only data; mobile skips CSV fallback entirely).
  let trackerMap, trackerFile;
  const liveData = await fetchLiveKeywordData(device);
  if (liveData.map.size > 0) {
    trackerMap = liveData.map;
    trackerFile = liveData.filename;
    console.log(`  Keyword data: ${trackerFile} (${trackerMap.size} keywords)`);
  } else if (device === 'desktop') {
    const csv = loadKeywordTrackerCsv();
    trackerMap = csv.map;
    trackerFile = csv.filename;
    if (trackerFile) {
      console.log(`  Keyword data: data/keyword-tracker/${trackerFile} (${trackerMap.size} keywords)`);
    } else {
      console.log('  ⚠️  No keyword data available — neither DataForSEO API nor CSV.');
      return null;
    }
  } else {
    console.log(`  ⚠️  No ${device} data available from DataForSEO — skipping.`);
    return null;
  }

  // Load previous snapshot for delta comparison (device-specific)
  const prevSnapshot = compareDate
    ? loadSnapshotByDate(compareDate, device)
    : loadLatestSnapshot(today, device);

  if (prevSnapshot) {
    console.log(`  Previous snapshot: ${prevSnapshot.date} (${prevSnapshot.posts.length} entries)`);
  } else {
    console.log('  No previous snapshot found — this will be the baseline');
  }

  const prevMap = new Map((prevSnapshot?.posts || []).map((p) => [p.slug, p]));

  // Fetch current positions
  const entries = [];
  for (const post of posts) {
    const url = buildCanonicalUrl(post, blogIndex);
    process.stdout.write(`  [${entries.length + 1}/${posts.length}] "${post.keyword}"... `);

    let position = null;
    let volume = null;
    let dataSource = 'none';

    const kw = post.keyword?.toLowerCase().trim();
    const tracked = kw ? trackerMap.get(kw) : null;
    if (tracked !== undefined && tracked !== null) {
      position = tracked.position;
      volume = tracked.volume;
      dataSource = trackerFile.startsWith('DataForSEO') ? 'api' : 'csv';
    } else if (trackerFile) {
      dataSource = trackerFile.startsWith('DataForSEO') ? 'api (not found)' : 'csv (not found)';
    }

    if (volume === null && post.brief_volume !== null) {
      volume = post.brief_volume;
    }

    // GSC metrics are device-agnostic — fetch once per URL and cache.
    let gscPerf = null;
    if (gsc && url) {
      if (gscCache.has(url)) {
        gscPerf = gscCache.get(url);
      } else {
        try { gscPerf = await gsc.getPagePerformance(url, 90); } catch { /* skip */ }
        gscCache.set(url, gscPerf);
      }
    }

    const prev = prevMap.get(post.slug);
    const entry = {
      slug: post.slug,
      title: post.title,
      keyword: post.keyword,
      url,
      position,
      volume,
      dataSource,
      kd:            tracked?.kd           ?? null,
      cpc:           tracked?.cpc          ?? null,
      traffic:       tracked?.traffic      ?? null,
      trafficPrev:   tracked?.trafficPrev  ?? null,
      trafficChange: tracked?.trafficChange?? null,
      positionPrev:  tracked?.positionPrev ?? null,
      positionChange:tracked?.positionChange??null,
      urlPrev:       tracked?.urlPrev      ?? null,
      serpFeatures:  tracked?.serpFeatures ?? null,
      country:       tracked?.country      ?? null,
      datePrev:      tracked?.datePrev     ?? null,
      dateCurr:      tracked?.dateCurr     ?? null,
      intents:       tracked?.intents      ?? [],
      gsc_position: gscPerf?.position ? Math.round(gscPerf.position) : null,
      gsc_clicks: gscPerf?.clicks ?? null,
      gsc_impressions: gscPerf?.impressions ?? null,
      gsc_ctr: gscPerf?.ctr ?? null,
      previousPosition: prev?.position ?? null,
      previousDate: prevSnapshot?.date ?? null,
      published_at: post.published_at,
    };
    entries.push(entry);

    const posStr = position ? `#${position}` : (tracked === null ? 'not found' : 'no data');
    const delta = prev?.position && position ? ` (was #${prev.position})` : '';
    console.log(`${posStr}${delta}`);
  }

  // Save snapshot (device-suffixed)
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshotPath = join(SNAPSHOTS_DIR, `${today}-${device}.json`);
  const trackedKeywords = new Set(entries.map(e => e.keyword?.toLowerCase().trim()).filter(Boolean));
  const allKeywords = [];
  for (const [kw, data] of trackerMap.entries()) {
    if (trackedKeywords.has(kw)) continue;
    allKeywords.push({ keyword: kw, ...data });
  }
  allKeywords.sort((a, b) => {
    if (a.position == null && b.position == null) return 0;
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });

  const snapshot = {
    date: today,
    device,
    posts: entries.map(({ slug, keyword, url, position, volume, traffic, kd, serpFeatures, published_at }) => ({
      slug, keyword, url, position, volume, traffic, kd, serpFeatures, published_at,
    })),
    allKeywords,
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n  Snapshot saved: ${snapshotPath}`);

  // Keyword-discovery diff: compare current snapshot's ranking keywords to
  // the previous snapshot for this device. "New" keywords are a leading
  // signal that Google has started ranking the domain for fresh queries
  // (usually within a cluster where we've added content or earned links).
  let discovery = null;
  mkdirSync(REPORTS_DIR, { recursive: true });
  if (prevSnapshot && prevSnapshot.date !== today) {
    discovery = diffRankingKeywords(snapshot, prevSnapshot);
    const discoveryPath = join(REPORTS_DIR, `new-rankings-${device}.json`);
    const discoveryReport = {
      generated_at: new Date().toISOString(),
      device,
      current_date: today,
      previous_date: prevSnapshot.date,
      new_count: discovery.newKeywords.length,
      lost_count: discovery.lostKeywords.length,
      new_keywords: discovery.newKeywords.map(k => ({
        keyword: k.keyword, position: k.position, volume: k.volume, url: k.url,
      })),
      lost_keywords: discovery.lostKeywords.map(k => ({
        keyword: k.keyword, position: k.position, volume: k.volume, url: k.url,
      })),
    };
    writeFileSync(discoveryPath, JSON.stringify(discoveryReport, null, 2));
    console.log(`  Discovery diff: ${discovery.newKeywords.length} new, ${discovery.lostKeywords.length} lost vs ${prevSnapshot.date} → ${discoveryPath}`);
  }

  // Write markdown report. When tracking both devices, write device-suffixed
  // reports; when a single device was requested, preserve the legacy filename
  // so anything that links to rank-tracker-report.md keeps working.
  const report = buildReport(entries, today, prevSnapshot?.date, discovery);
  const reportName = isSoleDevice ? 'rank-tracker-report.md' : `rank-tracker-report-${device}.md`;
  const reportPath = join(REPORTS_DIR, reportName);
  writeFileSync(reportPath, report);
  // When running both devices, also keep the canonical filename pointing at desktop
  // so downstream consumers that expect it continue to work.
  if (!isSoleDevice && device === 'desktop') {
    writeFileSync(join(REPORTS_DIR, 'rank-tracker-report.md'), report);
  }
  console.log(`  Report saved:   ${reportPath}`);

  const onPage1 = entries.filter((e) => e.position && e.position <= 10).length;
  const quickWins = entries.filter((e) => e.position && e.position > 10 && e.position <= 20).length;
  const notRanking = entries.filter((e) => !e.position).length;
  console.log(`  [${device}] Page 1: ${onPage1} | Quick wins: ${quickWins} | Not ranking: ${notRanking}`);

  return { device, entries };
}

async function main() {
  console.log(`\nRank Tracker — ${config.name}\n`);

  await loadGSC();
  if (gsc) {
    console.log('  GSC connected — will augment ranking data with Google Search Console metrics');
  } else {
    console.log('  ℹ️  GSC not configured — run: node scripts/gsc-auth.js to enable');
  }

  const today = new Date().toISOString().slice(0, 10);

  const blogIndex = loadBlogIndex();
  const posts = loadPublishedPosts();
  if (posts.length === 0) {
    console.log('  No published posts found in data/posts/. Run the publisher first.');
    process.exit(0);
  }
  console.log(`  Tracking ${posts.length} published post(s) across: ${DEVICES.join(', ')}`);

  const isSoleDevice = DEVICES.length === 1;
  const gscCache = new Map();

  for (const device of DEVICES) {
    await runForDevice({ device, today, posts, blogIndex, gscCache, isSoleDevice });
  }
}

main().then(() => {
  console.log('\nRank tracking complete.');
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
