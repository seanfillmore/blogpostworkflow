// Creates the 5 metafield definitions the pdp-builder agent uses for
// per-product overrides. Idempotent — re-running surfaces "already exists"
// errors per definition without aborting the others.
//
// Usage: node scripts/create-pdp-metafields.mjs
//
// Per docs/superpowers/specs/2026-05-02-pdp-builder-design.md Layer 2.

import { createMetafieldDefinition } from '../lib/shopify.js';

const DEFINITIONS = [
  {
    namespace: 'custom',
    key: 'hero_ingredients_override',
    name: 'Hero ingredients override',
    type: 'json',
    ownerType: 'PRODUCT',
    description: 'Per-SKU override of cluster default ingredient cards. List of {name, role, mechanism, sourcing, why_we_chose_it, image_url}. Used by image-with-text sections marked is_hero_ingredient_position.',
  },
  {
    namespace: 'custom',
    key: 'faq_additional',
    name: 'FAQ additional',
    type: 'json',
    ownerType: 'PRODUCT',
    description: 'Per-SKU FAQ items appended to the cluster default FAQ. List of {question, answer}.',
  },
  {
    namespace: 'custom',
    key: 'free_from',
    name: 'Free-from list',
    type: 'list.single_line_text_field',
    ownerType: 'PRODUCT',
    description: 'Per-SKU override of the cluster default free-from callouts. Replaces (does not merge) when set.',
  },
  {
    namespace: 'custom',
    key: 'sensitive_skin_notes',
    name: 'Sensitive-skin notes',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
    description: 'Per-SKU notes for reactive-skin customers. Surfaced in product mode as supplementary copy.',
  },
  {
    namespace: 'custom',
    key: 'scent_notes',
    name: 'Scent notes',
    type: 'json',
    ownerType: 'PRODUCT',
    description: 'Per-variant scent profile copy. JSON keyed by variant title.',
  },
];

console.log(`Creating ${DEFINITIONS.length} metafield definitions...\n`);

let created = 0;
let alreadyExisted = 0;
let failed = 0;

for (const def of DEFINITIONS) {
  process.stdout.write(`  custom.${def.key} (${def.type}) ... `);
  try {
    const result = await createMetafieldDefinition(def);
    if (result.userErrors.length > 0) {
      const codes = result.userErrors.map((e) => e.code).join(',');
      const msgs = result.userErrors.map((e) => e.message).join('; ');
      if (codes.includes('TAKEN') || /already/i.test(msgs)) {
        console.log(`already exists`);
        alreadyExisted++;
      } else {
        console.log(`ERROR: ${msgs}`);
        failed++;
      }
    } else if (result.definition) {
      console.log(`created (id ${result.definition.id})`);
      created++;
    } else {
      console.log('unknown response');
      failed++;
    }
  } catch (e) {
    console.log(`THROWN: ${e.message}`);
    failed++;
  }
}

console.log(`\nSummary: ${created} created, ${alreadyExisted} already existed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
