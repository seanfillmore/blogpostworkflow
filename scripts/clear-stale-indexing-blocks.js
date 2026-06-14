#!/usr/bin/env node
/**
 * Clear stale `indexing_blocked` flags left over from an infrastructure outage.
 *
 * Background: the indexing-fixer used to count errored Indexing API submissions
 * toward its "give up after 2 tries" escalation. A multi-day auth/scope 403
 * outage (early May 2026) therefore permanently blocked dozens of perfectly
 * indexable posts. The agent bug is fixed in lib/indexing-escalation.js; this
 * script clears the blocks the bug already wrote so the fixer retries them.
 *
 * A block is "stale" when it was produced by the submission-count escalation
 * (reason mentions "prior Indexing API submissions") but fewer than 2
 * submissions were ever actually DELIVERED to Google. Technical-misconfiguration
 * blocks (noindex, robots, canonical, page-fetch) are left intact.
 *
 * Idempotent: clearing an already-cleared post is a no-op.
 *
 * Usage:
 *   node scripts/clear-stale-indexing-blocks.js            # dry-run (default)
 *   node scripts/clear-stale-indexing-blocks.js --apply    # write changes
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStaleAuthBlock, countDeliveredSubmissions } from '../lib/indexing-escalation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');

const APPLY = process.argv.includes('--apply');

function main() {
  const slugs = readdirSync(POSTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const stale = [];
  const keptBlocked = [];

  for (const slug of slugs) {
    const metaPath = join(POSTS_DIR, slug, 'meta.json');
    if (!existsSync(metaPath)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { continue; }
    if (!meta.indexing_blocked) continue;

    if (isStaleAuthBlock(meta)) {
      stale.push(slug);
      if (APPLY) {
        meta.indexing_blocked = false;
        meta.indexing_blocked_reason = null;
        meta.indexing_unblocked_at = new Date().toISOString();
        meta.indexing_unblocked_by = 'clear-stale-indexing-blocks (auth-outage cleanup)';
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
    } else {
      keptBlocked.push({
        slug,
        delivered: countDeliveredSubmissions(meta.indexing_submissions, 'indexing_api'),
        reason: String(meta.indexing_blocked_reason || '').slice(0, 60),
      });
    }
  }

  console.log(`\nclear-stale-indexing-blocks — ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  console.log(`Stale auth blocks ${APPLY ? 'cleared' : 'to clear'} (${stale.length}):`);
  for (const s of stale) console.log(`  ✓ ${s}`);
  console.log(`\nGenuine blocks left intact (${keptBlocked.length}):`);
  for (const k of keptBlocked) console.log(`  • ${k.slug} (${k.delivered} delivered) — ${k.reason}`);
  if (!APPLY) console.log(`\nRe-run with --apply to write changes.`);
  console.log('');
}

main();
