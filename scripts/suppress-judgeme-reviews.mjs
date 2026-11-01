#!/usr/bin/env node
/**
 * Suppress an explicit, human-approved list of Judge.me reviews.
 *
 *   node scripts/suppress-judgeme-reviews.mjs data/reviews/<list>.json            # DRY
 *   node scripts/suppress-judgeme-reviews.mjs data/reviews/<list>.json --apply
 *   node scripts/suppress-judgeme-reviews.mjs --restore <run-dir>
 *
 * dedupe-judgeme-reviews.mjs handles the one case safe to automate (same body,
 * product AND reviewer). Everything else needs a person to decide, so this
 * script takes a committed list with a reason per id and decides nothing.
 *
 * Same mechanics as the dedupe, imported rather than copied: suppress with
 * {curated:"spam", hidden:true} (there is no delete), READ BACK every write
 * (the API reports success on writes it ignores), archive the corpus and the
 * plan before the first write, record every ATTEMPT before its outcome is
 * known, and --restore puts back everything the run touched.
 *
 * Refuses to suppress a review rated 3 stars or below: hiding a genuine
 * negative review is review suppression under the FTC's 2024 rule, whatever
 * the list says.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { creds, fetchAll, putVerified } from './dedupe-judgeme-reviews.mjs';
import { isDirectRun } from '../lib/is-direct-run.js';

const OUT_DIR = 'data/reports/judgeme-suppress';

/** Pure: the writes a list implies against the current corpus. Throws on a negative review. */
export function planFromList(list, reviews) {
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const plan = [];
  const missing = [];
  for (const e of list) {
    const r = byId.get(e.id);
    if (!r) { missing.push(e.id); continue; }
    if (r.rating <= 3) throw new Error(`review ${e.id} is ${r.rating}★ — refusing to suppress a negative review`);
    if (r.curated === 'spam' && r.hidden) continue;
    plan.push({ id: r.id, why: e.why, product: r.product_handle, reviewer: r.reviewer?.name ?? null, rating: r.rating,
      was: { published: r.published, hidden: r.hidden, curated: r.curated } });
  }
  return { plan, missing };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rIdx = process.argv.indexOf('--restore');
  const c = creds();

  if (rIdx !== -1) {
    const dir = process.argv[rIdx + 1];
    let rec = JSON.parse(readFileSync(join(dir, 'suppressed.json'), 'utf8'));
    if (!rec.length && existsSync(join(dir, 'plan.json'))) rec = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    let ok = 0;
    for (const e of rec) {
      const r = await putVerified(e.id, { curated: 'ok', hidden: false }, { published: true, hidden: false }, c);
      console.log(`  ${r.ok ? '✓' : '✗'} ${e.id}${r.ok ? '' : ` — ${r.why}`}`);
      if (r.ok) ok += 1;
    }
    console.log(`\n${ok}/${rec.length} restored.`);
    return;
  }

  const listPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!listPath) { console.error('usage: suppress-judgeme-reviews.mjs <list.json> [--apply] | --restore <run-dir>'); process.exit(64); }
  const list = JSON.parse(readFileSync(listPath, 'utf8')).reviews;
  const reviews = await fetchAll(c);
  const { plan, missing } = planFromList(list, reviews);

  const reasons = {};
  for (const p of plan) reasons[p.why] = (reasons[p.why] ?? 0) + 1;
  console.log(`Judge.me suppress — ${apply ? 'APPLY' : 'DRY RUN'}  (${listPath})\n`);
  console.log(`  listed ${list.length} · to suppress ${plan.length} · already suppressed ${list.length - plan.length - missing.length} · not found ${missing.length}`);
  for (const [w, n] of Object.entries(reasons)) console.log(`    ${String(n).padStart(3)}  ${w}`);
  if (!plan.length || !apply) { console.log(apply ? '\nNothing to do.' : '\nNothing written. Re-run with --apply.'); return; }

  const dir = join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'corpus-before.json'), JSON.stringify(reviews, null, 1));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 1));

  const touched = [];
  const flush = () => writeFileSync(join(dir, 'suppressed.json'), JSON.stringify(touched, null, 1));
  let ok = 0;
  for (const p of plan) {
    touched.push({ ...p, attempted: true, ok: null }); flush();
    const r = await putVerified(p.id, { curated: 'spam', hidden: true }, { published: false, hidden: true }, c);
    touched[touched.length - 1].ok = r.ok;
    if (!r.ok) touched[touched.length - 1].why_failed = r.why;
    flush();
    if (r.ok) ok += 1; else console.log(`  ✗ ${p.id} — ${r.why}`);
  }
  console.log(`\n${ok}/${plan.length} suppressed and verified. Restore with:\n  node scripts/suppress-judgeme-reviews.mjs --restore ${dir}`);
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
