#!/usr/bin/env node
/**
 * Render every spec in data/brand/email-rebuild/specs.js to <id>.after.html.
 *
 *   node scripts/build-emails.mjs            # build all specs
 *   node scripts/build-emails.mjs SHb8Df     # build one
 *
 * Then verify before pasting:
 *   node scripts/verify-email-rebuild.mjs --all --redesign
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEmail } from '../lib/email-render.js';
import { specs } from '../data/brand/email-rebuild/specs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/brand/email-rebuild');

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ids = only.length ? only : Object.keys(specs);

let failed = 0;
for (const id of ids) {
  const spec = specs[id];
  if (!spec) {
    console.error(`${id}: no spec`);
    failed++;
    continue;
  }
  try {
    const html = renderEmail(spec);
    writeFileSync(join(DIR, `${id}.after.html`), html);
    console.log(`${id}  ${String(html.length).padStart(5)} bytes  ${spec.format.padEnd(8)} ${spec.name}`);
  } catch (e) {
    console.error(`${id}  ✗ ${e.message}`);
    failed++;
  }
}

console.log(`\n${ids.length - failed}/${ids.length} built`);
process.exit(failed ? 1 : 0);
