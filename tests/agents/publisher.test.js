import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Lives in lib/posts.js rather than the agent: it is a posts-layout concern, and
// two agents got it wrong independently — publisher derived the slug as "meta",
// and blog-post-verifier was then handed that same path where it wanted a slug.
import { slugFromMetaPath } from '../../lib/posts.js';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'publisher', 'index.js');

// The publisher derived its slug as `meta.slug || basename(metaPath, '.json')`.
// That fallback was written for the old flat layout (data/posts/<slug>.json). Under
// the current per-directory layout (data/posts/<slug>/meta.json) it evaluates to the
// literal string "meta", so the agent looked for data/posts/meta/content.html and
// failed. 6 of 192 posts have no `slug` field and hit this.

test('slugFromMetaPath prefers the slug recorded in the meta', () => {
  assert.equal(
    slugFromMetaPath('data/posts/anything/meta.json', { slug: 'real-slug' }),
    'real-slug',
    'an explicit slug always wins',
  );
});

test('slugFromMetaPath falls back to the directory name under the per-directory layout', () => {
  assert.equal(
    slugFromMetaPath('data/posts/benefits-of-using-coconut-oil-lotion/meta.json', {}),
    'benefits-of-using-coconut-oil-lotion',
    'the parent directory is the slug, not the literal "meta"',
  );
  assert.notEqual(slugFromMetaPath('data/posts/x/meta.json', {}), 'meta');
});

test('slugFromMetaPath still supports the legacy flat layout', () => {
  assert.equal(
    slugFromMetaPath('data/posts/some-post.json', {}),
    'some-post',
    'a flat <slug>.json path keeps working',
  );
});

test('slugFromMetaPath handles an absolute path', () => {
  assert.equal(
    slugFromMetaPath('/root/seo-claude/data/posts/my-post/meta.json', {}),
    'my-post',
    'the failing invocation used an absolute path',
  );
});

test('slugFromMetaPath tolerates a null meta', () => {
  assert.equal(slugFromMetaPath('data/posts/my-post/meta.json', null), 'my-post');
});

// blog-post-verifier documents a bare <slug> and matches on article handle. It was
// handed data/posts/<slug>/meta.json and reported "No article found matching slug:
// data/posts/.../meta.json". Normalizing here means either shape works.
test('slugFromMetaPath passes a bare slug straight through', () => {
  assert.equal(slugFromMetaPath('benefits-of-using-coconut-oil-lotion', null), 'benefits-of-using-coconut-oil-lotion');
  assert.equal(slugFromMetaPath('', null), '');
  assert.equal(slugFromMetaPath(null, null), '');
});

test('importing the module does not execute the agent', () => {
  const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(AGENT)}).then(() => console.log('CLEAN'))`], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /CLEAN/);
  assert.ok(!/Publisher Agent/.test(out), `the agent must not run on import — got: ${out.slice(0, 200)}`);
});

console.log('✓ publisher tests pass');
