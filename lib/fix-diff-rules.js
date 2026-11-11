/**
 * Deterministic guard over the diff an autonomous fix session produced. A fix
 * must not weaken a gate, delete or soften a test, touch production data or
 * config, or grow past a reviewable size. Pure: takes `git diff --numstat` and
 * the unified patch, returns every problem found (an LLM's own "this is safe"
 * is never consulted).
 */
export const FORBIDDEN_PATHS = ['data/', '.env', 'theme/', 'config/', 'scripts/setup-cron.sh'];
export const GATE_FILES = [
  'agents/ad-studio/health-claims.js',
  'lib/seo-copy-health-gate.js',
  'lib/product-category-terms.js',
  'lib/content-mirror.js',
  'lib/post-lock.js',
  'lib/post-edit-gate.js',
  'lib/cluster-hold.js',
];
const MAX_LINES = 300;

const forbidden = (p) => FORBIDDEN_PATHS.some((f) => (f.endsWith('/') || f === '.env' ? p.startsWith(f) : p === f));

export function checkFixDiff({ numstat = '', patch = '' } = {}) {
  const problems = [];
  const files = [];
  let total = 0;
  for (const line of String(numstat).split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const path = rest.join('\t').trim();
    if (!path) continue;
    files.push(path);
    total += (parseInt(a, 10) || 0) + (parseInt(d, 10) || 0);
  }
  if (!files.length && !String(patch).trim()) return { ok: false, problems: ['no change'] };

  for (const p of files) {
    if (forbidden(p)) problems.push(`touches forbidden path: ${p}`);
    if (GATE_FILES.includes(p)) problems.push(`touches gate file: ${p}`);
  }
  if (total > MAX_LINES) problems.push(`diff too large: ${total} changed lines (max ${MAX_LINES})`);
  if (!files.some((p) => p.startsWith('tests/'))) problems.push('no test added or modified');

  let curFile = '';
  for (const line of String(patch).split('\n')) {
    const h = line.match(/^diff --git a\/(\S+) b\//);
    if (h) { curFile = h[1]; continue; }
    if (line.startsWith('deleted file mode') && curFile.startsWith('tests/')) {
      problems.push(`deleted test file: ${curFile}`);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const added = line.startsWith('+');
    const removed = line.startsWith('-');
    if (!added && !removed) continue;
    const body = line.slice(1);
    if (removed && curFile.startsWith('tests/') && /assert/.test(body)) problems.push(`removed assertion in ${curFile}`);
    if (added && (/\.skip\(/.test(body) || /\{\s*skip/.test(body) || /(?:test|it)\.todo/.test(body))) {
      problems.push(`added skip/todo: ${body.trim()}`);
    }
    if (/status:\s*['"]/.test(body)) problems.push(`notify status changed: ${body.trim()}`);
  }
  return { ok: problems.length === 0, problems };
}
