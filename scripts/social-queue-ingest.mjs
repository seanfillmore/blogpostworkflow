#!/usr/bin/env node
/**
 * Queue a finished ad batch for the Social tab (Instagram + Facebook Page).
 *
 *   node scripts/social-queue-ingest.mjs --batch "<ad batch dir>"          # dry run
 *   node scripts/social-queue-ingest.mjs --batch "<ad batch dir>" --apply  # caption, upload, queue
 *
 * Run on the Mac (it needs the image files). Every KEPT image in the batch's
 * run.json becomes a PENDING item on the production dashboard, with a suggested
 * caption grounded in the batch's meta-copy.md; nothing posts until Sean approves
 * it in the Social tab. Already-queued images (by id or source file) are skipped
 * before any upload, so a re-run is safe. agents/ad-batch runs this automatically
 * at the end of a successful batch. Logic: lib/social-ingest.js.
 *
 * Env (.env): DASHBOARD_USER, DASHBOARD_PASSWORD, Shopify credentials (for the
 * upload), SOCIAL_QUEUE_URL (optional; defaults to the dashboard's public URL).
 */

import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { ingestBatch, remoteQueue, DEFAULT_REMOTE_URL, rerunCommand } from '../lib/social-ingest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  try {
    return Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  } catch { return {}; }
}

/** The real dependencies. Shopify and the model are only loaded for --apply. */
export async function liveDeps({ apply, log = console.log }) {
  const env = { ...loadEnv(), ...process.env };
  const remote = remoteQueue({ url: env.SOCIAL_QUEUE_URL || DEFAULT_REMOTE_URL, user: env.DASHBOARD_USER, pass: env.DASHBOARD_PASSWORD });
  if (!apply) return { remote, log };
  const { default: sharp } = await import('sharp');
  const { uploadFileToShopify } = await import('../lib/shopify.js');
  const { default: Anthropic } = await import('../lib/anthropic.js');
  const work = mkdtempSync(join(tmpdir(), 'social-queue-'));
  return {
    remote,
    log,
    anthropic: new Anthropic(),
    toJpeg: async (file, id) => {
      const out = join(work, `${id}.jpg`);
      await sharp(file).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toFile(out);
      return out;
    },
    upload: (jpg, { alt }) => uploadFileToShopify(jpg, { mimeType: 'image/jpeg', alt }),
  };
}

export async function runIngest({ batchDir, apply = false, log = console.log }) {
  const deps = await liveDeps({ apply, log });
  return ingestBatch({ batchDir: resolve(batchDir), apply, deps });
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--batch');
  const batchDir = i !== -1 ? args[i + 1] : null;
  if (!batchDir) { console.error('Usage: node scripts/social-queue-ingest.mjs --batch "<ad batch dir>" [--apply]'); process.exit(64); }
  const apply = args.includes('--apply');
  console.log(`Social queue ingest${apply ? '' : ' (dry run)'}: ${batchDir}`);
  const s = await runIngest({ batchDir, apply });
  console.log(`\n${s.kept} kept image(s): ${s.already.length} already queued, ${apply ? `${s.created.length} added, ${s.failed.length} failed` : `${s.wouldAdd.length} would be added`}${s.missing.length ? `, ${s.missing.length} file(s) missing` : ''}.`);
  if (s.uncaptioned.length) console.log(`${s.uncaptioned.length} added with no suggested caption (write one in the Social tab).`);
  if (s.failed.length) { console.log(`Re-run to retry: ${rerunCommand(batchDir)}`); process.exit(1); }
  if (!apply && s.wouldAdd.length) console.log(`Apply with: ${rerunCommand(batchDir)}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
