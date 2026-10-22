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

test('publisher stamps founder note uses on both publish paths', () => {
  const src = readFileSync('agents/publisher/index.js', 'utf8');
  assert.match(src, /import\s*\{[^}]*stampFounderNoteUses[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/founder-notes-store\.js'/);
  assert.equal((src.match(/stampFounderNoteUses\(\{/g) || []).length, 2);
  assert.match(src, /text:\s*articleFields\.body_html/);
  assert.match(src, /text:\s*refreshedHtml/);
  assert.match(src, /meta\.founder_notes_used\s*=/);
  // stamped after the Shopify write, before the meta save
  assert.ok(src.indexOf('createArticle(blogId, articleFields)') < src.indexOf('text: articleFields.body_html'));
  assert.ok(src.indexOf('text: articleFields.body_html') < src.indexOf('replacePostMeta(metaPath, meta)'));
});

test('press-outreach stamps founder note uses right after the real send markSent', () => {
  const src = readFileSync('agents/press-outreach/index.js', 'utf8');
  assert.match(src, /import\s*\{[^}]*stampFounderNoteUses[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/founder-notes-store\.js'/);
  assert.equal((src.match(/stampFounderNoteUses\(\{/g) || []).length, 1);
  const sent = src.indexOf('could not save sent draft');
  const stamp = src.indexOf('stampFounderNoteUses({');
  assert.ok(sent > 0 && stamp > sent);
  assert.match(src, /surface:\s*'commercial',\s*ref:\s*d\.id/);
  // not in the repair path
  assert.ok(src.indexOf('could not repair sent draft') < sent);
  assert.ok(stamp - sent < 1500);
});

test('queue-apply injects stampFounderNoteUses as a dep', () => {
  const src = readFileSync('lib/queue-apply.js', 'utf8');
  assert.match(src, /deps\.stampFounderNoteUses\s*\|\|\s*stampFounderNoteUses/);
});
