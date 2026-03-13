/**
 * Product & Collection Schema Injector Agent
 *
 * Injects JSON-LD structured data into Shopify product and collection pages
 * by prepending <script type="application/ld+json"> blocks to their body_html.
 * Script tags are rendered in the DOM but not visible to shoppers — Google
 * reads them as structured data.
 *
 * Schema types injected:
 *   Products:    Product (name, description, image, brand, offers, sku)
 *   Collections: CollectionPage + BreadcrumbList
 *
 * Note: Most Shopify themes (Dawn, Debut, etc.) already inject basic Product
 * schema. This agent fills gaps (brand, sku, explicit offers) and ensures
 * collections have CollectionPage markup. Run after product-optimizer so the
 * description is already enriched.
 *
 * Usage:
 *   node agents/product-schema/index.js --type products    # products only
 *   node agents/product-schema/index.js --type collections # collections only
 *   node agents/product-schema/index.js                    # both (default)
 *   node agents/product-schema/index.js --apply            # push to Shopify
 *
 * Output: data/reports/product-schema-report.md
 */

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
import { notify } from '../../lib/notify.js';
  getProducts,
  getCustomCollections,
  getSmartCollections,
  updateProduct,
  updateCustomCollection,
  updateSmartCollection,
} from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'product-schema');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const apply = args.includes('--apply');
const typeArg = getArg('--type') || 'both';

// ── schema builders ───────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildProductSchema(product) {
  const url = `${config.url}/products/${product.handle}`;
  const image = product.images?.[0]?.src || null;
  const variant = product.variants?.[0];

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    'name': product.title,
    'description': stripHtml(product.body_html).slice(0, 500) || product.title,
    'url': url,
    'brand': {
      '@type': 'Brand',
      'name': config.name,
    },
  };

  if (image) schema.image = [image];
  if (product.handle) schema.sku = product.handle;

  if (variant) {
    schema.offers = {
      '@type': 'Offer',
      'url': url,
      'priceCurrency': 'USD',
      'price': variant.price,
      'availability': variant.inventory_quantity > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      'seller': {
        '@type': 'Organization',
        'name': config.name,
      },
    };
  }

  return schema;
}

function buildCollectionSchema(collection) {
  const url = `${config.url}/collections/${collection.handle}`;
  const image = collection.image?.src || null;

  const collectionSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    'name': collection.title,
    'description': stripHtml(collection.body_html).slice(0, 300) || collection.title,
    'url': url,
  };
  if (image) collectionSchema.image = image;

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    'itemListElement': [
      {
        '@type': 'ListItem',
        'position': 1,
        'name': 'Home',
        'item': config.url,
      },
      {
        '@type': 'ListItem',
        'position': 2,
        'name': collection.title,
        'item': url,
      },
    ],
  };

  return [collectionSchema, breadcrumbSchema];
}

// ── injection ─────────────────────────────────────────────────────────────────

const SCHEMA_MARKER = '<!-- schema-injector -->';

function stripExistingProductSchema(html) {
  // Remove blocks between our markers
  return html
    .replace(new RegExp(`${SCHEMA_MARKER}[\\s\\S]*?${SCHEMA_MARKER}`, 'g'), '')
    .trim();
}

function injectSchemas(html, schemas) {
  const cleaned = stripExistingProductSchema(html);
  const blocks = schemas
    .map((s) => `<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>`)
    .join('\n');
  return `${SCHEMA_MARKER}\n${blocks}\n${SCHEMA_MARKER}\n${cleaned}`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nProduct Schema Injector — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will update Shopify)' : 'DRY RUN (use --apply to push)'}`);
  console.log(`Target: ${typeArg}\n`);

  const results = [];

  // ── Products ────────────────────────────────────────────────────────────────

  if (typeArg !== 'collections') {
    process.stdout.write('  Fetching products... ');
    const products = await getProducts();
    console.log(`${products.length} products`);

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      process.stdout.write(`  [${i + 1}/${products.length}] "${product.title}"... `);

      const schema = buildProductSchema(product);
      const updatedHtml = injectSchemas(product.body_html || '', [schema]);

      let applied = false;
      if (apply) {
        try {
          await updateProduct(product.id, { body_html: updatedHtml });
          applied = true;
          console.log('✓');
        } catch (e) {
          console.error(`✗ ${e.message}`);
        }
      } else {
        console.log('(dry run)');
      }

      results.push({
        type: 'product',
        title: product.title,
        url: `${config.url}/products/${product.handle}`,
        schemas: ['Product'],
        applied,
      });
    }
  }

  // ── Collections ─────────────────────────────────────────────────────────────

  if (typeArg !== 'products') {
    process.stdout.write('  Fetching collections... ');
    const [custom, smart] = await Promise.all([getCustomCollections(), getSmartCollections()]);
    const all = [
      ...custom.map((c) => ({ ...c, collectionType: 'custom' })),
      ...smart.map((c) => ({ ...c, collectionType: 'smart' })),
    ];
    console.log(`${all.length} collections`);

    for (let i = 0; i < all.length; i++) {
      const col = all[i];
      process.stdout.write(`  [${i + 1}/${all.length}] "${col.title}"... `);

      const schemas = buildCollectionSchema(col);
      const updatedHtml = injectSchemas(col.body_html || '', schemas);

      let applied = false;
      if (apply) {
        try {
          if (col.collectionType === 'custom') {
            await updateCustomCollection(col.id, { body_html: updatedHtml });
          } else {
            await updateSmartCollection(col.id, { body_html: updatedHtml });
          }
          applied = true;
          console.log('✓');
        } catch (e) {
          console.error(`✗ ${e.message}`);
        }
      } else {
        console.log('(dry run)');
      }

      results.push({
        type: 'collection',
        title: col.title,
        url: `${config.url}/collections/${col.handle}`,
        schemas: ['CollectionPage', 'BreadcrumbList'],
        applied,
      });
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────────

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [
    `# Product Schema Report — ${config.name}`,
    `**Run date:** ${now}`,
    `**Mode:** ${apply ? 'Applied' : 'Dry run'}`,
    `**Pages processed:** ${results.length}`,
    '',
    '| Type | Page | Schemas | Status |',
    '|---|---|---|---|',
    ...results.map((r) => {
      const status = apply ? (r.applied ? '✅' : '⚠️ Failed') : '💡 Proposed';
      return `| ${r.type} | [${r.title}](${r.url}) | ${r.schemas.join(', ')} | ${status} |`;
    }),
    '',
  ];

  if (!apply) {
    lines.push('Run with `--apply` to inject schema into Shopify.');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'product-schema-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  const appliedCount = results.filter((r) => r.applied).length;
  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Pages ${apply ? `updated: ${appliedCount}/${results.length}` : `analyzed: ${results.length}`}`);
}

main()
  .then(() => notify({ subject: 'Product Schema completed', body: 'Product Schema ran successfully.', status: 'success' }))
  .catch((err) => {
    notify({ subject: 'Product Schema failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
