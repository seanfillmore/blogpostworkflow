import sharp from 'sharp';
import { uploadImageToShopifyCDN } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
import { readFileSync, writeFileSync } from 'fs';

const SRC = '/Users/seanfillmore/Code/lander-sources/originals/12. Don\'t Fumble CTA — bathroom shelf.jpg';
const OUT = '/tmp/dont-fumble-shelf-padded.webp';

// Pad source to 4:3 horizontal (matches the 600x450 / image_ratio:450px container).
// Uses #faf7f0 (template's section background) so padding blends seamlessly.
const info = await sharp(SRC)
  .resize(1920, 1440, { fit: 'contain', background: { r: 0xfa, g: 0xf7, b: 0xf0, alpha: 1 } })
  .webp({ quality: 85 })
  .toFile(OUT);
console.log(`Processed: ${info.width}x${info.height}, ${Math.round(info.size / 1024)}KB`);

const url = await uploadImageToShopifyCDN(OUT, 'A bathroom shelf cleared of half-empty lotion bottles, with the Sensitive Skin Set in their place');
console.log(`Uploaded: ${url}`);

// Patch template
const TPL = '/Users/seanfillmore/Code/realskincare-theme/templates/product.landing-page-sensitive-skin-set-lander.json';
const raw = readFileSync(TPL, 'utf8');
const start = raw.indexOf('{');
const json = JSON.parse(raw.slice(start));
const before = json.sections['dont-fumble-cta'].settings.image;
json.sections['dont-fumble-cta'].settings.image = 'shopify://shop_images/dont-fumble-shelf-padded.webp';
writeFileSync(TPL, raw.slice(0, start) + JSON.stringify(json, null, 2) + '\n');
console.log(`Patched: ${before} -> shopify://shop_images/dont-fumble-shelf-padded.webp`);
