/**
 * Ahrefs CSV export parser.
 * Reads domain overview metrics from manually-placed CSV exports in data/ahrefs/.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parseAhrefsOverview(csvText) {
  if (!csvText || !csvText.trim()) return null;
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const values  = lines[1].split(',').map(v => v.trim().replace(/"/g, ''));

  const row = {};
  headers.forEach((h, i) => { row[h] = values[i] ?? null; });

  const find = (...keys) => {
    for (const k of keys) {
      const v = row[k.toLowerCase()];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  return {
    domainRating:        find('domain rating', 'dr'),
    backlinks:           find('backlinks', 'all backlinks'),
    referringDomains:    find('referring domains', 'ref domains', 'refdomains'),
    organicTrafficValue: find('organic traffic value', 'traffic value'),
  };
}

export function loadLatestAhrefsOverview(dir) {
  if (!existsSync(dir)) return null;
  const csvFiles = readdirSync(dir)
    .filter(f => f.endsWith('.csv'))
    .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!csvFiles.length) return null;
  const text = readFileSync(join(dir, csvFiles[0].f), 'utf8');
  return parseAhrefsOverview(text);
}
