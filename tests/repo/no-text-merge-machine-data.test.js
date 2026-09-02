// Machine-written data files must never be text-merged by git.
//
// On 2026-08-23 a `git stash pop` during a deploy wrote `<<<<<<<` markers inside
// data/rejected-keywords.json (9 agents parse it) and inside five
// data/posts/*/meta.json — all five invalid JSON on the production box, in one
// day. Every reader in this fleet `catch {}`s a parse failure and reads the file
// as EMPTY, so the corruption is silent.
//
// `-merge` in .gitattributes makes git keep our version and report a conflict
// instead of writing markers into the file. The conflict is still surfaced; the
// data stays valid. This test pins that the rule covers what it must and does
// NOT quietly cover source code, where a text merge is exactly what we want.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `merge: unset` is what `-merge` produces. `unspecified` means the normal
// text merge applies.
function mergeAttr(path) {
  const out = execFileSync('git', ['check-attr', 'merge', '--', path], { cwd: ROOT, encoding: 'utf8' });
  return out.trim().split(': ').pop();
}

test('every tracked path under data/ is protected from a text merge', () => {
  const tracked = execFileSync('git', ['ls-files', 'data'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  assert.ok(tracked.length > 0, 'expected tracked files under data/');

  const unprotected = tracked.filter((p) => mergeAttr(p) !== 'unset');
  assert.deepEqual(unprotected, [],
    'these tracked data files would be TEXT-MERGED by git, which is how production\n'
    + 'JSON was corrupted twice on 2026-08-23. Add the path to .gitattributes with\n'
    + '`-merge`:\n  ' + unprotected.join('\n  '));
});

test('the worst case is covered: content.html is pushed to Shopify', () => {
  // agents/publisher replaces a live article's body_html with this file, so a
  // conflict marker here is a conflict marker on a live indexed page — a strictly
  // worse outcome than the invalid JSON that motivated the rule.
  assert.equal(mergeAttr('data/posts/any-slug/content.html'), 'unset');
  assert.equal(mergeAttr('data/posts/any-slug/content-refreshed.html'), 'unset');
  assert.equal(mergeAttr('data/posts/any-slug/meta.json'), 'unset');
  assert.equal(mergeAttr('data/posts/any-slug/editor-report.md'), 'unset');
  assert.equal(mergeAttr('data/rejected-keywords.json'), 'unset');
});

test('source code is NOT covered — a text merge there is what we want', () => {
  for (const p of ['lib/posts.js', 'agents/publisher/index.js', 'package.json', 'CLAUDE.md']) {
    assert.equal(mergeAttr(p), 'unspecified', `${p} must still merge normally`);
  }
});
