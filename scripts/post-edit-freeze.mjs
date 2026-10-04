#!/usr/bin/env node
/**
 * Freeze a live article against discretionary edits, or list / lift freezes.
 * DRY BY DEFAULT.
 *
 *   node scripts/post-edit-freeze.mjs --list
 *   node scripts/post-edit-freeze.mjs --handle <h> --until 2026-11-14 --reason "..." [--apply]
 *   node scripts/post-edit-freeze.mjs --handle <h> --clear [--apply]
 *
 * A freeze is `edit_freeze: { until, reason, set_at }` in the post's state.json,
 * read by lib/post-edit-gate.js. While it holds, only `compliance` and `repair`
 * edits may touch the page: no title tests, rewrites, merges, refreshes, or
 * added links. It is written to EVERY local dir that could be the article, so a
 * shadow directory cannot carry an unfrozen copy.
 *
 * `--until` is required and capped at 120 days: a hold with no expiry is how a
 * pinned list and a held merge became outages nobody was looking for.
 *
 * Run on the SERVER: state.json is gitignored and server-authoritative.
 */
import { isDirectRun } from '../lib/is-direct-run.js';
import { candidateSlugs, readEditFacts } from '../lib/post-edit-gate.js';
import { listAllSlugs, getPostMeta, writePostMeta, replacePostMeta } from '../lib/posts.js';

export const MAX_FREEZE_DAYS = 120;

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const has = (name) => process.argv.includes(name);

export function validateUntil(until, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '')) throw new Error('--until must be YYYY-MM-DD');
  const t = Date.parse(`${until}T00:00:00.000Z`);
  const days = (t - now.getTime()) / 86400000;
  if (days <= 0) throw new Error('--until must be in the future');
  if (days > MAX_FREEZE_DAYS) throw new Error(`--until is ${Math.round(days)} days out; the cap is ${MAX_FREEZE_DAYS}`);
  return new Date(t).toISOString();
}

function main() {
  const apply = has('--apply');
  if (has('--list')) {
    const now = new Date().toISOString();
    let n = 0;
    for (const slug of listAllSlugs()) {
      const fz = getPostMeta(slug)?.edit_freeze;
      if (!fz) continue;
      n++;
      console.log(`${slug.padEnd(50)} until ${fz.until.slice(0, 10)}${fz.until < now ? ' (EXPIRED)' : ''}  ${fz.reason || ''}`);
    }
    if (!n) console.log('No frozen posts.');
    return;
  }
  const handle = arg('--handle');
  if (!handle) throw new Error('--handle is required (or --list)');
  const slugs = candidateSlugs(handle);
  if (!slugs.length) throw new Error(`no local post directory for "${handle}"`);

  if (has('--clear')) {
    console.log(`Clear freeze on ${slugs.join(', ')}`);
    if (!apply) return console.log('Dry run. Pass --apply to write.');
    for (const s of slugs) {
      const { edit_freeze: _drop, ...rest } = getPostMeta(s) || {};
      replacePostMeta(s, rest);
    }
    return console.log('Cleared.');
  }

  const reason = arg('--reason');
  if (!reason) throw new Error('--reason is required');
  const until = validateUntil(arg('--until'));
  const freeze = { until, reason, set_at: new Date().toISOString() };
  console.log(`Freeze ${slugs.join(', ')} until ${until.slice(0, 10)}: ${reason}`);
  if (!apply) return console.log('Dry run. Pass --apply to write.');
  for (const s of slugs) writePostMeta(s, { edit_freeze: freeze });
  const facts = readEditFacts(handle);
  console.log(`Verified: freeze until ${facts.freeze?.until?.slice(0, 10)}`);
}

if (isDirectRun(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
