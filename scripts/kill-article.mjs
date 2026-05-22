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

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : 'killed via CLI';
const skipConfirm = args.includes('--yes');

if (!slug) {
  console.error('Usage: node scripts/kill-article.mjs <slug> [--reason "..."] [--yes]');
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

const result = await killPost(slug, { reason });

console.log('\nKill summary:');
for (const [k, v] of Object.entries(result)) {
  if (k === 'warnings') continue;
  console.log(`  ${k}: ${v}`);
}
if (result.warnings.length) {
  console.log('\nWarnings:');
  for (const w of result.warnings) console.log(`  - ${w}`);
}
