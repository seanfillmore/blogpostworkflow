#!/usr/bin/env node
/**
 * Batch Alt Text Fixer
 *
 * Runs fix-alt-text in a loop until all Shopify Files have alt text.
 * Designed to run on a cron (every 30 min) and exit when done.
 * Checks if there's remaining work before starting.
 *
 * Cron: every 30 min — cd ~/seo-claude && node scripts/fix-alt-text-batch.js >> data/logs/fix-alt-text.log 2>&1
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

console.log(`[${new Date().toISOString()}] Alt text batch fixer starting...`);

try {
  const output = execSync(`"${NODE}" agents/technical-seo/index.js fix-alt-text`, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000, // 10 min max
  });

  // Check if any work was done
  const fixedMatch = output.match(/Fixed:\s*(\d+)\s*(?:images|Shopify)/g);
  const totalFixed = fixedMatch
    ? fixedMatch.reduce((sum, m) => sum + parseInt(m.match(/\d+/)[0], 10), 0)
    : 0;

  console.log(`[${new Date().toISOString()}] Fixed ${totalFixed} items this run.`);

  if (totalFixed === 0) {
    console.log(`[${new Date().toISOString()}] No more work — alt text is up to date.`);
  }
} catch (e) {
  console.error(`[${new Date().toISOString()}] Error: ${e.message?.split('\n')[0]}`);
}
