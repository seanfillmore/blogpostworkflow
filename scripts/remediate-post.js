#!/usr/bin/env node
/**
 * Remediate a pre-publish post that's hard-blocked by the editorial gate.
 *
 * Runs the SAME repair loop the daily pipeline (calendar-runner) uses — routing
 * each blocker to the agent that can fix it (citation-finder for uncited claims,
 * content-remediator for prose/factual issues, link-repair for broken links,
 * etc.), then re-running the editor — up to 3 attempts. Operates on the local
 * data/posts/<slug>/content.html; never auto-kills.
 *
 * This is what the dashboard's "Fix blockers" button invokes. For an already-
 * published LIVE post, use scripts/remediate-live-post.js (pulls/pushes Shopify).
 *
 * Usage:
 *   node scripts/remediate-post.js <slug>
 *
 * Exit code: 0 if the post passes the gate (or already passed), 1 if still blocked.
 */
import { existsSync } from 'node:fs';
import { getContentPath } from '../lib/posts.js';
import { checkEditGate, runEditGateWithRepair } from '../lib/edit-gate-repair.js';

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: node scripts/remediate-post.js <slug>');
  process.exit(1);
}
if (!existsSync(getContentPath(slug))) {
  console.error(`✗ No content found at ${getContentPath(slug)} — is the slug correct?`);
  process.exit(1);
}

const before = checkEditGate(slug);
if (before.pass) {
  console.log(`✓ ${slug} already passes the editorial gate — nothing to fix.`);
  process.exit(0);
}

console.log(`Remediating "${slug}"\n  Blocker: ${before.reason}\n`);
const { gate, attempts } = runEditGateWithRepair(slug, { maxAttempts: 3 });

if (gate.pass) {
  console.log(`\n✓ "${slug}" now PASSES the editorial gate after ${attempts} repair attempt(s).`);
  process.exit(0);
}
console.log(`\n✗ "${slug}" is still blocked after ${attempts} attempt(s): ${gate.reason}`);
console.log('  The remaining issue needs a human edit — open the editor report for details.');
process.exit(1);
