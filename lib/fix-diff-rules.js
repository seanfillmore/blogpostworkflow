/**
 * Deterministic guard over the diff an autonomous fix session produced. A fix
 * must not weaken a gate, delete or soften a test, touch production data,
 * config or this guard's own machinery, or grow past a reviewable size. Pure:
 * takes `git diff --numstat` and the unified patch, returns every problem
 * found (an LLM's own "this is safe" is never consulted). Renames are checked
 * on BOTH the old and the new path.
 */
export const FORBIDDEN_PATHS = ['data/', 'theme/', 'config/', 'scripts/setup-cron.sh', '.env*'];
export const GATE_FILES = [
  'agents/ad-studio/health-claims.js',
  'lib/seo-copy-health-gate.js',
  'lib/product-category-terms.js',
  'lib/content-mirror.js',
  'lib/post-lock.js',
  'lib/post-edit-gate.js',
  'lib/cluster-hold.js',
];
// The reviewer's own machinery: a fix may not edit the thing that judges it.
export const GUARD_FILES = [
  'lib/fix-diff-rules.js', 'lib/fix-session.js', 'lib/fix-ship.js', 'lib/github-pr.js',
  'lib/low-demand-removal.js', 'lib/recap-review.js', 'lib/recap-jobs.js',
  'lib/recap-reviewer-state.js', 'lib/growth-recs.js',
  'scripts/deploy-server.sh', 'package.json', 'package-lock.json',
  '.gitignore', '.gitattributes', '.nvmrc',
];
export const GUARD_PREFIXES = ['agents/recap-reviewer/', '.github/'];
const MAX_LINES = 300;

const clean = (p) => String(p || '').trim().replace(/^"|"$/g, '').replace(/^\.\//, '');

function forbiddenReason(p) {
  if (FORBIDDEN_PATHS.some((f) => (f.endsWith('/') ? p.startsWith(f) : f === '.env*' ? false : p === f))) return 'forbidden path';
  if (p.split('/').some((seg) => seg.startsWith('.env'))) return 'forbidden path';
  if (GATE_FILES.includes(p)) return 'gate file';
  if (GUARD_FILES.includes(p) || GUARD_PREFIXES.some((x) => p.startsWith(x))) return 'protected guard file';
  return null;
}

// numstat path: `a`, `a => b`, or `pre{a => b}post`. Returns every path named.
function numstatPaths(raw) {
  const m = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (m) {
    const j = (mid) => (m[1] + mid + m[4]).replace(/\/\//g, '/');
    return [j(m[2]), j(m[3])];
  }
  if (raw.includes(' => ')) return raw.split(' => ').map(clean);
  return [raw];
}

export function checkFixDiff({ numstat = '', patch = '' } = {}) {
  const problems = [];
  const newPaths = new Set();
  const allPaths = new Set();
  let total = 0;
  for (const line of String(numstat).split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const raw = rest.join('\t').trim();
    if (!raw) continue;
    const ps = numstatPaths(raw).map(clean);
    ps.forEach((p) => allPaths.add(p));
    newPaths.add(ps[ps.length - 1]);
    total += (parseInt(a, 10) || 0) + (parseInt(d, 10) || 0);
  }
  for (const line of String(patch).split('\n')) {
    const h = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (h) { allPaths.add(clean(h[1])); allPaths.add(clean(h[2])); }
  }
  if (!allPaths.size && !String(patch).trim()) return { ok: false, problems: ['no change'] };

  for (const p of allPaths) {
    const r = forbiddenReason(p);
    if (r) problems.push(`touches ${r}: ${p}`);
  }
  if (total > MAX_LINES) problems.push(`diff too large: ${total} changed lines (max ${MAX_LINES})`);
  if (![...newPaths].some((p) => p.startsWith('tests/'))) problems.push('no test added or modified');

  let curFile = '';
  let inHeader = false;
  for (const line of String(patch).split('\n')) {
    const h = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (h) { curFile = clean(h[2]); inHeader = true; continue; }
    if (line.startsWith('@@')) { inHeader = false; continue; }
    if (inHeader && (line.startsWith('--- ') || line.startsWith('+++ '))) continue;
    if (line.startsWith('deleted file mode') && curFile.startsWith('tests/')) {
      problems.push(`deleted test file: ${curFile}`);
      continue;
    }
    const added = line.startsWith('+');
    const removed = line.startsWith('-');
    if (!added && !removed) continue;
    const body = line.slice(1);
    const inTests = curFile.startsWith('tests/');
    if (removed && inTests && /assert/.test(body)) problems.push(`removed assertion in ${curFile}`);
    if (added && (/\.skip\(/.test(body) || /\{\s*skip/.test(body) || /(?:test|it)\.todo/.test(body))) {
      problems.push(`added skip/todo: ${body.trim()}`);
    }
    if (added && inTests && (/\.only\(/.test(body) || /\bxit\(/.test(body) || /\bxtest\(/.test(body))) {
      problems.push(`added only/xit/xtest: ${body.trim()}`);
    }
    if (!inTests && /\bstatus\s*[:=]/.test(body) && /(error|info|success|warning)/.test(body)) {
      problems.push(`notify status changed: ${body.trim()}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
