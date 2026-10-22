import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIELD_OWNERS } from '../../lib/post-meta-reconcile.js';

// Source scan: importing an agent runs it.
for (const file of ['agents/blog-post-writer/index.js', 'agents/content-refresher/index.js']) {
  test(`${file} feeds founder notes and stamps what was offered`, () => {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /import\s*\{[^}]*founderNotesFor[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/founder-notes-store\.js'/);
    assert.doesNotMatch(src, /function loadFounderNotesFor/);
    assert.match(src, /founderNotesFor\(\{/);
    assert.match(src, /founder_notes_offered/);
    assert.match(src, /writePostMeta\(slug,\s*\{\s*founder_notes_offered/);
  });
}

test('founder note stamps are server-owned post fields', () => {
  assert.equal(FIELD_OWNERS.founder_notes_offered, 'server');
  assert.equal(FIELD_OWNERS.founder_notes_used, 'server');
});
