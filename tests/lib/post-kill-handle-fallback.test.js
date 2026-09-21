import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'lib', 'post-kill.js'), 'utf8');

// Source-scanned rather than executed: killPost's other arms delete directories,
// archive briefs and write data/rejected-keywords.json, and lib/shopify.js throws
// at import time without OAuth credentials. The properties below are structural.

test('no local meta.json falls back to a Shopify handle lookup', () => {
  // THE BUG: the ids live in the gitignored state.json since the 2026-08-31
  // split, and 52 of 93 posts are the legacy corpus with no local record at
  // all. killPost returned `shopify_deleted: false` with a one-line warning and
  // exited 0 while the article stayed live — a kill that killed nothing.
  assert.ok(
    /export async function findArticleByHandle/.test(SRC),
    'a handle lookup must exist so Shopify decides whether the article is there',
  );
  const elseIdx = SRC.indexOf('// NO LOCAL META IS NOT "NOTHING TO DELETE".');
  assert.ok(elseIdx > -1, 'the fallback branch must be present and explained');
  assert.ok(
    SRC.indexOf('findArticleByHandle(slug)', elseIdx) > elseIdx,
    'the fallback must actually call the lookup',
  );
});

test('a LIVE article is flagged, and its remaining manual step is named', () => {
  // killPost CREATES the redirect now (see below). What it still cannot do is
  // repoint the inbound INTERNAL links — the eczema page had 19 — so it says
  // which command does. Silence there is the failure.
  assert.ok(/summary\.was_live = Boolean\(isLive\)/.test(SRC), 'a live kill must be flagged');
  assert.ok(
    /fix-redirect-links\.mjs --apply ON THE SERVER/.test(SRC),
    'the remaining manual step must be named, including that it runs on the server',
  );
});

test('an absent article is reported as absent, not as a successful delete', () => {
  // "Shopify has no article with this handle" and "we deleted it" must never
  // render the same way — the same unreadable-is-not-absent rule the rest of
  // this repo keeps relearning.
  assert.ok(
    /no Shopify article with this handle/.test(SRC),
    'the not-found case must be named',
  );
  // There is now ONE delete site, and shopify_deleted is set only next to it.
  const trueSets = [...SRC.matchAll(/summary\.shopify_deleted = true/g)];
  assert.equal(trueSets.length, 1, 'one resolve-then-delete path, not two');
  const before = SRC.slice(Math.max(0, trueSets[0].index - 200), trueSets[0].index);
  assert.ok(
    /await deleteArticle\(/.test(before),
    'shopify_deleted may only be set after an awaited deleteArticle',
  );
});


// ── the redirect a kill now creates ──────────────────────────────────────────

test('the destination comes from the page\'s own buy box', async () => {
  const { resolveKillRedirectTarget } = await import('../../lib/post-kill.js');
  // The featured-product CTA is the link the page already chose. A reader
  // following an inbound link wanted that product, not a list of articles.
  const body = '<p>intro <a href="/collections/lotion-guide-nope">guide</a></p>'
    + '<div class="rsc-featured-product"><a href="/products/coconut-lotion">Shop</a></div>';
  const r = resolveKillRedirectTarget(body);
  assert.equal(r.target, '/products/coconut-lotion');
  assert.equal(r.source, 'buy-box CTA');
});

test('an explicit target always wins', async () => {
  const { resolveKillRedirectTarget } = await import('../../lib/post-kill.js');
  const body = '<div class="rsc-featured-product"><a href="/products/coconut-lotion">Shop</a></div>';
  const r = resolveKillRedirectTarget(body, { explicit: '/collections/non-toxic-body-lotion' });
  assert.equal(r.target, '/collections/non-toxic-body-lotion');
  assert.equal(r.source, 'explicit');
});

test('with no buy box it falls back to a body link, then to a live collection', async () => {
  const { resolveKillRedirectTarget, FALLBACK_REDIRECT_TARGET } = await import('../../lib/post-kill.js');
  assert.equal(
    resolveKillRedirectTarget('<a href="https://www.realskincare.com/collections/soap">x</a>').target,
    '/collections/soap',
  );
  // An article with no commercial link at all still has to go somewhere: a kill
  // must never stall because nothing was derivable.
  const none = resolveKillRedirectTarget('<p>no links here</p>');
  assert.equal(none.target, FALLBACK_REDIRECT_TARGET);
  assert.equal(none.source, 'fallback collection');
  for (const bad of [null, undefined, 42]) {
    assert.equal(resolveKillRedirectTarget(bad).target, FALLBACK_REDIRECT_TARGET);
  }
});

test('it resolves THROUGH the redirect table, never creating a chain', async () => {
  const { resolveKillRedirectTarget } = await import('../../lib/post-kill.js');
  const redirects = [
    { path: '/collections/organic-body-lotion', target: '/collections/non-toxic-body-lotion' },
  ];
  const body = '<div class="rsc-featured-product"><a href="/collections/organic-body-lotion">Shop</a></div>';
  assert.equal(
    resolveKillRedirectTarget(body, { redirects }).target,
    '/collections/non-toxic-body-lotion',
    'a killed page must not point at another redirect — each hop loses signal',
  );
});

test('a CYCLE in the redirect table cannot hang a kill', async () => {
  const { resolveKillRedirectTarget } = await import('../../lib/post-kill.js');
  const redirects = [
    { path: '/collections/a', target: '/collections/b' },
    { path: '/collections/b', target: '/collections/a' },
  ];
  const r = resolveKillRedirectTarget('<a href="/collections/a">x</a>', { redirects });
  assert.ok(['/collections/a', '/collections/b'].includes(r.target), r.target);
});

test('a LIVE article is redirected BEFORE it is deleted, and a failure REFUSES the delete', () => {
  const SRC2 = readFileSync(join(ROOT, 'lib', 'post-kill.js'), 'utf8');
  const redirectIdx = SRC2.indexOf('await createRedirect(path, target)');
  const deleteIdx = SRC2.indexOf('await deleteArticle(article.blogId, article.id)');
  assert.ok(redirectIdx > -1 && deleteIdx > -1);
  assert.ok(
    redirectIdx < deleteIdx,
    'the redirect must be created first — created after, the URL 404s in between',
  );
  assert.ok(/mayDelete = false/.test(SRC2), 'a failed redirect must block the delete');
  assert.ok(
    /REFUSED to delete a LIVE article/.test(SRC2),
    'the refusal must say so in words, not just skip silently',
  );
});
