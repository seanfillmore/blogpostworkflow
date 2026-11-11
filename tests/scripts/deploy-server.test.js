import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PATH = new URL('../../scripts/deploy-server.sh', import.meta.url);
const src = readFileSync(PATH, 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('bash syntax is valid', () => {
  execFileSync('bash', ['-n', PATH.pathname]);
});

test('runs the reconcile gate against origin/main after a fetch', () => {
  assert.match(code, /git fetch origin/);
  assert.match(code, /node scripts\/reconcile-post-metas\.mjs --ref origin\/main/);
  assert.ok(code.indexOf('git fetch origin') < code.indexOf('--ref origin/main'));
});

test('snapshots before discarding meta.json, then pulls without rebase', () => {
  assert.match(code, /SNAP=\$\(node scripts\/reconcile-post-metas\.mjs --snapshot/);
  assert.match(code, /git checkout -- "data\/posts\/\*\/meta\.json"/);
  assert.match(code, /git pull --no-rebase/);
  assert.ok(code.indexOf('--snapshot') < code.indexOf('git checkout --'));
  assert.ok(code.indexOf('git checkout --') < code.indexOf('git pull --no-rebase'));
});

test('the pathspec is never unquoted', () => {
  assert.doesNotMatch(code, /git checkout -- data\/posts/);
});

test('reconcile --apply is joined to pm2 restart with ;', () => {
  assert.match(code, /--against "\$SNAP" --apply;\s*pm2 restart seo-dashboard/);
});

test('never stashes or hard-resets', () => {
  assert.doesNotMatch(code, /stash/);
  assert.doesNotMatch(code, /reset --hard/);
});

test('checks pm2 jlist for seo-dashboard online, within 20 seconds, else exits 1', () => {
  assert.match(code, /pm2 jlist/);
  assert.match(code, /seo-dashboard/);
  assert.match(code, /online/);
  assert.match(code, /seq 1 20/);
  assert.match(code, /exit 1/);
});

test('runs from the repo root, never over ssh', () => {
  assert.match(code, /cd "\$\(dirname "\$0"\)\/\.\."/);
  assert.doesNotMatch(code, /ssh /);
});
