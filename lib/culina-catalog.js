// lib/culina-catalog.js
//
// Pure helpers for the Culina monthly inventory report: brand classification,
// component rollup from config/culina-cogs.json `contents`, and the report
// config. Only loadReportConfig touches disk.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = join(ROOT, 'config', 'culina-report.json');

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Throws on a missing or unparseable file. */
export function loadReportConfig(path = DEFAULT_CONFIG) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Brand rule from CLAUDE.md: `culina` or `cast iron` in the title. */
export function isCulinaTitle(title) {
  const t = norm(title);
  return t.includes('culina') || t.includes('cast iron');
}

export function components(asin, cogsTable) {
  const contents = cogsTable?.[asin]?.contents;
  return Array.isArray(contents) ? contents.map(norm).filter(Boolean) : [];
}

export function componentRollup(unitsByAsin, cogsTable) {
  const out = {};
  for (const [asin, units] of Object.entries(unitsByAsin || {})) {
    for (const c of components(asin, cogsTable)) out[c] = (out[c] || 0) + units;
  }
  return out;
}

export function isSourced(component, config) {
  return (config?.sourced_components || []).map(norm).includes(norm(component));
}
