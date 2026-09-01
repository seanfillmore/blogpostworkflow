#!/usr/bin/env node
// Print the Shopify custom app's granted access scopes.
//
// Read-only. Reach for it when an Admin API call comes back "Access denied" —
// that error means a MISSING SCOPE on the custom app, not a bad request, and this
// is the fastest way to see what the app actually holds.
//
//   node scripts/read-app-scopes.mjs
//
// Requires the OAuth credentials in .env; lib/shopify.js throws at import without them.
import { shopifyGraphQL } from '../lib/shopify.js';

const r = await shopifyGraphQL(
  `{ currentAppInstallation { id app { title id } accessScopes { handle } } }`,
);
const scopes = r.currentAppInstallation.accessScopes.map((x) => x.handle).sort();
console.log(`app: ${r.currentAppInstallation.app.title}  (${scopes.length} scopes)`);
console.log(scopes.join('\n'));
