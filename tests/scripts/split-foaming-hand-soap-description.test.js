import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBody, MARKER } from '../../scripts/split-foaming-hand-soap-description-2026-10-05.mjs';

const BODY = '<script type="application/ld+json">{"a":"<h2>x</h2>"}</script>\n<p>Intro words here.</p>\n<h2>Guide</h2><p>Long guide.</p><h2>FAQ</h2>';

test('marker lands before the first real <h2>, after the intro', () => {
  const r = splitBody(BODY);
  assert.equal(r.state, 'apply');
  const [above, below] = r.html.split(MARKER);
  assert.match(above, /Intro words here/);
  assert.match(below, /^\n<h2>Guide/);
  assert.equal(r.html.replace(`${MARKER}\n`, ''), BODY, 'no other byte changes');
});

test('idempotent', () => {
  const once = splitBody(BODY).html;
  assert.equal(splitBody(once).state, 'already-applied');
  assert.equal(splitBody(once).html, once);
});
