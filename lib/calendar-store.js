/**
 * Canonical calendar store.
 *
 * The content calendar is stored as JSON at data/calendar/calendar.json. Markdown
 * (`data/reports/content-strategist/content-calendar.md`) is a rendered view —
 * agents should prefer reading/writing the JSON directly.
 *
 * For backwards compatibility, loadCalendar() falls back to parsing the legacy
 * markdown table if the JSON file does not exist, and writeCalendar() always
 * regenerates the markdown view after writing the JSON.
 *
 * Item schema:
 *   {
 *     slug: "natural-deodorant-for-men",
 *     keyword: "natural deodorant for men",
 *     title: "Best Natural Deodorant for Men",
 *     category: "Deodorant",
 *     content_type: "Blog Post — TOF",
 *     priority: "High",
 *     week: 1,
 *     publish_date: "2026-04-15T08:00:00-07:00", // ISO string
 *     original_publish_date: "2026-04-15T08:00:00-07:00", // preserved across adjustments
 *     kd: 2,
 *     volume: 1300,
 *     source: "gap_report",   // gap_report | quick_win | refresh | manual | competitor
 *     topical_hub: "deodorant",
 *     priority_score: 85,     // 0-100, higher = more important
 *     status_override: null,  // null | "paused" | "rush"
 *     added_at: "2026-04-08T00:00:00Z",
 *     last_updated: "2026-04-08T00:00:00Z"
 *   }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const CALENDAR_DIR = join(ROOT, 'data', 'calendar');
export const CALENDAR_JSON_PATH = join(CALENDAR_DIR, 'calendar.json');
export const CALENDAR_MD_PATH = join(ROOT, 'data', 'reports', 'content-strategist', 'content-calendar.md');

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Load the canonical calendar. Returns { generated_at, regenerated_at, items: [] }.
 * If JSON doesn't exist, parses the legacy markdown file and returns an equivalent
 * structure (without writing anything back to disk).
 */
export function loadCalendar() {
  if (existsSync(CALENDAR_JSON_PATH)) {
    try {
      return JSON.parse(readFileSync(CALENDAR_JSON_PATH, 'utf8'));
    } catch (err) {
      console.warn(`[calendar-store] failed to parse JSON (${err.message}), falling back to markdown`);
    }
  }
  return parseLegacyMarkdown();
}

/**
 * Write the canonical calendar JSON and regenerate the markdown view.
 * Pass { items, generated_at?, regenerated_at?, preserve_metadata? }.
 * If preserve_metadata is true and a JSON already exists, keeps existing
 * added_at/original_publish_date on items whose slug is unchanged.
 */
export function writeCalendar({ items, generated_at, regenerated_at, preserve_metadata = true, markdown_extras = '' }) {
  mkdirSync(CALENDAR_DIR, { recursive: true });

  const now = new Date().toISOString();
  const existing = preserve_metadata && existsSync(CALENDAR_JSON_PATH)
    ? (() => { try { return JSON.parse(readFileSync(CALENDAR_JSON_PATH, 'utf8')); } catch { return null; } })()
    : null;
  const existingBySlug = new Map((existing?.items || []).map((i) => [i.slug, i]));

  const normalized = items.map((item) => {
    const prev = existingBySlug.get(item.slug);
    return {
      slug: item.slug,
      keyword: item.keyword,
      title: item.title || null,
      category: item.category || null,
      content_type: item.content_type || item.contentType || null,
      priority: item.priority || 'Medium',
      week: item.week ?? null,
      publish_date: toIsoString(item.publish_date || item.publishDate),
      original_publish_date: prev?.original_publish_date || toIsoString(item.original_publish_date || item.publish_date || item.publishDate),
      kd: item.kd ?? null,
      volume: item.volume ?? null,
      source: item.source || prev?.source || 'gap_report',
      topical_hub: item.topical_hub || prev?.topical_hub || null,
      priority_score: item.priority_score ?? prev?.priority_score ?? null,
      status_override: item.status_override ?? prev?.status_override ?? null,
      status: 'status' in item ? item.status : (prev?.status ?? null),
      impressions: item.impressions ?? prev?.impressions ?? null,
      added_at: prev?.added_at || item.added_at || now,
      last_updated: now,
    };
  });

  const payload = {
    generated_at: generated_at || existing?.generated_at || now,
    regenerated_at: regenerated_at || now,
    items: normalized,
  };

  writeFileSync(CALENDAR_JSON_PATH, JSON.stringify(payload, null, 2));

  // Regenerate markdown view
  const md = renderMarkdown(payload, markdown_extras);
  mkdirSync(dirname(CALENDAR_MD_PATH), { recursive: true });
  writeFileSync(CALENDAR_MD_PATH, md);

  return payload;
}

/**
 * Update a single item in the calendar (by slug). Creates or updates.
 * Useful for quick-win targeter, competitor watcher, refresh runner, etc.
 */
export function upsertItem(item) {
  const calendar = loadCalendar();
  const idx = calendar.items.findIndex((i) => i.slug === item.slug);
  if (idx === -1) {
    calendar.items.push(item);
  } else {
    calendar.items[idx] = { ...calendar.items[idx], ...item, last_updated: new Date().toISOString() };
  }
  return writeCalendar({ items: calendar.items, preserve_metadata: true });
}

/**
 * Convenience: get items for a specific slug.
 */
export function getItem(slug) {
  const calendar = loadCalendar();
  return calendar.items.find((i) => i.slug === slug) || null;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function formatDisplayDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

/**
 * Render the calendar JSON back to the markdown format calendar-runner + dashboard
 * used to parse. Keeps column order identical for parser compatibility.
 */
function renderMarkdown(calendar, extras = '') {
  const generatedOn = formatDisplayDate(calendar.regenerated_at || calendar.generated_at || new Date().toISOString());

  const header = `# Content Calendar — Real Skin Care
**Generated:** ${generatedOn}
**Source of truth:** data/calendar/calendar.json (this file is auto-rendered)

---

## Publishing Schedule

| Week | Publish Date | Category | Target Keyword | Suggested Title | KD | Volume | Content Type | Priority |
|------|-------------|----------|----------------|-----------------|-----|--------|--------------|----------|
`;

  const sorted = [...(calendar.items || [])].sort((a, b) => {
    const da = a.publish_date ? new Date(a.publish_date).getTime() : Infinity;
    const db = b.publish_date ? new Date(b.publish_date).getTime() : Infinity;
    return da - db;
  });

  const rows = sorted.map((item) => {
    const cells = [
      item.week ?? '',
      formatDisplayDate(item.publish_date),
      item.category || '',
      item.keyword || '',
      item.title || '',
      item.kd ?? '',
      item.volume ? item.volume.toLocaleString('en-US') : '',
      item.content_type || '',
      item.priority || '',
    ];
    return `| ${cells.join(' | ')} |`;
  }).join('\n');

  return header + rows + '\n' + (extras ? '\n' + extras + '\n' : '');
}

/**
 * Fall back to parsing the legacy markdown table if no JSON exists yet.
 * Returns the same shape as loadCalendar().
 */
function parseLegacyMarkdown() {
  if (!existsSync(CALENDAR_MD_PATH)) {
    return { generated_at: null, regenerated_at: null, items: [] };
  }

  const md = readFileSync(CALENDAR_MD_PATH, 'utf8');
  const items = [];
  const tableRegex = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;

  for (const match of md.matchAll(tableRegex)) {
    const [, week, dateStr, category, keyword, title, kd, volume, contentType, priority] = match;
    if (week.trim() === 'Week' || week.trim() === '---') continue;
    const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
    if (!dm) continue;
    const publishDate = new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 08:00:00 GMT-0700`);
    const slug = keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    items.push({
      slug,
      keyword: keyword.trim(),
      title: title.trim(),
      category: category.trim(),
      content_type: contentType.trim(),
      priority: priority.trim(),
      week: parseInt(week.trim(), 10),
      publish_date: publishDate.toISOString(),
      original_publish_date: publishDate.toISOString(),
      kd: parseInt(kd.trim(), 10) || 0,
      volume: parseInt(volume.trim().replace(/,/g, ''), 10) || 0,
      source: 'gap_report',
      topical_hub: null,
      priority_score: null,
      status_override: null,
      added_at: null,
      last_updated: null,
    });
  }

  return { generated_at: null, regenerated_at: null, items };
}
