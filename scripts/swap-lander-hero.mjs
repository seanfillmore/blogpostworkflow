#!/usr/bin/env node
/**
 * Swap the Sensitive Skin Set lander hero images.
 *
 * Reads two source JPGs from ~/Desktop, resizes/encodes each to WebP
 * at the manifest-spec dimensions, uploads to Shopify Files under the
 * existing filenames so the template references resolve automatically.
 *
 * Run AFTER deleting the previous hero-desktop.webp and hero-mobile.webp
 * from Shopify Files so this run lands at the original filenames
 * (Shopify suffixes _1 if a duplicate name still exists).
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { uploadImageToShopifyCDN } from '../lib/shopify.js';

const SHOTS = [
  {
    src: join(homedir(), 'Desktop', 'Hero — Desktop.jpg'),  // em-dash filename
    out: '/tmp/hero-desktop.webp',
    w: 2400, h: 1200,
    alt: 'Pure Unscented Body Lotion bottle and Pure Unscented Body Cream jar on a sage-green surface in soft daylight',
  },
  {
    src: join(homedir(), 'Desktop', 'Hero - Mobile.jpg'),         // hyphen filename
    out: '/tmp/hero-mobile.webp',
    w: 750, h: 1000,
    alt: 'Pure Unscented Body Lotion and Body Cream on a sage-green surface, soft daylight',
  },
];

for (const s of SHOTS) {
  if (!existsSync(s.src)) {
    console.error(`Source missing: ${s.src}`);
    process.exit(1);
  }
  process.stdout.write(`[${s.out.split('/').pop().padEnd(20)}] ${s.w}x${s.h}... `);
  const info = await sharp(s.src)
    .resize(s.w, s.h, { fit: 'cover', position: 'attention' })
    .webp({ quality: 85 })
    .toFile(s.out);
  process.stdout.write(`${Math.round(info.size / 1024)}KB. uploading... `);
  const url = await uploadImageToShopifyCDN(s.out, s.alt);
  console.log('OK');
  console.log(`  -> ${url}`);
}

console.log('\nDone. Template references shopify://shop_images/hero-desktop.webp and hero-mobile.webp resolve to the new files.');
