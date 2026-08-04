/**
 * Reset lander content.
 *
 *   node scripts/update-reset-lander-content.mjs --definitions [--apply]
 *   node scripts/update-reset-lander-content.mjs --content     [--apply]
 *
 * Definitions are inert: sections self-suppress until content exists, so this
 * can ship ahead of the copy without touching any live page.
 */
import { shopifyGraphQL } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');

// NOTE: `comparison_rows` is deliberately NOT here. It is a PRODUCT metafield
// (`bundle.comparison_rows`), per the schema in docs/bundle-landing-architecture.md,
// created by metafieldsSet in Task 6. Liquid reads product metafields without a
// definition, the same way bundle.value_stack and bundle.lander are read today.
const NEW_FIELDS = [
  { key: 'hook',            name: 'Hook',             type: 'multi_line_text_field' },
  { key: 'ingredient_cards',name: 'Ingredient cards', type: 'json' },
  { key: 'stats',           name: 'Stats',            type: 'json' },
  { key: 'mechanism',       name: 'Mechanism',        type: 'json' },
  { key: 'timeline',        name: 'Timeline',         type: 'json' },
  { key: 'founder_note',    name: 'Founder note',     type: 'multi_line_text_field' },
];

async function definitions() {
  const cur = await shopifyGraphQL(`{
    metaobjectDefinitionByType(type:"bundle_lander"){ id fieldDefinitions { key } } }`);
  const def = cur.metaobjectDefinitionByType;
  if (!def) throw new Error('bundle_lander definition not found');
  const have = new Set(def.fieldDefinitions.map((f) => f.key));
  const missing = NEW_FIELDS.filter((f) => !have.has(f.key));

  if (!missing.length) { console.log('all fields already defined.'); return; }
  console.log('will add:', missing.map((f) => `${f.key} (${f.type})`).join(', '));
  if (!APPLY) { console.log('\ndry run — re-run with --apply.'); return; }

  const res = await shopifyGraphQL(
    `mutation($id:ID!, $ops:[MetaobjectFieldDefinitionOperationInput!]!){
       metaobjectDefinitionUpdate(id:$id, definition:{ fieldDefinitions:$ops }){
         userErrors{ field message } } }`,
    { id: def.id, ops: missing.map((f) => ({ create: { key: f.key, name: f.name, type: f.type } })) },
  );
  const errs = res.metaobjectDefinitionUpdate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  console.log(`added ${missing.length} field definition(s)`);
}

async function main() {
  if (process.argv.includes('--definitions')) return definitions();
  console.error('specify --definitions or --content');
  process.exit(1);
}

await main();
