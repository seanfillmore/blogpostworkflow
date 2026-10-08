#!/usr/bin/env node
/**
 * Render generated gallery frames for the mixed-product bundles.
 *
 *   node scripts/build-bundle-galleries.mjs [--only <handle>] [--frames hero,offer,scene]
 *        [--name <kit>-hero,...] [--missing] [--engines openai|gemini]
 *        [--max-renders N] [--concurrency N] [--dry-run]
 *
 * What is rendered and how it is judged: lib/bundle-gallery.js. The render loop:
 * lib/gallery-render.js. Output goes to data/creatives/bundle-galleries/<run>/ and
 * is archived to the main checkout; scripts/publish-bundle-galleries.mjs reads only
 * passing files from there.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { shopifyGraphQL } from '../lib/shopify.js';
import { archiveRunOutput } from '../lib/archive-run-output.js';
import { ROOT, loadEnv, createRenderer, runAll, cutoutRef, labelCrop, flatRef } from '../lib/gallery-render.js';
import { UNIT } from '../lib/ladder-gallery.js';
import {
  BUNDLES, kitUnits, sceneUnitsOf, offerCopy, heroPrompt, offerPrompt, scenePrompt, checkPrompt, judgeBundle, handleize, label,
} from '../lib/bundle-gallery.js';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const ONLY = arg('--only', null);
const FRAMES = arg('--frames', 'hero,offer,scene').split(',');
const NAMES = arg('--name', null)?.split(',') ?? null;
const MISSING = argv.includes('--missing');
const ENGINES = arg('--engines', null);
const MAX_RENDERS = Number(arg('--max-renders', 200));
const CONCURRENCY = Number(arg('--concurrency', 4));
const DRY = argv.includes('--dry-run');

const env = loadEnv();
const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
const refDir = join(ROOT, 'data', 'creatives', 'bundle-galleries', '_refs');
const GIFT_BOX = join(ROOT, 'data', 'brand', 'packaging', 'mailer-10x8x4-closed.png');

async function refsFor(units, giftBox) {
  const refs = [];
  const seen = new Set();
  for (const u of units) {
    const k = `${u.product}|${u.scent}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const unit = UNIT[u.product];
    refs.push(await cutoutRef(refDir, unit.refKey, u.scent));
    if (unit.detailCrop) refs.push(await labelCrop(refDir, unit.refKey, u.scent, unit.detailCrop));
  }
  if (giftBox) refs.push(await flatRef(GIFT_BOX, join(refDir, 'gift-mailer-closed.png')));
  return refs;
}

const jobs = [];
for (const [handle, cfg] of Object.entries(BUNDLES)) {
  if (ONLY && ONLY !== handle) continue;
  const bundle = bundles.find((b) => b.handle === handle);
  if (!bundle) throw new Error(`config/bundles.json has no ${handle}`);
  const r = await shopifyGraphQL(`query($h:String!){ productByIdentifier(identifier:{handle:$h}){ variants(first:20){ nodes{ title price compareAtPrice } } } }`, { h: handle });
  const live = (r.productByIdentifier ?? r.data?.productByIdentifier).variants.nodes;
  for (const kit of bundle.variants) {
    const value = kit.options[cfg.option];
    const lv = live.find((x) => x.title === value);
    if (!lv) throw new Error(`${handle}: no live variant "${value}"`);
    if (Number(lv.price) !== kit.price || Number(lv.compareAtPrice) !== kit.compareAtPrice) {
      throw new Error(`${handle} / ${value}: roster $${kit.price}/$${kit.compareAtPrice}, Shopify $${lv.price}/$${lv.compareAtPrice}`);
    }
    const slug = handleize(value);
    const all = kitUnits(kit);
    const base = { handle, kit: value, giftBox: !!cfg.giftBox };
    if (FRAMES.includes('hero') && !cfg.keepHero) {
      jobs.push({ ...base, name: `${slug}-hero`, units: all, required: [], prompt: heroPrompt({ bundle: cfg, units: all }) });
    }
    if (FRAMES.includes('offer')) {
      const kitLabel = cfg.option === 'Kit' ? `${value} kit` : value;
      const copy = offerCopy(kit, { kitLabel });
      jobs.push({ ...base, name: `${slug}-offer`, units: all, copy, required: [copy.headline, copy.price, copy.sub, ...copy.checks], prompt: offerPrompt({ bundle: cfg, units: all, copy }) });
    }
    if (FRAMES.includes('scene')) {
      const units = sceneUnitsOf(kit);
      jobs.push({ ...base, name: `${slug}-scene`, units, required: [], prompt: scenePrompt({ bundle: cfg, units }) });
    }
  }
}
if (NAMES) jobs.splice(0, jobs.length, ...jobs.filter((j) => NAMES.includes(j.name)));
if (MISSING) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const runsRoot = join(dirname(common), 'data', 'creatives', 'bundle-galleries');
  const runs = existsSync(runsRoot) ? readdirSync(runsRoot).filter((d) => /^\d{4}-/.test(d)) : [];
  const done = (j) => runs.some((r) => existsSync(join(runsRoot, r, j.handle, `${j.name}.png`)));
  jobs.splice(0, jobs.length, ...jobs.filter((j) => !done(j)));
}
if (!jobs.length) { console.log('Nothing to render.'); process.exit(0); }
console.log(`${jobs.length} frames planned across ${new Set(jobs.map((j) => j.handle)).size} bundles.`);
if (DRY) {
  for (const j of jobs) console.log(`  ${j.handle.padEnd(26)} ${j.name.padEnd(28)} ${j.units.length} items${j.copy ? `  "${j.copy.headline}" ${j.copy.price} ${j.copy.sub}` : ''}`);
  console.log(`\n--- first prompt ---\n${jobs[0].prompt}`);
  process.exit(0);
}

const RUN = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${process.pid}`;
const OUT = join(ROOT, 'data', 'creatives', 'bundle-galleries', RUN);
const { renderJob, budget } = createRenderer({ env, outDir: OUT, maxRenders: MAX_RENDERS, engines: ENGINES });
const results = await runAll(jobs, CONCURRENCY, async (job) => {
  const r = await renderJob({ ...job, refs: await refsFor(job.units, job.giftBox),
    checkText: checkPrompt({ units: job.units }),
    judge: (read) => judgeBundle({ read, units: job.units, required: job.required }) });
  return { ...r, kit: job.kit, items: job.units.map(label), copy: job.copy || null };
});

writeFileSync(join(OUT, 'run.json'), JSON.stringify({ run: RUN, renders: budget.used, estCostUsd: Number(budget.costUsd.toFixed(2)), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} frames passed · ${budget.used} renders · ~$${budget.costUsd.toFixed(2)}`);
for (const f of failed) console.log(`  FAILED ${f.handle} ${f.name}: ${f.attempts.map((a) => a.error || a.reasons?.join('; ')).join(' || ').slice(0, 400)}`);
const archived = archiveRunOutput({ sourceDir: OUT, runId: RUN, relativeDir: 'data/creatives/bundle-galleries', root: ROOT, label: 'build-bundle-galleries' });
if (archived) console.log(`Archived to ${archived}`);
