#!/usr/bin/env node
/**
 * Competitor Watcher Agent
 *
 * Weekly scan of competitor blog feeds (Atom/RSS). Reports any new posts
 * published since the last run, maps them to our topical clusters, and
 * surfaces them in the morning digest. Outputs a signal file the
 * content-strategist can read to boost priorities for clusters where a
 * competitor just published.
 *
 * Files:
 *   config/competitors.json — [{ name, domain, feed }]
 *   data/competitor-watcher/state.json — last-seen post URL per competitor
 *   data/reports/competitor-watcher/YYYY-MM-DD.md — human-readable
 *   data/reports/competitor-watcher/latest.json — machine-readable signal
 *
 * Cron: weekly Sun 7:00 PM PT.
 *
 * Usage:
 *   node agents/competitor-watcher/index.js
 *   node agents/competitor-watcher/index.js --since 14   # look back N days on first run
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const CONFIG_PATH = join(ROOT, 'config', 'competitors.json');
const STATE_DIR = join(ROOT, 'data', 'competitor-watcher');
const STATE_PATH = join(STATE_DIR, 'state.json');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'competitor-watcher');
const POSTS_DIR = join(ROOT, 'data', 'posts');

const KNOWN_CLUSTERS = [
  'deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm',
  'coconut oil', 'shampoo', 'conditioner', 'sunscreen',
  'body wash', 'face cream', 'moisturizer', 'serum',
];

const SINCE_DAYS_ARG = (() => {
  const i = process.argv.indexOf('--since');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 14;
})();

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/**
 * Lightweight Atom/RSS parser. Returns [{ title, url, published_at }].
 * Avoids pulling in an XML parser dependency for a small known input shape.
 */
function parseFeed(xml) {
  const items = [];

  // Atom: <entry>...</entry>
  const entryRe = /<entry[\s\S]*?<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[0];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const linkHref = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const published = (block.match(/<published>([^<]+)<\/published>/) || block.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '';
    items.push({
      title: decodeXml(title.trim()),
      url: linkHref,
      published_at: published,
    });
  }

  // RSS 2.0: <item>...</item>
  if (items.length === 0) {
    const rssRe = /<item[\s\S]*?<\/item>/g;
    while ((m = rssRe.exec(xml)) !== null) {
      const block = m[0];
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
      const link = (block.match(/<link[^>]*>([^<]+)<\/link>/) || [])[1] || '';
      const published = (block.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1] || '';
      items.push({
        title: decodeXml(title.trim()),
        url: link.trim(),
        published_at: published,
      });
    }
  }

  return items;
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Map a post title to one or more clusters by keyword match.
 */
function inferClusters(title) {
  const t = title.toLowerCase();
  const matched = [];
  for (const c of KNOWN_CLUSTERS) {
    if (t.includes(c)) matched.push(c);
  }
  return matched;
}

/**
 * Returns the set of clusters our published posts target — used to flag
 * competitor posts that overlap with our existing inventory.
 */
function loadOwnClusters() {
  const ours = new Set();
  if (!existsSync(POSTS_DIR)) return ours;
  for (const f of readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const p = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
      for (const c of inferClusters(p.title || p.slug || '')) ours.add(c);
    } catch { /* ignore */ }
  }
  return ours;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SEOClaude-CompetitorWatcher/1.0)',
      'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  console.log('\nCompetitor Watcher Agent\n');

  if (!existsSync(CONFIG_PATH)) {
    console.error(`Missing ${CONFIG_PATH}. Add an array of { name, domain, feed }.`);
    process.exit(1);
  }
  const competitors = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    .filter((c) => c && c.feed);

  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  const state = loadJSON(STATE_PATH, { competitors: {} });
  const ourClusters = loadOwnClusters();
  const sinceTs = Date.now() - SINCE_DAYS_ARG * 86400000;

  const allNew = [];

  for (const c of competitors) {
    process.stdout.write(`  ${c.name} (${c.feed}) ... `);
    let xml;
    try {
      xml = await fetchFeed(c.feed);
    } catch (err) {
      console.log(`SKIP (${err.message})`);
      continue;
    }
    const entries = parseFeed(xml);
    if (!entries.length) { console.log('no entries'); continue; }

    const lastSeenUrl = state.competitors[c.domain]?.last_seen_url || null;
    const lastSeenTs = state.competitors[c.domain]?.last_seen_ts || sinceTs;

    // New = anything published after lastSeenTs and not yet recorded.
    const newPosts = [];
    for (const e of entries) {
      const ts = e.published_at ? Date.parse(e.published_at) : NaN;
      if (Number.isNaN(ts)) continue;
      if (ts <= lastSeenTs) continue;
      if (e.url === lastSeenUrl) continue;
      newPosts.push({
        ...e,
        clusters: inferClusters(e.title),
        overlaps_ours: inferClusters(e.title).some((cl) => ourClusters.has(cl)),
        competitor: c.name,
        competitor_domain: c.domain,
      });
    }

    // Update state to the most recent entry seen
    if (entries.length > 0) {
      const newest = [...entries]
        .filter((e) => Date.parse(e.published_at))
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
      if (newest) {
        state.competitors[c.domain] = {
          last_seen_url: newest.url,
          last_seen_ts: Date.parse(newest.published_at),
          last_checked_at: new Date().toISOString(),
        };
      }
    }

    console.log(`${newPosts.length} new`);
    allNew.push(...newPosts);
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  // ── Reports ─────────────────────────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# Competitor Activity — ${dateStr}`);
  lines.push('');
  lines.push(`Scanned ${competitors.length} competitor feed${competitors.length === 1 ? '' : 's'}. ${allNew.length} new post${allNew.length === 1 ? '' : 's'} since last run.`);
  lines.push('');

  if (allNew.length === 0) {
    lines.push('_No new competitor activity to report._');
  } else {
    // Group by competitor
    const byCompetitor = {};
    for (const p of allNew) (byCompetitor[p.competitor] = byCompetitor[p.competitor] || []).push(p);
    for (const [name, posts] of Object.entries(byCompetitor)) {
      lines.push(`## ${name}`);
      for (const p of posts) {
        const clusterTag = p.clusters.length ? ` _[${p.clusters.join(', ')}${p.overlaps_ours ? ' — OVERLAPS OURS' : ''}]_` : '';
        lines.push(`- [${p.title}](${p.url}) — ${p.published_at.slice(0, 10)}${clusterTag}`);
      }
      lines.push('');
    }
  }

  writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), lines.join('\n'));

  // Compute cluster boost signals (clusters where competitors published AND we have content)
  const clusterBoosts = {};
  for (const p of allNew) {
    for (const cl of p.clusters) {
      if (!ourClusters.has(cl)) continue;
      clusterBoosts[cl] = (clusterBoosts[cl] || 0) + 1;
    }
  }

  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    new_post_count: allNew.length,
    new_posts: allNew,
    cluster_boosts: clusterBoosts,
  }, null, 2));

  console.log(`\n  ${allNew.length} new competitor post${allNew.length === 1 ? '' : 's'} (${Object.keys(clusterBoosts).length} cluster boost signal${Object.keys(clusterBoosts).length === 1 ? '' : 's'})`);

  if (allNew.length > 0) {
    await notify({
      subject: `Competitor Activity: ${allNew.length} new post${allNew.length === 1 ? '' : 's'}`,
      body: allNew.slice(0, 10).map((p) => `${p.competitor}: ${p.title}${p.overlaps_ours ? ' [OVERLAPS]' : ''}`).join('\n'),
      status: 'info',
      category: 'seo',
    }).catch(() => {});
  }

  console.log('\nCompetitor watcher complete.');
}

main().catch((err) => {
  console.error('Competitor watcher failed:', err);
  process.exit(1);
});
