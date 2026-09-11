#!/usr/bin/env node
/**
 * Run Shopify CLI theme commands with this repo's existing custom-app token.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Theme work was happening on the LIVE theme because there was no other way to
 * see a change render. Sean, 2026-08-30: "We should not be making changes to the
 * live theme and testing them in production."
 *
 * The obvious answer, Shopify's Theme Access app, is not installed on this store
 * and the operator does not want another app. It is also not required. Shopify
 * documents THREE auth methods for `shopify theme`, and the third is a
 * **custom app access token** with `read_themes` + `write_themes`, passed as
 * `--password`. This store's existing custom app already holds both (verified
 * 2026-08-30 against /admin/oauth/access_scopes.json), which is why every theme
 * read in this repo already works. So the CLI needs no new credential at all —
 * only the token it was never handed.
 *
 * `unauthenticated_read_content` is NOT granted, and that is a known, bounded
 * gap: per Shopify's docs it enables HOT RELOADING via the Storefront API. The
 * dev server runs without it; edits need a manual refresh.
 *
 * THE GUARD
 * ─────────
 * `shopify theme push` writes to whichever theme it is pointed at, and the
 * default target is the one you last used — which on this store is the LIVE
 * theme. That is precisely the accident this wrapper exists to prevent, so:
 *
 *   - `dev` and `push` default to a DEVELOPMENT/unpublished theme.
 *   - Anything that could target the live theme (`--live`, `--theme <live id>`,
 *     `--publish`, `--allow-live`) is REFUSED unless `--allow-live-theme` is
 *     passed, which a human types after deciding. Same shape as the publisher's
 *     `--allow-divergent-mirror`: the routine caller must not be able to disarm
 *     the gate, or it is not a gate.
 *
 * `theme/` IS A PARTIAL MIRROR, SO EVERY PUSH MUST NAME ITS FILES (2026-09-11)
 * ─────────────────────────────────────────────────────────────────────────────
 * The checkout holds a handful of templates and sections — no layout, no config.
 * A push without `--only` is therefore wrong in both directions: to a NEW
 * unpublished theme it creates a theme that cannot render, and to an EXISTING
 * theme it can delete every remote file the mirror lacks. So `push` is refused
 * without `--only` (override: `--allow-full-push`, for a human who has checked).
 *
 * A "SUCCESS" FROM THE CLI IS NOT EVIDENCE, SO THE PUSH IS READ BACK
 * ──────────────────────────────────────────────────────────────────
 * On 2026-09-10 `push --theme <preview> --nodelete --only templates/…json` printed
 * "Uploading files 100% … pushed successfully" and changed NOTHING: every target
 * file still carried the live theme's checksum. The CLI had warned "It doesn't
 * seem like you're running this command in a theme directory" — the partial
 * mirror again. Nothing checked, so a preview that did not contain the change
 * would have been reviewed as if it did. After any push that exits 0, every
 * `--only` file is now read back from the target theme and compared with the
 * local copy (parsed, for JSON). A mismatch exits 2 and names the file. A push
 * with no resolvable single target (`--unpublished`, a theme NAME) cannot be
 * read back and says so rather than implying it was verified.
 *
 * THE RELIABLE PREVIEW PATH, since a fresh unpublished push cannot render:
 *   1. duplicate the live theme (Admin GraphQL `themeDuplicate`) → preview id
 *   2. npm run theme -- push --theme <preview id> --nodelete --only templates/x.json
 *      (verified automatically), or write the asset through the Admin API
 *   3. render with a cookie-following `?preview_theme_id=<id>` request
 *
 * USAGE
 *   npm run theme -- dev
 *   npm run theme -- push --theme <preview id> --nodelete --only templates/x.json
 *   npm run theme -- list
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { resolveLiveThemeId, UNRESOLVED_LIVE_THEME_REASON } from '../lib/shopify-live-theme.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * THIS FILE HOLDS NO HARDCODED LIVE THEME ID, and that absence is the fix
 * rather than an omission. It used to pin one as a constant; the store was
 * republished on 2026-09-01, that theme became an unpublished backup, and the
 * guard went on protecting a dead theme while waving through the real one.
 * See `lib/shopify-live-theme.js` for the full account. The published theme is
 * resolved from the API at call time by `role === 'main'`, which is the only
 * thing that cannot go stale.
 */

/**
 * Every spelling the Shopify CLI accepts for "target this theme id".
 * `indexOf('--theme')` alone missed `--theme=<id>` entirely, which is the
 * form a scripted caller naturally writes — the second half of the same bug.
 */
export function targetedThemeIds(argv) {
  const ids = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    const eq = a.match(/^(?:--theme|-t)=(.+)$/);
    if (eq) { ids.push(eq[1]); continue; }
    if (a === '--theme' || a === '-t') {
      if (argv[i + 1] !== undefined) ids.push(String(argv[i + 1]));
    }
  }
  return ids;
}

/** Every `--only` path, in all spellings the CLI accepts. */
export function onlyPaths(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    const eq = a.match(/^(?:--only|-o)=(.+)$/);
    if (eq) { paths.push(eq[1]); continue; }
    if (a === '--only' || a === '-o') {
      if (argv[i + 1] !== undefined) paths.push(String(argv[i + 1]));
    }
  }
  return paths;
}

/**
 * Arguments that could point a write at the published theme.
 * `--allow-live-theme` is the deliberate override and is stripped before exec.
 */
export const LIVE_TARGETING_FLAGS = Object.freeze([
  '--live', '--publish', '--allow-live', '--development-theme-id',
]);

/** Our own vocabulary — stripped before exec, because the Shopify CLI would reject them. */
const OVERRIDE_FLAGS = Object.freeze(['--allow-live-theme', '--allow-full-push']);

export const PARTIAL_MIRROR_REASON = 'a `push` without --only pushes the PARTIAL theme/ mirror — it creates a theme '
  + 'that cannot render, or deletes remote files the mirror lacks. Name the files with --only '
  + '(or pass --allow-full-push after checking)';

/**
 * @param {string[]} argv
 * @param {string|null} liveThemeId  resolved at call time; `null` means "could
 *   not determine", which REFUSES an id-targeting push rather than allowing it.
 * @returns {{ok:true, argv:string[]}|{ok:false, reason:string}}
 */
export function guardArgs(argv, liveThemeId) {
  const allowLive = argv.includes('--allow-live-theme');
  const allowFull = argv.includes('--allow-full-push');
  const rest = argv.filter((a) => !OVERRIDE_FLAGS.includes(a));

  if (!allowLive) {
    for (const flag of LIVE_TARGETING_FLAGS) {
      if (rest.includes(flag)) {
        return { ok: false, reason: `${flag} targets the published theme` };
      }
    }

    const targeted = targetedThemeIds(rest);
    if (targeted.length > 0) {
      // Unknown live id + an explicit target = refuse. The failure direction has
      // to be "we declined to push", never "we pushed to production because we
      // could not check". A `--unpublished` push needs no id and is unaffected.
      if (!liveThemeId) return { ok: false, reason: UNRESOLVED_LIVE_THEME_REASON };
      if (targeted.some((id) => id === String(liveThemeId))) {
        return { ok: false, reason: `--theme ${liveThemeId} is the LIVE theme` };
      }
    }
    // A bare `push` with no target reuses the last-used theme, which on this store
    // is the live one. Make the safe choice explicit rather than inherited.
    if (rest[0] === 'push' && !rest.includes('--unpublished') && targeted.length === 0) {
      return { ok: false, reason: 'a bare `push` reuses the last-used theme, which here is LIVE' };
    }
  }

  // Applies even under --allow-live-theme: a full push to LIVE from the partial
  // mirror is the single most destructive command this wrapper can run.
  if (rest[0] === 'push' && !allowFull && onlyPaths(rest).length === 0) {
    return { ok: false, reason: PARTIAL_MIRROR_REASON };
  }
  return { ok: true, argv: rest };
}

const stripTemplateComment = (s) => String(s).replace(/^\/\*[\s\S]*?\*\/\s*/, '');

/** null when the target holds what was pushed; otherwise the reason it does not. */
export function comparePushed(localText, remoteText, key) {
  if (remoteText == null) return 'missing on the target theme';
  if (String(key).endsWith('.json')) {
    try {
      return JSON.stringify(JSON.parse(stripTemplateComment(localText)))
        === JSON.stringify(JSON.parse(stripTemplateComment(remoteText)))
        ? null : 'target theme content differs from the local file';
    } catch { /* fall through to a byte comparison */ }
  }
  return localText === remoteText ? null : 'target theme content differs from the local file';
}

/**
 * Read every pushed file back from the target theme. Retries, because a Shopify
 * asset read can briefly return the previous value after a successful write.
 * @returns {Promise<Array<{key:string, why:string}>>} empty when everything matches
 */
export async function verifyPushed({ themeId, keys, readLocal, readRemote, attempts = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 1500 }) {
  const failures = [];
  for (const key of keys) {
    if (/[*?[\]{}]/.test(key)) {
      failures.push({ key, why: 'a glob cannot be read back — list the files explicitly' });
      continue;
    }
    let local;
    try { local = await readLocal(key); } catch { failures.push({ key, why: 'the local file could not be read' }); continue; }
    let why = null;
    for (let i = 0; i < attempts; i += 1) {
      let remote = null;
      try { remote = await readRemote(themeId, key); } catch { remote = null; }
      why = comparePushed(local, remote, key);
      if (!why) break;
      if (i < attempts - 1) await sleep(delayMs);
    }
    if (why) failures.push({ key, why });
  }
  return failures;
}

/** The single theme a push wrote to, when it can be known; otherwise null. */
export function pushTarget(argv, liveThemeId) {
  const ids = targetedThemeIds(argv);
  if (ids.length === 1 && /^\d+$/.test(ids[0])) return ids[0];
  if (ids.length === 0 && argv.includes('--live') && liveThemeId) return String(liveThemeId);
  return null;
}

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

async function main(argv) {
  if (!argv.length || argv.includes('--help')) {
    console.log('Usage: npm run theme -- <dev|push --theme <id> --only <file>|list|info> [...]');
    console.log('Live-theme writes require --allow-live-theme, typed deliberately.');
    return 0;
  }

  // Resolved from the API, never from a constant — see resolveLiveThemeId.
  // A failure here yields null, which makes the guard refuse rather than allow.
  let liveThemeId = null;
  try {
    liveThemeId = await resolveLiveThemeId();
  } catch {
    liveThemeId = null;
  }
  if (!liveThemeId) {
    console.error('WARNING: could not resolve the live theme id from the API.');
  }

  const guard = guardArgs(argv, liveThemeId);
  if (!guard.ok) {
    console.error(`REFUSED: ${guard.reason}.`);
    console.error('This wrapper exists so theme changes are not tested in production.');
    console.error('Preview instead: duplicate the live theme (themeDuplicate), then');
    console.error('  npm run theme -- push --theme <preview id> --nodelete --only templates/<file>.json');
    console.error('If you have decided to write to the live theme, pass --allow-live-theme.');
    return 64;
  }

  const shopify = await import('../lib/shopify.js');
  const token = await shopify.getAccessToken();
  const store = envValue('SHOPIFY_STORE');
  if (!token || !store) { console.error('missing SHOPIFY token or SHOPIFY_STORE'); return 1; }

  // `theme` is prepended here rather than typed by the caller, so the guard
  // above always sees the subcommand in a known position and a caller can never
  // reach a NON-theme command (`shopify app deploy`) through this wrapper.
  const args = ['theme', ...guard.argv, '--store', store, '--password', token];
  console.log(`shopify theme ${guard.argv.join(' ')} --store ${store} --password ***`);

  const code = await new Promise((resolve) => {
    const child = spawn('shopify', args, {
      cwd: join(ROOT, 'theme'),
      stdio: 'inherit',
      // Hot reload needs unauthenticated_read_content, which this app lacks.
      env: { ...process.env, SHOPIFY_CLI_THEME_TOKEN: token, SHOPIFY_FLAG_STORE: store },
    });
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', (e) => { console.error(`could not run the Shopify CLI: ${e.message}`); resolve(1); });
  });

  if (code !== 0 || guard.argv[0] !== 'push') return code;

  const keys = onlyPaths(guard.argv);
  const target = pushTarget(guard.argv, liveThemeId);
  if (!target || keys.length === 0) {
    console.error('\nNOT VERIFIED: this push has no single numeric --theme target (or no --only list) to read back.');
    console.error('The CLI\'s "pushed successfully" is not evidence — read the assets back before trusting it.');
    return code;
  }
  const failures = await verifyPushed({
    themeId: target,
    keys,
    readLocal: (key) => readFileSync(join(ROOT, 'theme', key), 'utf8'),
    readRemote: (id, key) => shopify.getThemeAsset(id, key),
  });
  if (failures.length) {
    console.error(`\nPUSH NOT VERIFIED — the CLI reported success but theme ${target} does not hold what was pushed:`);
    for (const f of failures) console.error(`  ✗ ${f.key}: ${f.why}`);
    return 2;
  }
  console.log(`\n✓ read back ${keys.length} file(s) from theme ${target}: all match the local copy`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
