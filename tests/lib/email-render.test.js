import { strict as assert } from 'node:assert';
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
  assert.match(renderEmail(minimal), /6212 FM 933, Blum, TX 76627/);
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

// The CAN-SPAM postal address is not an origin claim and must still render — it is the
// same town name, so a naive ban would break every email.
{
  const html = renderEmail(minimal);
  assert.match(html, /6212 FM 933, Blum, TX 76627/);
}

// The approved phrasing passes.
{
  const html = renderEmail({ ...minimal, blocks: [{ type: 'p', html: 'Handmade in the USA.' }] });
  assert.match(html, /Handmade in the USA\./);
}

console.log('email-render: all assertions passed');
