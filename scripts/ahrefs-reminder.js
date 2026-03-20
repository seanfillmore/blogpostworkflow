// scripts/ahrefs-reminder.js
/**
 * Ahrefs Upload Reminder
 * Sends Resend email 24h before rank tracker runs (Mon 07:00 UTC → fires Sun 07:00 UTC).
 * Usage: node scripts/ahrefs-reminder.js
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const DASHBOARD_URL = env.DASHBOARD_URL || process.env.DASHBOARD_URL || 'http://localhost:4242';
const AHREFS_DIR = join(ROOT, 'data', 'ahrefs');

function getLatestFile() {
  if (!existsSync(AHREFS_DIR)) return null;
  const files = readdirSync(AHREFS_DIR).filter(f => f.endsWith('.csv') || f.endsWith('.zip'));
  if (!files.length) return null;
  return files
    .map(f => ({ name: f, mtime: statSync(join(AHREFS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].name;
}

async function main() {
  const latest = getLatestFile();
  const currentFile = latest ? `Current file: ${latest}` : 'No file currently uploaded.';

  await notify({
    subject: 'Ahrefs CSV needed — rank tracker runs in 24 hours',
    body: `The rank tracker is scheduled to run in 24 hours (Monday 07:00 UTC).

${currentFile}

To upload a fresh Ahrefs export:
1. Ahrefs Site Explorer → Overview → Export CSV
2. Upload at: ${DASHBOARD_URL} (Optimize tab → Actions → Upload Ahrefs CSV)`,
    status: 'info',
  });

  console.log('Ahrefs reminder sent.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
