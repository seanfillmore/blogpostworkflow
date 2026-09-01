#!/usr/bin/env node
/**
 * Put a local image into Shopify Files and point a bundle-lander metaobject field
 * at it.
 *
 *   node scripts/upload-lander-image.mjs --file ~/Desktop/Headshot.jpg \
 *        --field founder_image --alt "Sean Fillmore, co-founder of Real Skin Care"
 *   node scripts/upload-lander-image.mjs ... --apply
 *
 * ── WHY A SCRIPT AND NOT THREE ad-hoc API CALLS ─────────────────────────────
 * `theme/templates/product.bundle-landing.json`'s `founder-note` block renders
 * `product.metafields.bundle.lander.value.founder_image`, and the `bundle_lander`
 * metaobject definition HAS NO SUCH FIELD. So the Liquid silently resolves to
 * blank and draws its placeholder SVG — the page looks like it is waiting for an
 * upload when in fact nothing could ever satisfy it. The same is true of
 * `mechanism_images`. Wiring one image is therefore three operations that must
 * all happen (define the field, upload the file, set the reference), and doing
 * them by hand once per image is how the second one gets forgotten.
 *
 * ── THE SCHEMA CHANGE IS ADDITIVE, AND THAT IS WHY IT IS SAFE ───────────────
 * `bundle_lander` is shared by every bundle lander. Adding an optional
 * `file_reference` field changes nothing for the landers that do not set it:
 * they render the same placeholder they render today. It is never destructive
 * and it is never applied without --apply.
 *
 * ── IT REFUSES TO CLOBBER ───────────────────────────────────────────────────
 * A field that already points at a file is left alone unless --replace is typed.
 * Shopify keeps the old file either way (nothing here deletes a file — see the
 * imagery rules in CLAUDE.md: DELETE destroys the CDN object), but silently
 * re-pointing a live page's photo is a decision a human should make.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { isDirectRun } from '../lib/is-direct-run.js';

export const METAOBJECT_ID = 'gid://shopify/Metaobject/220166586538';
export const DEFINITION_TYPE = 'bundle_lander';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** Shopify rejects an oversized upload only after the staged PUT; check first. */
export const MAX_BYTES = 20 * 1024 * 1024;

export function parseArgs(argv) {
  const a = { apply: false, replace: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--file') a.file = argv[++i];
    else if (t === '--field') a.field = argv[++i];
    else if (t === '--alt') a.alt = argv[++i];
    else if (t === '--metaobject') a.metaobject = argv[++i];
    else if (t === '--apply') a.apply = true;
    else if (t === '--replace') a.replace = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

/** @returns {{ok:true, mime:string}|{ok:false, reason:string}} */
export function validate(a, stat = statSync) {
  if (!a.file) return { ok: false, reason: '--file is required' };
  if (!a.field) return { ok: false, reason: '--field is required — this never guesses which slot to fill' };
  const mime = MIME[extname(a.file).toLowerCase()];
  if (!mime) return { ok: false, reason: `unsupported image type: ${extname(a.file) || '(none)'}` };
  let size;
  try { size = stat(a.file).size; } catch { return { ok: false, reason: `cannot read ${a.file}` }; }
  if (size > MAX_BYTES) return { ok: false, reason: `${size} bytes exceeds the ${MAX_BYTES}-byte ceiling` };
  return { ok: true, mime };
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (a.help) {
    console.log('Usage: --file <path> --field <metaobject field> [--alt <text>] [--replace] [--apply]');
    return 0;
  }
  const v = validate(a);
  if (!v.ok) { console.error(`REFUSED: ${v.reason}`); return 64; }

  const { shopifyGraphQL } = await import('../lib/shopify.js');
  const id = a.metaobject || METAOBJECT_ID;

  // 1. Does the definition carry this field at all?
  const def = await shopifyGraphQL(
    `{ metaobject(id:"${id}"){ handle type definition{ id fieldDefinitions{ key type{name} } } fields{ key value } } }`,
  );
  const mo = def.metaobject;
  if (!mo) { console.error(`REFUSED: metaobject ${id} not found`); return 1; }
  const defined = mo.definition.fieldDefinitions.find((f) => f.key === a.field);
  const current = mo.fields.find((f) => f.key === a.field)?.value;

  console.log(`metaobject ${mo.handle} (${mo.type})`);
  console.log(`  field "${a.field}": ${defined ? `defined as ${defined.type.name}` : 'NOT DEFINED — will be added'}`);
  console.log(`  current value: ${current || '(empty)'}`);
  if (defined && defined.type.name !== 'file_reference') {
    console.error(`REFUSED: "${a.field}" is ${defined.type.name}, not file_reference`);
    return 1;
  }
  if (current && !a.replace) {
    console.error(`REFUSED: "${a.field}" already points at a file. Pass --replace to re-point it.`);
    return 65;
  }

  const bytes = readFileSync(a.file);
  console.log(`  uploading ${basename(a.file)} (${bytes.length} bytes, ${v.mime})`);
  if (!a.apply) {
    console.log('\ndry run — re-run with --apply to add the field, upload the file and set the reference.');
    return 0;
  }

  // 2. Add the field to the SHARED definition when missing. Additive: every other
  //    lander keeps rendering its placeholder exactly as before.
  if (!defined) {
    const u = await shopifyGraphQL(
      `mutation($id:ID!, $f:[MetaobjectFieldDefinitionOperationInput!]){
         metaobjectDefinitionUpdate(id:$id, definition:{fieldDefinitions:$f}){ userErrors{ field message } } }`,
      { id: mo.definition.id, f: [{ create: { key: a.field, name: a.field.replace(/_/g, ' '), type: 'file_reference' } }] },
    );
    const errs = u.metaobjectDefinitionUpdate.userErrors;
    if (errs.length) { console.error('definition update FAILED:', errs); return 1; }
    console.log(`  added "${a.field}" to the ${mo.type} definition`);
  }

  // 3. Staged upload, then fileCreate against the staged URL.
  const staged = await shopifyGraphQL(
    `mutation($in:[StagedUploadInput!]!){ stagedUploadsCreate(input:$in){
       stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
    { in: [{ filename: basename(a.file), mimeType: v.mime, resource: 'IMAGE', httpMethod: 'POST' }] },
  );
  if (staged.stagedUploadsCreate.userErrors.length) {
    console.error('stagedUploadsCreate FAILED:', staged.stagedUploadsCreate.userErrors); return 1;
  }
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: v.mime }), basename(a.file));
  const put = await fetch(target.url, { method: 'POST', body: form });
  if (!put.ok) { console.error(`staged upload FAILED: HTTP ${put.status} ${(await put.text()).slice(0, 300)}`); return 1; }
  console.log('  staged upload ok');

  const created = await shopifyGraphQL(
    `mutation($f:[FileCreateInput!]!){ fileCreate(files:$f){
       files{ id fileStatus ... on MediaImage { image { url } } } userErrors{ field message } } }`,
    { f: [{ originalSource: target.resourceUrl, alt: a.alt || '', contentType: 'IMAGE' }] },
  );
  if (created.fileCreate.userErrors.length) { console.error('fileCreate FAILED:', created.fileCreate.userErrors); return 1; }
  const fileId = created.fileCreate.files[0].id;
  console.log(`  file created: ${fileId}`);

  // Shopify processes an upload asynchronously; a metaobject may not reference a
  // file still in UPLOADED state, so poll until it is READY before pointing at it.
  let ready = false;
  for (let i = 0; i < 20 && !ready; i += 1) {
    const q = await shopifyGraphQL(`{ node(id:"${fileId}"){ ... on MediaImage { fileStatus image { url width height } } } }`);
    if (q.node?.fileStatus === 'READY') {
      ready = true;
      console.log(`  ready: ${q.node.image.width}x${q.node.image.height} ${q.node.image.url}`);
    } else await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) { console.error('file never reached READY — not setting the reference'); return 1; }

  const set = await shopifyGraphQL(
    `mutation($id:ID!, $fields:[MetaobjectFieldInput!]!){
       metaobjectUpdate(id:$id, metaobject:{fields:$fields}){ userErrors{ field message } } }`,
    { id, fields: [{ key: a.field, value: fileId }] },
  );
  if (set.metaobjectUpdate.userErrors.length) { console.error('metaobjectUpdate FAILED:', set.metaobjectUpdate.userErrors); return 1; }
  console.log(`\nset ${a.field} -> ${fileId}. Verify the rendered page before calling this done.`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
