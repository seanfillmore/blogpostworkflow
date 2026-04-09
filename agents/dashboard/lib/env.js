// agents/dashboard/lib/env.js
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

export function loadEnvAuth() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

export function hydrateProcessEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
}
