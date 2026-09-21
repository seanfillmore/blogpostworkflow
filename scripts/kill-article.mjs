#!/usr/bin/env node
/**
 * Kill an article from anywhere in the pipeline (briefed, written, scheduled,
 * or published). See lib/post-kill.js for the full kill flow.
 *
 * Usage:
 *   node scripts/kill-article.mjs <slug>
 *   node scripts/kill-article.mjs <slug> --reason "off product scope"
 *
 * Always confirms before acting. Pass --yes to skip the prompt.
 */

import { killPost } from '../lib/post-kill.js';
import { createInterface } from 'readline';
import { positionalArg } from '../lib/positional-arg.js';

const args = process.argv.slice(2);
// positionalArg, not args.find: `--reason <text>` would otherwise be read as the slug.
const slug = positionalArg(args, ['--reason', '--redirect-to']);
const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : 'killed via CLI';
const skipConfirm = args.includes('--yes');
// Optional. A LIVE article is redirected either way — killPost derives the
// destination from the page's own buy box when this is absent, and refuses the
// delete outright if no redirect can be created.
const redirectIdx = args.indexOf('--redirect-to');
const redirectTo = redirectIdx !== -1 ? args[redirectIdx + 1] : null;

if (!slug) {
  console.error('Usage: node scripts/kill-article.mjs <slug> [--reason "..."] [--redirect-to /collections/x] [--yes]');
  process.exit(1);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

console.log(`\nAbout to kill: ${slug}`);
console.log(`Reason: ${reason}`);
console.log('This will:');
console.log('  - Delete the article from Shopify if uploaded');
console.log('  - Reject the target keyword (strategist will never re-propose)');
console.log('  - Delete the local post directory + brief + rejected images');
console.log('  - Remove from calendar.json');

if (!skipConfirm) {
  const answer = await confirm('\nProceed? (y/N) ');
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }
}

const result = await killPost(slug, { reason, redirectTo });

console.log('\nKill summary:');
for (const [k, v] of Object.entries(result)) {
  if (k === 'warnings') continue;
  console.log(`  ${k}: ${v}`);
}
if (result.warnings.length) {
  console.log('\nWarnings:');
  for (const w of result.warnings) console.log(`  - ${w}`);
}
