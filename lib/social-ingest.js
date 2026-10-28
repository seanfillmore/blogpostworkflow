/**
 * Ingest a finished ad batch (agents/ad-batch output) into the Social queue as
 * PENDING items, for Sean to approve in the dashboard's Social tab.
 *
 * Runs on the Mac, where the batch folders live (~/Desktop/Ad Batches/...), but the
 * queue lives on the production server, so items are delivered through the
 * dashboard's authenticated POST /api/social/ingest. For each KEPT image in the
 * batch's run.json:
 *   1. skip it if the server already holds its id or its source file
 *      (`<batch dir>/<concept dir>/<file>`), BEFORE any upload, so a re-run never
 *      uploads a duplicate to Shopify Files;
 *   2. write a suggested caption: one model call per image, grounded ONLY in the
 *      batch's meta-copy.md primary texts and the image's own headline/subhead,
 *      distinct from the captions already written for this batch, checked by
 *      captionProblems() plus two checks of its own (every number must appear in
 *      the sources; no repeated opening). One retry naming the problems; a caption
 *      that still fails is left EMPTY with the reason. The image is never dropped:
 *      Sean can write the caption in the tab;
 *   3. convert to JPEG (Instagram takes nothing else), upload to Shopify Files
 *      (additive), and POST the item.
 *
 * Dry by default: a dry run reads the server's queue and lists what it would add,
 * with no model call and no upload.
 *
 * Every dependency is injected so tests never touch the network, Shopify or a model.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { LLM_MODELS } from '../config/llm-models.js';
import { captionProblems, stripDashes, REQUIRED_HASHTAG } from './social-queue.js';

export const DEFAULT_REMOTE_URL = 'https://gizmo-borax-domain.ngrok-free.dev';

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** { primaryTexts, headlines } from a batch's meta-copy.md (numbered lists under those headings). */
export function parseMetaCopy(md = '') {
  const out = { primaryTexts: [], headlines: [] };
  let section = null;
  for (const line of String(md).split('\n')) {
    const h = line.match(/^#{2,}\s*(.+?)\s*$/);
    if (h) {
      const t = h[1].toLowerCase();
      section = t.includes('primary') ? 'primaryTexts' : t.includes('headline') ? 'headlines' : null;
      continue;
    }
    const m = line.match(/^\s*\d+[.)]\s+(.+?)\s*$/);
    if (section && m) out[section].push(m[1]);
  }
  return out;
}

/** The images in run.json that were kept, each with its queue id and source key. */
export function planBatch(run, batchDir) {
  const batch = basename(batchDir);
  const product = run?.product?.handle || (run?.product?.items || []).map((i) => i.handle).join('+') || null;
  const out = [];
  (run?.concepts || []).forEach((c, ci) => {
    for (const img of c.images || []) {
      if (!img.ok || !img.file) continue;
      const notes = (img.notes || []).map(String);
      out.push({
        // The headline is part of the id: two batches of one product, variant and day
        // share a batch folder name and both number their scenes custom-01.., so
        // without it a second batch's images read as "already queued" and are never
        // queued (2026-10-27: 12 Fall cream images collided with the Halloween set).
        id: slug(`${batch}-c${ci + 1}-${slug(c.headline).slice(0, 40)}-${img.scene?.id || basename(img.file, '.png')}`).slice(0, 120).replace(/-+$/, ''),
        source: `${batch}/${relative(batchDir, img.file)}`,
        file: img.file,
        batch,
        product,
        headline: c.headline || null,
        subhead: c.subhead || null,
        scene: img.scene?.scene || img.scene?.id || null,
        needs_human_review: img.needsHumanReview === true || notes.length > 0,
        review_notes: notes,
      });
    }
  });
  return out;
}

const NUM_RE = /\d+(?:[.,]\d+)?/g;
const opening = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');

/** captionProblems() plus the two ingest-only checks: grounded numbers and a distinct opening. */
export function suggestedCaptionProblems(caption, { sourceText = '', prior = [] } = {}) {
  const out = captionProblems(caption);
  const have = new Set(String(sourceText).match(NUM_RE) || []);
  for (const n of new Set(String(caption).match(NUM_RE) || [])) {
    if (!have.has(n)) out.push(`the number ${n} is not in the batch's approved copy`);
  }
  const op = opening(caption);
  if (op && prior.some((p) => opening(p) === op)) out.push('opens with the same words as another caption in this batch');
  if (prior.some((p) => p.trim() === String(caption).trim())) out.push('identical to another caption in this batch');
  return out;
}

export function captionPrompt({ copy, image, prior = [], problems = [] }) {
  return [
    'Write ONE Instagram and Facebook caption for a Real Skin Care static ad image.',
    '',
    'Use ONLY facts stated in the approved copy below. Do not add a single new fact, number, ingredient, benefit or promise.',
    '',
    `The image says: "${image.headline || ''}"${image.subhead ? ` / "${image.subhead}"` : ''}`,
    '',
    'Approved Meta primary texts for this batch:',
    ...copy.primaryTexts.map((t, i) => `${i + 1}. ${t}`),
    ...(copy.headlines.length ? ['', 'Approved headlines:', ...copy.headlines.map((t, i) => `${i + 1}. ${t}`)] : []),
    '',
    'Rules:',
    '- 2 short paragraphs, about 25 to 60 words, in a plain human voice. Lead with what the image says.',
    '- The second paragraph ends with a "link in bio" call to action (for example "Link in bio." or "...at the link in our bio.").',
    `- Then a final line of 3 or 4 hashtags starting with ${REQUIRED_HASHTAG}.`,
    '- No links or URLs. No em dashes or en dashes. No emoji.',
    '- Never say the product heals, treats, cures or prevents anything, and never name a skin condition.',
    ...(prior.length ? ['', 'Captions already written for other images in this batch. Yours must open differently and not repeat them:', ...prior.map((p) => `---\n${p}`)] : []),
    ...(problems.length ? ['', 'Your previous attempt was refused for:', ...problems.map((p) => `- ${p}`), 'Fix every one.'] : []),
    '',
    'Return only the caption text, nothing else.',
  ].join('\n');
}

/** { caption, reason } — caption is '' when two attempts both failed, and reason says why. */
export async function writeCaption({ anthropic, copy, image, prior = [] }) {
  const sourceText = [...copy.primaryTexts, ...copy.headlines, image.headline || '', image.subhead || ''].join('\n');
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = '';
    try {
      const res = await anthropic.messages.create({
        model: LLM_MODELS.standard,
        max_tokens: 600,
        messages: [{ role: 'user', content: captionPrompt({ copy, image, prior, problems }) }],
      });
      if (res.stop_reason === 'max_tokens') throw new Error('caption cut off at the token limit');
      text = stripDashes((res.content || []).map((c) => c.text || '').join('').trim().replace(/^["']|["']$/g, ''));
    } catch (err) { problems = [`model call failed: ${err.message}`]; continue; }
    problems = suggestedCaptionProblems(text, { sourceText, prior });
    if (!problems.length) return { caption: text, reason: null };
  }
  return { caption: '', reason: problems.join('; ') };
}

function authHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** A tiny client for the dashboard's Social endpoints. */
export function remoteQueue({ url = DEFAULT_REMOTE_URL, user, pass, fetchImpl = fetch }) {
  if (!user || !pass) throw new Error('DASHBOARD_USER / DASHBOARD_PASSWORD are not in .env');
  const headers = { authorization: authHeader(user, pass), 'ngrok-skip-browser-warning': '1' };
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}${path}`, {
      method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`${method} ${path}: HTTP ${res.status}, not JSON`);
    if (!res.ok && !json.created) throw new Error(`${method} ${path}: HTTP ${res.status}: ${json.error || JSON.stringify(json.invalid || json)}`);
    return json;
  };
  return {
    known: async () => (await call('GET', '/api/social/items')).known || { ids: [], sources: [] },
    ingest: (items) => call('POST', '/api/social/ingest', { items }),
  };
}

/**
 * Plan (and with apply, perform) the ingest of one batch directory.
 * deps: { remote, anthropic, toJpeg(file, id) -> jpgPath, upload(jpgPath, {alt}) -> {id, url}, log }
 */
export async function ingestBatch({ batchDir, apply = false, deps, postBy = null }) {
  if (postBy && !/^\d{4}-\d{2}-\d{2}$/.test(postBy)) throw new Error(`--post-by must be YYYY-MM-DD (got ${postBy})`);
  const { remote, log = console.log } = deps;
  const runPath = join(batchDir, 'run.json');
  if (!existsSync(runPath)) throw new Error(`no run.json in ${batchDir}`);
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const copyPath = join(batchDir, 'meta-copy.md');
  const copy = existsSync(copyPath) ? parseMetaCopy(readFileSync(copyPath, 'utf8')) : { primaryTexts: [], headlines: [] };
  const plan = planBatch(run, batchDir);

  const known = await remote.known();
  const ids = new Set(known.ids || []);
  const sources = new Set(known.sources || []);
  const todo = [];
  const already = [];
  for (const p of plan) {
    if (ids.has(p.id) || sources.has(p.source)) already.push(p);
    else todo.push(p);
  }
  const missing = todo.filter((p) => !existsSync(p.file));
  const ready = todo.filter((p) => existsSync(p.file));
  const summary = { batch: basename(batchDir), kept: plan.length, already: already.map((p) => p.id), missing: missing.map((p) => p.id), created: [], failed: [], uncaptioned: [], dryRun: !apply };
  for (const p of already) log(`  already queued: ${p.source}`);
  for (const p of missing) log(`  file missing, skipped: ${p.file}`);
  if (!copy.primaryTexts.length && ready.length) log('  no meta-copy.md primary texts: suggested captions are grounded in the image headline only');
  if (!apply) {
    for (const p of ready) log(`  would add ${p.id} <- ${p.source}${p.needs_human_review ? ' (flagged: check image)' : ''}${postBy ? ` (post by ${postBy})` : ''}`);
    summary.wouldAdd = ready.map((p) => p.id);
    return summary;
  }

  const prior = [];
  for (const p of ready) {
    try {
      const { caption, reason } = await writeCaption({ anthropic: deps.anthropic, copy, image: p, prior });
      if (caption) prior.push(caption); else summary.uncaptioned.push({ id: p.id, reason });
      const jpg = await deps.toJpeg(p.file, p.id);
      const up = await deps.upload(jpg, { alt: `${p.batch}: ${p.headline || p.id}` });
      const item = {
        id: p.id, source: p.source, batch: p.batch, product: p.product, headline: p.headline, subhead: p.subhead, scene: p.scene,
        image_url: up.url, shopify_file_id: up.id, suggested_caption: caption, caption,
        suggested_caption_reason: reason, needs_human_review: p.needs_human_review, review_notes: p.review_notes,
        ...(postBy ? { post_by: postBy } : {}),
      };
      const r = await remote.ingest([item]);
      if ((r.created || []).includes(p.id)) { summary.created.push(p.id); log(`  added ${p.id}${caption ? '' : ' (no suggested caption: ' + reason + ')'}`); } else {
        summary.failed.push({ id: p.id, error: JSON.stringify(r.skipped || r.invalid) });
        log(`  NOT added ${p.id}: ${JSON.stringify(r.skipped || r.invalid)}`);
      }
    } catch (err) {
      summary.failed.push({ id: p.id, error: err.message });
      log(`  FAILED ${p.id}: ${err.message}`);
    }
  }
  return summary;
}

export function rerunCommand(batchDir) {
  return `node scripts/social-queue-ingest.mjs --batch "${batchDir}" --apply`;
}
