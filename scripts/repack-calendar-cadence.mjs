#!/usr/bin/env node
/**
 * Re-pack the content calendar onto the current publish days
 * (lib/publish-schedule.js PUBLISH_DAYS). Dry by default; `--apply` writes.
 *
 * Why: changing the cadence (2/week -> 4/week, operator decision 2026-10-14)
 * only changes how NEW items are dated. Items already on the calendar keep their
 * old spacing, so without this the new cadence would take months to show up.
 *
 * FIXED, never moved:
 *   - anything with a Shopify article (draft, scheduled or published), because
 *     its publish time already lives on Shopify;
 *   - anything dated inside calendar-runner's lead window (BUFFER_DAYS, from
 *     config/pipeline-priority.json), because it may already be mid-draft.
 * Everything else that is dated and unpublished is re-dated, in its existing
 * order, onto the next free publish days after the lead window. Undated backlog
 * is untouched: pipeline-prioritizer slots that.
 *
 * Run on the server (the calendar and post state are server-written). The
 * calendar is backed up to data/calendar/backups/ before the write.
 */
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCalendar, writeCalendar, CALENDAR_JSON_PATH, CALENDAR_DIR } from '../lib/calendar-store.js';
import { getPostMeta } from '../lib/posts.js';
import { slotsFrom } from '../lib/publish-schedule.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;

/** Pure: returns [{ slug, from, to }] for the items that move. */
export function planRepack(items, { now = new Date(), leadDays = 7, onShopify = () => false } = {}) {
  const leadEnd = now.getTime() + leadDays * DAY;
  const dated = items.filter((i) => i?.publish_date);
  const fixed = dated.filter((i) => onShopify(i.slug) || Date.parse(i.publish_date) <= leadEnd);
  const movable = dated
    .filter((i) => !fixed.includes(i) && Date.parse(i.publish_date) > now.getTime())
    .sort((a, b) => a.publish_date.localeCompare(b.publish_date));
  const taken = new Set(fixed.map((i) => i.publish_date.slice(0, 10)));
  const next = slotsFrom(new Date(leadEnd + DAY), taken);
  const moves = [];
  for (const i of movable) {
    const to = next().toISOString();
    if (to !== i.publish_date) moves.push({ slug: i.slug, from: i.publish_date, to });
  }
  return moves;
}

async function main() {
  const apply = process.argv.includes('--apply');
  let leadDays = 7;
  try { leadDays = JSON.parse(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8')).buffer?.days ?? 7; } catch {}
  const cal = loadCalendar();
  const onShopify = (slug) => { try { return Boolean(getPostMeta(slug)?.shopify_article_id); } catch { return false; } };
  const moves = planRepack(cal.items, { leadDays, onShopify });
  for (const m of moves) console.log(`  ${m.from.slice(0, 10)} -> ${m.to.slice(0, 10)}  ${m.slug}`);
  console.log(`\n${moves.length} item(s) re-dated (lead window ${leadDays} days).`);
  if (!apply) { console.log('Dry run. Re-run with --apply to write the calendar.'); return; }
  if (!moves.length) return;
  mkdirSync(join(CALENDAR_DIR, 'backups'), { recursive: true });
  copyFileSync(CALENDAR_JSON_PATH, join(CALENDAR_DIR, 'backups', `calendar-before-repack-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const to = new Map(moves.map((m) => [m.slug, m.to]));
  writeCalendar({ items: cal.items.map((i) => (to.has(i.slug) ? { ...i, publish_date: to.get(i.slug) } : i)), preserve_metadata: true });
  console.log('Calendar written.');
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
