/**
 * Pipeline Scheduler Agent
 *
 * Reads the content calendar, finds keywords due for a brief in the next 14 days,
 * and runs content-researcher for the first one that doesn't already have a brief.
 * Runs at most 1 brief per execution to avoid API overuse.
 *
 * Usage:
 *   node agents/pipeline-scheduler/index.js
 *   node agents/pipeline-scheduler/index.js --dry-run   (show what would run, skip research)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CALENDAR_PATH = join(ROOT, 'data', 'reports', 'content-strategist', 'content-calendar.md');
const BRIEFS_DIR    = join(ROOT, 'data', 'briefs');

function kwToSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseCalendar() {
  if (!existsSync(CALENDAR_PATH)) return [];
  const md = readFileSync(CALENDAR_PATH, 'utf8');
  const rows = [];
  const re = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  for (const m of md.matchAll(re)) {
    const [, week, dateStr, , keyword] = m;
    if (week.trim() === 'Week' || week.trim() === '---') continue;
    const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
    if (!dm) continue;
    rows.push({
      keyword: keyword.trim(),
      slug: kwToSlug(keyword.trim()),
      publishDate: new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 08:00:00 GMT-0700`),
    });
  }
  return rows;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('Pipeline Scheduler' + (dryRun ? ' (dry run)' : ''));

  if (!existsSync(CALENDAR_PATH)) {
    console.log('No content calendar found. Run content-strategist first.');
    return;
  }

  const rows = parseCalendar();
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 86400000);

  // Find keywords due within 14 days with no brief
  const due = rows.filter(r =>
    r.publishDate >= now &&
    r.publishDate <= horizon &&
    !existsSync(join(BRIEFS_DIR, `${r.slug}.json`))
  );

  if (!due.length) {
    console.log('No briefs needed in the next 14 days.');
    return;
  }

  const target = due[0]; // process one per run
  console.log(`Brief needed: "${target.keyword}" (due ${target.publishDate.toDateString()})`);

  if (dryRun) {
    console.log('[dry-run] Would run: node agents/content-researcher/index.js "' + target.keyword + '"');
    return;
  }

  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'agents', 'content-researcher', 'index.js'), target.keyword],
    { stdio: 'inherit', cwd: ROOT }
  );

  if (result.error) {
    const msg = `content-researcher failed to launch: ${result.error.message}`;
    await notify({ subject: `Brief FAILED: "${target.keyword}"`, body: msg, status: 'error' });
    console.error(msg);
    process.exit(1);
  } else if (result.status === 0) {
    await notify({
      subject: `Brief ready: "${target.keyword}"`,
      body: `Pipeline scheduler created brief for "${target.keyword}".\nSlug: ${target.slug}`,
      status: 'success',
    });
    console.log('Brief created and notification sent.');
  } else {
    const reason = result.signal ? `killed by signal ${result.signal}` : `exited with status ${result.status}`;
    await notify({ subject: `Brief FAILED: "${target.keyword}"`, body: `content-researcher ${reason}`, status: 'error' });
    console.error('content-researcher failed:', reason);
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
