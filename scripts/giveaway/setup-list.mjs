/**
 * Create (idempotently) the giveaway entrant list and record its id.
 *
 * Run once:  node scripts/giveaway/setup-list.mjs
 *
 * AFTER RUNNING, one manual step is required: the opt-in process can only be
 * CHANGED in the Klaviyo UI -> Lists -> "Giveaway 2026-09 - Entrants" ->
 * Settings -> Opt-in Process -> DOUBLE OPT-IN. Without it there is no
 * confirmation click, the +2 rung is meaningless, and the deliverability
 * protection that the existing 481 subscribers depend on is gone.
 *
 * The setting IS readable — GET /api/lists/{id}/ returns
 * attributes.opt_in_process — so scripts/giveaway/verify-launch.mjs asserts it
 * as a Gate A check rather than trusting a human to remember. Set it in the UI,
 * then let the gate confirm it.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findListByName, createList } from '../../lib/klaviyo-profiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_NAME = 'Giveaway 2026-09 — Entrants';
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');

const existing = await findListByName(LIST_NAME);
const list = existing || (await createList(LIST_NAME));
console.log(existing ? `Reusing list ${list.id}` : `Created list ${list.id}`);

const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
config.listId = list.id;
config.listName = LIST_NAME;
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote listId to ${CONFIG_PATH}`);
console.log('\n>>> MANUAL STEP: set this list to DOUBLE OPT-IN in the Klaviyo UI, then');
console.log('    VERIFY it with `node scripts/giveaway/verify-launch.mjs` — Gate A reads');
console.log('    the list\'s opt_in_process and FAILS if it is not double_opt_in. <<<');
