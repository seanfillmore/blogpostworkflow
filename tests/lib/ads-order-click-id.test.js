import { strict as assert } from 'node:assert';
import { extractOrderClickId } from '../../lib/ads-conversions.js';

// Shopify caps `landing_site` at 255 chars and Google Shopping puts gclid LAST, so the
// gclid always arrives as a stump there. The storefront snippet (theme/assets/rsc-click-id.js)
// captures the full value into a cart attribute, which lands on the order as a
// note_attribute — the only place a complete gclid can survive.
const FULL_GCLID = 'Cj0KCQjw2N7GBhDeARIsAJb8Rvw8yQ7pQ0mKqRr1a2b3c4d5e6f7g8h9i0jKlMnOpQrStUvWxYz';
const TRUNCATED_LANDING = '/products/coconut-lotion?gbraid=0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2&gclid=CjwK';

// A full gclid from note_attributes beats the gbraid from landing_site: gclid identifies
// the exact click, gbraid is the privacy-preserving fallback.
{
  const id = extractOrderClickId({
    landing_site: TRUNCATED_LANDING,
    note_attributes: [{ name: 'gclid', value: FULL_GCLID }],
  });
  assert.equal(id.type, 'gclid');
  assert.equal(id.value, FULL_GCLID);
}

// Without the attribute we still fall back to the intact gbraid in landing_site.
{
  const id = extractOrderClickId({ landing_site: TRUNCATED_LANDING });
  assert.equal(id.type, 'gbraid');
}

// A note_attribute that is itself damaged must not beat a good landing_site value.
{
  const id = extractOrderClickId({
    landing_site: TRUNCATED_LANDING,
    note_attributes: [{ name: 'gclid', value: 'CjwK' }],
  });
  assert.equal(id.type, 'gbraid', 'a stump in note_attributes must not win');
}

// gbraid/wbraid captured into attributes are honoured too.
{
  assert.equal(extractOrderClickId({
    note_attributes: [{ name: 'gbraid', value: '0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2' }],
  }).type, 'gbraid');
}

// Unrelated note_attributes (Shopify apps write plenty) must be ignored, not misread.
{
  assert.equal(extractOrderClickId({
    landing_site: '/blogs/news/x',
    note_attributes: [{ name: 'delivery-instructions', value: 'leave at door' }],
  }), null);
}

// Organic order: nothing anywhere.
{
  assert.equal(extractOrderClickId({ landing_site: '/blogs/news/x' }), null);
  assert.equal(extractOrderClickId({}), null);
}
console.log('ads-order-click-id: all assertions passed');
