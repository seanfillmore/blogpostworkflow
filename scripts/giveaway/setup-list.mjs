/**
 * Create (idempotently) the giveaway entrant list and record its id.
 *
 * Run once:  node scripts/giveaway/setup-list.mjs
 *
 * AFTER RUNNING, one manual step is required and cannot be automated:
 * Klaviyo UI -> Lists -> "Giveaway 2026-09 - Entrants" -> Settings ->
 * Opt-in Process -> DOUBLE OPT-IN. The API does not expose this field. Without
 * it there is no confirmation click, the +2 rung is meaningless, and the
 * deliverability protection that the existing 481 subscribers depend on is gone.
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
console.log('\n>>> MANUAL STEP: set this list to DOUBLE OPT-IN in the Klaviyo UI. <<<');
