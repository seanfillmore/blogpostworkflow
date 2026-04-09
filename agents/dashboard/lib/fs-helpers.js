// agents/dashboard/lib/fs-helpers.js
import { existsSync, mkdirSync } from 'node:fs';

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function kwToSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
