import { strict as assert } from 'node:assert';
import { quantityFindings } from '../../lib/bundle-contents-check.js';

// Components as verify-bundle-contents receives them from Shopify.
const comps = [
  { quantity: 3, productVariant: { title: 'Coconut Breeze', product: { title: 'Body Lotion' } } },
  { quantity: 3, productVariant: { title: 'Coconut Breeze', product: { title: 'Coconut Moisturizer' } } },
];

// The defect this exists to catch: the Reset shipped 3 creams while its customer-facing
// copy said 1. The existing checks passed it — the variant title was present and no
// phantom variant was promised — because nothing compared quantities.
{
  const copy = [
    '3 × Body Lotion — Coconut Breeze (coconut oil extract)',
    '1 × Body Cream — Coconut Breeze',
    '2 × digital guides, emailed within minutes',
  ].join('\n');
  const problems = quantityFindings(copy, comps);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /4.*6|says 4|6 units/i);
}

// Correct copy passes.
{
  const copy = [
    '3 × Body Lotion — Coconut Breeze (coconut oil extract)',
    '3 × Body Cream — Coconut Breeze',
    '2 × digital guides, emailed within minutes',
  ].join('\n');
  assert.deepEqual(quantityFindings(copy, comps), []);
}

// Digital goods are not components and must not be counted against the physical total —
// counting them would make correct copy fail.
{
  const copy = '3 × Body Lotion — Coconut Breeze\n3 × Body Cream — Coconut Breeze\n2 × digital guides, emailed within minutes';
  assert.deepEqual(quantityFindings(copy, comps), []);
}

// Over-promising is a defect in the more dangerous direction — the customer is told they
// get more than ships.
{
  const copy = '3 × Body Lotion — Coconut Breeze\n5 × Body Cream — Coconut Breeze';
  const problems = quantityFindings(copy, comps);
  assert.equal(problems.length, 1);
}

// The 'x' spelling is used interchangeably with '×' in this copy and must parse the same.
{
  const copy = '3 x Body Lotion — Coconut Breeze\n3 x Body Cream — Coconut Breeze';
  assert.deepEqual(quantityFindings(copy, comps), []);
}

// Copy with no quantity markers at all cannot be checked — return nothing rather than
// invent a failure, since the title and phantom checks still cover it.
{
  assert.deepEqual(quantityFindings('Everything you need in one box.', comps), []);
}

console.log('bundle-contents-check: all assertions passed');
