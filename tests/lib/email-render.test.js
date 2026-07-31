import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { renderEmail } from '../../lib/email-render.js';

const minimal = {
  preheader: 'A deliberate preview line.',
  format: 'plain',
  blocks: [{ type: 'h1', text: 'Hello' }],
};

// --- Compliance invariants. These exist because all 22 live templates shipped with the
// --- wrong unsubscribe tag; centralising the footer makes that unrepeatable.

// The footer must use {% unsubscribe_link %}. {% unsubscribe %} expands to a whole <a>
// element and leaks raw markup when nested in an href.
{
  const html = renderEmail(minimal);
  assert.match(html, /href="\{% unsubscribe_link %\}"/);
  assert.doesNotMatch(html, /href="\{%\s*unsubscribe\s*%\}"/);
}

// CAN-SPAM requires the postal address, and it is hardcoded in these templates rather
// than injected by Klaviyo.
{
  assert.match(renderEmail(minimal), /1623 Central Ave STE 201, Cheyenne, WY 82001/);
}

// --- Preheader. The skill's rule is that a defaulted preheader is never shipped, so an
// --- absent one is a build failure rather than a silent empty div.
{
  assert.throws(() => renderEmail({ ...minimal, preheader: '' }), /preheader/i);
  assert.throws(() => renderEmail({ ...minimal, preheader: undefined }), /preheader/i);
}

// The preheader must be hidden in the body but present for the inbox preview line.
{
  const html = renderEmail({ ...minimal, preheader: 'Twenty-five percent, once.' });
  assert.match(html, /Twenty-five percent, once\./);
  assert.match(html, /display:none;max-height:0/);
}

// --- Palette. brand-kit.json is the source of truth, so a drifted hex fails the build
// --- rather than being caught later by the verifier.
{
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'cta', text: 'Go', href: 'https://x.com', bg: '#C1DF6D' }] }),
    /palette|#C1DF6D/i,
  );
}

// --- Format drives structure, per data/brand/email-format-matrix.md.

// A designed email carries the hosted logo with the dark-mode swap.
{
  const html = renderEmail({ ...minimal, format: 'designed' });
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /rsc-logo-black\.png/);
  assert.match(html, /rsc-logo-white\.png/);
}

// A plain email stays link-light: no hero imagery, no webfont import, so it reads as a
// personal message and lands in the primary tab rather than promotions.
{
  const html = renderEmail(minimal);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
}

// --- Blocks render in the order given, because the transformation-first ordering rule
// --- makes sequence load-bearing rather than cosmetic.
{
  const html = renderEmail({
    ...minimal,
    blocks: [
      { type: 'h1', text: 'FIRST' },
      { type: 'p', html: 'SECOND' },
      { type: 'cta', text: 'THIRD', href: 'https://www.realskincare.com' },
    ],
  });
  assert.ok(html.indexOf('FIRST') < html.indexOf('SECOND'));
  assert.ok(html.indexOf('SECOND') < html.indexOf('THIRD'));
}

// A CTA must have a real destination — an empty href silently ships a dead button.
{
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'cta', text: 'Go', href: '' }] }),
    /href/i,
  );
}

// --- Origin claims. Products are made in the USA; they are NOT made in Blum, Texas —
// --- that address is distribution, not manufacturing. A redesign introduced the wrong
// --- claim into a live email, so the renderer now refuses to emit one.
{
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Mixed by hand in Blum, Texas.' }] }),
    /origin claim|Blum/i,
  );
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Made in small batches in Texas.' }] }),
    /origin claim|Texas/i,
  );
}

// The CAN-SPAM postal address is not an origin claim and must still render.
{
  const html = renderEmail(minimal);
  assert.match(html, /1623 Central Ave STE 201, Cheyenne, WY 82001/);
}

// The address is read from brand-kit.json, not hardcoded — it lived as a duplicated
// literal in four files and changed once already.
{
  const kit = JSON.parse(
    readFileSync(new URL('../../data/brand/brand-kit.json', import.meta.url), 'utf8'),
  );
  assert.ok(kit.postal_address, 'brand-kit.json must carry postal_address');
  assert.ok(renderEmail(minimal).includes(kit.postal_address));
}

// Cheyenne must not become the new false origin claim.
{
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Handmade in Cheyenne, Wyoming.' }] }),
    /origin claim/i,
  );
}

// The approved phrasing passes.
{
  const html = renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Handmade in the USA.' }] });
  assert.match(html, /Handmade in the USA\./);
}

console.log('email-render: all assertions passed');

// --- Free-shipping threshold. It appears in six emails' copy, so a change means six
// --- chances to miss one. brand-kit.json owns the number and a stale one fails the build.
{
  const kit = JSON.parse(
    readFileSync(new URL('../../data/brand/brand-kit.json', import.meta.url), 'utf8'),
  );
  assert.ok(kit.free_shipping_threshold, 'brand-kit.json must carry free_shipping_threshold');

  // The current threshold renders fine.
  const ok = renderEmail({
    ...minimal,
    blocks: [{ type: 'p', html: `Orders over $${kit.free_shipping_threshold} ship free.` }],
  });
  assert.match(ok, new RegExp(`over \\$${kit.free_shipping_threshold} ship free`));

  // A superseded one does not.
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Orders over $50 ship free.' }] }),
    /shipping threshold/i,
  );
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Free shipping starts at $50.' }] }),
    /shipping threshold/i,
  );
}

// A product price that happens to contain digits is not a threshold and must not trip it.
{
  const html = renderEmail({
    ...minimal,
    blocks: [{ type: 'p', html: 'Sensitive Skin Set — $46.80, and the lip balm is $8.' }],
  });
  assert.match(html, /\$46\.80/);
}

console.log('email-render: threshold assertions passed');

// A threshold rendered without its currency symbol — "orders over 45 ship free" — is what
// a dropped escape in the interpolation actually produced. The stale-value check could not
// see it, because it only matched a figure preceded by "$".
{
  assert.throws(
    () => renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Orders over 45 ship free.' }] }),
    /currency|missing \$|shipping threshold/i,
  );
}

// Ordinary prose containing a number must not trip it.
{
  const html = renderEmail({
    ...minimal,
    blocks: [{ type: 'p', html: 'Julie started this over 20 years ago, and it takes 1–2 weeks.' }],
  });
  assert.match(html, /over 20 years ago/);
}

console.log('email-render: currency assertions passed');

// --- Category matchers must not collide with each other's product titles.
// "Moisturizing Coconut Soap" contains both "Soap" and "Moisturiz", so a soap buyer was
// shown a "Reorder Coconut Moisturizer" button for a product they never bought. The
// per-product conditionals are independent {% if %} blocks, not a chain, so both fired.
{
  const catalog = JSON.parse(
    readFileSync(new URL('../../data/brand/product-catalog.json', import.meta.url), 'utf8'),
  ).products;
  const specs = readFileSync(
    new URL('../../data/brand/email-rebuild/specs.js', import.meta.url), 'utf8',
  );

  // Every string used as a category matcher, as it appears in the specs.
  const matchers = [...new Set(
    [...specs.matchAll(/"([^"]+)" in items/g)].map((m) => m[1]),
  )];
  assert.ok(matchers.length > 0, 'expected to find category matchers in specs.js');

  for (const title of Object.values(catalog).map((p) => p.title)) {
    const hits = matchers.filter((k) => title.includes(k));
    assert.ok(
      hits.length <= 1,
      `product "${title}" matches ${hits.length} category strings (${hits.join(', ')}) — `
      + 'independent {% if %} blocks will all fire, offering products the customer never bought',
    );
  }
}

console.log('email-render: category-collision assertions passed');
