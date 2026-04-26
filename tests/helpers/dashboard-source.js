import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read every .js source file under agents/dashboard/ and concatenate them.
 *
 * The dashboard was refactored from a 7000-line monolith into route + lib
 * modules. Symbol-existence tests that used to grep agents/dashboard/index.js
 * now need to grep the whole tree. Use this helper instead of readFileSync
 * on the (now-shimmed) index.js.
 */
export function readAllDashboardSource() {
  return walk('agents/dashboard');
}

const SRC_EXTS = ['.js', '.html', '.css'];

function walk(dir) {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out += walk(p);
    else if (SRC_EXTS.some((ext) => entry.endsWith(ext))) out += readFileSync(p, 'utf8') + '\n';
  }
  return out;
}
