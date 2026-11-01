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
 *
 * That schema is what writeCalendar() NORMALISES. It is not the whole item:
 * anything else a producer sets is preserved verbatim — see OWNED_FIELDS below.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// SEO_CLAUDE_ROOT exists purely for test isolation — lets a test redirect this
// module's file reads/writes to a scratch directory instead of the real repo.
// Production never sets it, so the fallback below is what every real run resolves to.
const ROOT = process.env.SEO_CLAUDE_ROOT || join(__dirname, '..');

export const CALENDAR_DIR = join(ROOT, 'data', 'calendar');
export const CALENDAR_JSON_PATH = join(CALENDAR_DIR, 'calendar.json');
export const CALENDAR_MD_PATH = join(ROOT, 'data', 'reports', 'content-strategist', 'content-calendar.md');

/**
 * The fields `writeCalendar` OWNS — the ones it normalises, defaults and is
 * responsible for on every write. **Everything else an agent sets is PRESERVED.**
 *
 * THIS IS A LIST OF WHAT THIS FUNCTION OWNS, NEVER A LIST OF WHAT TO KEEP, and
 * the direction is the whole point — the same rule CLAUDE.md records for
 * `data/posts/<slug>/meta.json` after `agents/blog-post-writer` destroyed 23
 * fields per redraft through an allowlist of 11 keys. An allowlist of what to
 * KEEP has to be updated by everyone who adds a field and loses data silently
 * when they forget. That is exactly what happened here: `writeCalendar`
 * rebuilt every item as a fresh object literal, so at least SEVEN fields real
 * producers set were destroyed on every write —
 *
 *   possible_duplicate, ranked_match, duplicate_tier, duplicate_of
 *     (agents/gsc-opportunity, agents/pipeline-prioritizer, lib/pipeline-priority.js)
 *   validation_source, search_intent, task_type
 *
 * — which is why `agents/pipeline-prioritizer`'s `possible_duplicate` read,
 * commented as "carried into the backlog so the demotion holds on every later
 * run", always saw `false`. `upsertItem`'s merge was pointless for all of them:
 * it merged correctly and then handed the merge here to be normalised away.
 *
 * Forget to update THIS list and the worst case is an un-normalised field
 * nobody classified, never a field nobody kept.
 */
const OWNED_FIELDS = Object.freeze([
  // The normalised schema, in the order it is written.
  'slug', 'keyword', 'title', 'category', 'content_type', 'priority', 'week',
  'publish_date', 'original_publish_date', 'kd', 'volume', 'source',
  'topical_hub', 'priority_score', 'status_override', 'status', 'impressions',
  'added_at', 'last_updated',
  // camelCase INPUT spellings the normaliser already reads (see `content_type`
  // and `publish_date` below). They are owned for the same reason: preserving
  // one would leave a second, un-normalised copy of a field just written.
  'contentType', 'publishDate',
]);

const OWNED = new Set(OWNED_FIELDS);

/** Every field on `obj` that `writeCalendar` does not own. */
function unownedFields(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of Object.keys(obj)) {
    if (!OWNED.has(key)) out[key] = obj[key];
  }
  return out;
}

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
 *
 * PRESERVE-BY-DEFAULT: only the fields in OWNED_FIELDS are normalised. Any
 * other field, on the incoming item or on the one already stored, survives.
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
      // Unowned fields, PREV FIRST so the incoming item wins on any key it
      // actually carries — including an explicit `false` or `null`, which is how
      // a producer CLEARS a flag (`possible_duplicate: Boolean(...)`). Falling
      // back to `prev` is what stops a caller that passes a PARTIAL item from
      // erasing evidence it never knew about: `agents/pipeline-prioritizer`'s
      // promote step sends four fields and nothing else. Same direction as the
      // `prev?.` fallbacks on source/status/impressions/added_at below, and only
      // reachable when `preserve_metadata` is on — with it off there is no `prev`
      // to read and the item stands alone, which is what the flag means.
      ...unownedFields(prev),
      ...unownedFields(item),
      // The owned fields are written LAST: a normalised value can never be
      // shadowed by a raw one, whatever the spreads above contain.
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
