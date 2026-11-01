import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackProductInput, baseTitle, optionLabel, offerIdFor, singleOfferId, staleOfferIds } from '../../lib/pack-listings.js';

const template = {
  brand: 'Real Skin Care',
  googleProductCategory: 'health & beauty > personal care > oral care > toothpaste',
  productTypes: ['Toothpaste'],
  description: 'Fresh Mint coconut oil toothpaste with cold-pressed virgin coconut oil.',
  shipping: [{ country: 'US', price: { amountMicros: '0', currencyCode: 'USD' } }],
};
const product = {
  id: 'gid://shopify/Product/111',
  title: 'Coconut Oil Toothpaste — 3-Pack',
  handle: 'coconut-toothpaste-3-pack',
  description: 'Three tubes of coconut oil toothpaste, built for people whose mouths react to the standard paste.',
  featuredImage: { url: 'https://cdn.example.com/pack.jpg' },
};
const variant = (title, components, extra = {}) => ({
  id: 'gid://shopify/ProductVariant/222', title, price: '34.00', compareAtPrice: '39.00', availableForSale: true,
  image: { url: 'https://cdn.example.com/v.jpg' }, components, ...extra,
});

test('a single-component pack is a multipack carrying the single GTIN, on sale against its compare-at', () => {
  const i = buildPackProductInput({ product, variant: variant('3x Fresh Mint', [{ quantity: 3, barcode: '850006308569' }]), template });
  assert.equal(i.offerId, 'rsc_pack_222');
  const a = i.productAttributes;
  assert.equal(a.title, 'Coconut Oil Toothpaste 3-Pack – Real Skin Care Fresh Mint');
  assert.equal(a.multipack, '3');
  assert.deepEqual(a.gtins, ['850006308569']);
  assert.equal(a.isBundle, undefined);
  assert.deepEqual(a.price, { amountMicros: '39000000', currencyCode: 'USD' });
  assert.deepEqual(a.salePrice, { amountMicros: '34000000', currencyCode: 'USD' });
  assert.equal(a.availability, 'IN_STOCK');
  assert.equal(a.link, 'https://www.realskincare.com/products/coconut-toothpaste-3-pack?variant=222');
  assert.equal(a.googleProductCategory, template.googleProductCategory);
  assert.deepEqual(a.shipping, template.shipping);
  assert.equal(a.itemGroupId, 'rsc_pack_111');
});

test('several distinct components is a bundle with no GTIN', () => {
  const a = buildPackProductInput({ product, variant: variant('Variety — one of each', [
    { quantity: 1, barcode: '1' }, { quantity: 1, barcode: '2' }, { quantity: 1, barcode: '3' },
  ]), template }).productAttributes;
  assert.equal(a.title, 'Coconut Oil Toothpaste 3-Pack – Real Skin Care Variety, One of Each');
  assert.equal(a.isBundle, true);
  assert.equal(a.identifierExists, false);
  assert.equal(a.gtins, undefined);
});

test('titles carry no promotional text and no em dash', () => {
  const a = buildPackProductInput({ product, variant: variant('3x Fresh Mint', [{ quantity: 3, barcode: 'x' }]), template }).productAttributes;
  assert.doesNotMatch(a.title, /free|% off|save|buy \d/i);
  assert.doesNotMatch(a.title, /—/);
});

test('out of stock, no sale, and a thin Shopify description falls back to the single', () => {
  const a = buildPackProductInput({
    product: { ...product, description: '' },
    variant: variant('4x Pure Unscented', [{ quantity: 4, barcode: '850006308200' }], { availableForSale: false, compareAtPrice: null, price: '90.00' }),
    template,
  }).productAttributes;
  assert.equal(a.availability, 'OUT_OF_STOCK');
  assert.equal(a.salePrice, undefined);
  assert.deepEqual(a.price, { amountMicros: '90000000', currencyCode: 'USD' });
  assert.match(a.description, /^Pack of 4\. Fresh Mint coconut oil toothpaste/);
});

test('refuses to build without the single unit record or components', () => {
  assert.throws(() => buildPackProductInput({ product, variant: variant('3x Fresh Mint', [{ quantity: 3 }]), template: null }), /no live Merchant Center record/);
  assert.throws(() => buildPackProductInput({ product, variant: variant('3x Fresh Mint', []), template }), /no bundle components/);
});

test('helpers', () => {
  assert.equal(baseTitle('Coconut Body Lotion — 4-Pack'), 'Coconut Body Lotion 4-Pack');
  assert.equal(optionLabel('4x Coconut Breeze'), 'Coconut Breeze');
  assert.equal(offerIdFor('gid://shopify/ProductVariant/9'), 'rsc_pack_9');
  assert.equal(singleOfferId('gid://shopify/Product/1', 'gid://shopify/ProductVariant/2'), 'shopify_US_1_2');
  assert.deepEqual(staleOfferIds(['rsc_pack_1', 'rsc_pack_2', 'shopify_US_1_2'], ['rsc_pack_1']), ['rsc_pack_2']);
});
