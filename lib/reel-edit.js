/**
 * Reel editing for agents/ugc-reels: trim the dead air at the start of a creator
 * video and burn a short text hook onto its first 3 seconds, then host the result
 * on Shopify Files so Instagram can fetch it.
 *
 * Why (measured 2026-11-03 over 51 Reels): average watch time was 3-4 seconds and
 * falling, so most viewers left before a raw Trybe video reached its point. The
 * caption cannot help with that; most viewers never open it. What they see first
 * is the frame, so the hook goes on the frame.
 *
 * What it does, and deliberately no more:
 *   - trims leading SILENCE only (silencedetect on the first 8 s), at least 0.4 s
 *     and at most 3 s, keeping 0.15 s before the first sound. It never cuts the
 *     creator's words; there are no word timings to cut on.
 *   - draws the hook (2-7 words, written with the caption and gated with it) in
 *     white on a dark box at 14% of the frame height, just below Instagram's top bar
 *     and above most creators' faces,
 *     for the first 3.2 s.
 *   - re-encodes to 720x1280 H.264/AAC (faststart), 2 threads, because the
 *     production box has 961 MB of RAM.
 *
 * NEVER COVERS THE CREATOR'S OWN TEXT. Many Trybe creators burn their own
 * captions or a title card onto the video (the first live test on 2026-11-03 put
 * our hook directly over a creator's "EIGHT"). Three frames from the first 3 s go
 * to a vision model (`detectText`); if any carries on-screen text, or the check
 * cannot answer, NO hook is drawn and only the trim applies. A video with no
 * trim and no hook is not re-encoded at all: it posts raw, which is the honest
 * outcome and keeps the edited-vs-raw comparison clean.
 *
 * FAILS OPEN. Any failure (no ffmpeg, a download error, an encode error, the
 * upload) returns { ok: false, error } and the caller posts the RAW video exactly
 * as before. An edit is an improvement; losing the day's Reel over one would not be.
 *
 * Pure helpers (hook checks, line wrapping, filter and argument building, the
 * silencedetect parser) are exported for tests; every side effect is injectable.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OUT_W = 720;
export const OUT_H = 1280;
export const HOOK_SECONDS = 3.2;
export const MIN_TRIM_S = 0.4;
export const MAX_TRIM_S = 3.0;
export const TRIM_LEAD_S = 0.15;
export const HOOK_MIN_WORDS = 2;
export const HOOK_MAX_WORDS = 7;
export const HOOK_MAX_CHARS = 42;
export const HOOK_LINE_CHARS = 18;
export const FONT_SIZE = 60;
export const LINE_GAP = 26;

/** Bold sans fonts, first one that exists wins (server: DejaVu / Liberation; Mac: Arial). */
export const FONT_CANDIDATES = Object.freeze([
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
]);

export function findFont(exists = existsSync) {
  return FONT_CANDIDATES.find((f) => exists(f)) || null;
}

/**
 * Format rules for the on-screen hook, in the shape gateGeneratedCopy's
 * `extraChecks` takes. The claim gate already reads the field; this adds what a
 * frame needs: short, plain characters the font can draw, no dashes, and no
 * number the video and product names do not carry.
 */
export function hookFormatCheck({ transcript = '', products = [] } = {}) {
  const known = `${transcript} ${(products || []).map((p) => p?.name || '').join(' ')}`;
  return {
    check(fields) {
      const h = String(fields.hook ?? '').trim();
      const hits = [];
      const hit = (why, match) => hits.push({ field: 'hook', category: 'format', why, match });
      if (!h) { hit('is missing (write a 2 to 7 word on-screen hook)', '(empty)'); return hits; }
      const words = h.split(/\s+/).length;
      if (words < HOOK_MIN_WORDS || words > HOOK_MAX_WORDS) hit(`is ${words} words; use ${HOOK_MIN_WORDS} to ${HOOK_MAX_WORDS}`, h);
      if (h.length > HOOK_MAX_CHARS) hit(`is ${h.length} characters; keep it under ${HOOK_MAX_CHARS}`, h);
      if (/[—–]/.test(h)) hit('uses an em or en dash', h);
      if (/[^A-Za-z0-9 '’?!,.]/.test(h)) hit('uses characters other than letters, numbers and simple punctuation (no emoji, hashtags or quotes)', h.match(/[^A-Za-z0-9 '’?!,.]/)[0]);
      for (const n of h.match(/\d+/g) || []) {
        if (!new RegExp(`\\b${n}\\b`).test(known)) hit(`states a number (${n}) the video and product names do not`, n);
      }
      return hits;
    },
    constraint(hits) {
      return `Your on-screen hook broke these rules; rewrite it so none apply:\n${hits.map((h) => `- It ${h.why} (${h.match})`).join('\n')}`;
    },
  };
}

/** Greedy word wrap into at most 3 lines of about HOOK_LINE_CHARS each. */
export function wrapHook(hook, width = HOOK_LINE_CHARS) {
  const lines = [];
  for (const w of String(hook || '').trim().split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= width) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines.slice(0, 3);
}

/**
 * Seconds of silence at the very start, from `ffmpeg -af silencedetect` stderr.
 * Only a silence that STARTS at 0 counts; anything else means sound from frame one.
 */
export function leadingSilence(stderr) {
  const s = String(stderr || '');
  const start = s.match(/silence_start:\s*(-?[\d.]+)/);
  if (!start || Number(start[1]) > 0.1) return 0;
  const end = s.match(/silence_end:\s*([\d.]+)/);
  return end ? Number(end[1]) : 0;
}

/**
 * A DARK OPEN: the video fades in from black (every AI-generated ad so far
 * does: frame 0 at luma 16, full brightness by frame 5). Instagram uses the
 * first frame as the cover, so the Reel shows as a black square in the grid,
 * which is how the Water Cooler ad looked on 2026-11-04. `yavgs` is the
 * per-frame average luma (signalstats YAVG) of the first second. Returns the
 * seconds to cut so the video opens on its first full-brightness frame, or 0
 * when it does not open dark. Capped at MAX_FADE_TRIM_S so a dark SCENE (a
 * night shot) is never cut away wholesale.
 */
export const MAX_FADE_TRIM_S = 1.0;
export function fadeTrimSeconds(yavgs = [], fps = 30) {
  const v = yavgs.filter((x) => Number.isFinite(x));
  if (v.length < 4 || !(fps > 0)) return 0;
  const steady = Math.max(...v);
  if (steady < 40 || v[0] > 0.6 * steady) return 0;
  const idx = v.findIndex((x) => x >= 0.95 * steady);
  const t = idx / fps;
  return idx > 0 && t <= MAX_FADE_TRIM_S ? Math.round(t * 10000) / 10000 : 0;
}

/** Parse `signalstats,metadata=print` stderr into [YAVG...] and the frame rate from ffmpeg's stream line. */
export function parseOpen(stderr) {
  const s = String(stderr || '');
  const yavgs = [...s.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const fps = Number(s.match(/,\s*([\d.]+)\s*fps/)?.[1]) || 30;
  return { yavgs, fps };
}

/** How much to cut from the front, or 0. */
export function trimSeconds(lead) {
  const t = Number(lead) - TRIM_LEAD_S;
  if (!(t >= MIN_TRIM_S)) return 0;
  return Math.round(Math.min(t, MAX_TRIM_S) * 100) / 100;
}

/** The -vf chain: fit to 720x1280, then one drawtext per hook line. */
export function buildFilter({ lineFiles = [], font }) {
  const parts = [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease`,
    `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
  ];
  lineFiles.forEach((file, i) => {
    const y = `h*0.14+${i * (FONT_SIZE + LINE_GAP)}`;
    parts.push(`drawtext=fontfile='${font}':textfile='${file}':fontsize=${FONT_SIZE}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=18:x=(w-text_w)/2:y=${y}:enable='lt(t,${HOOK_SECONDS})'`);
  });
  return parts.join(',');
}

export function encodeArgs({ input, output, trim = 0, filter }) {
  return [
    '-hide_banner', '-y',
    ...(trim > 0 ? ['-ss', String(trim)] : []),
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];
}

/** Run a binary; resolves { code, stderr }. Never rejects on a non-zero exit. */
export function run(cmd, args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (err) { resolve({ code: -1, stderr: err.message }); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += `\n(killed after ${Math.round(timeoutMs / 1000)}s)`; }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

async function download(url, path, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

export const TEXT_CHECK_PROMPT = `These are frames from the first 3 seconds of a short vertical video. Is there any text drawn ON TOP of the video in any frame: captions, subtitles, a title, a word or number added in editing? Text that is physically part of the scene (a product label, a sign, a book, a shirt) does NOT count. Answer JSON only: {"overlay_text": true|false}`;

/** Frame times (s, after the trim) the text check looks at. */
export const TEXT_CHECK_TIMES = Object.freeze([0.3, 1.5, 2.8]);

/** Parse the vision reply. Anything but an explicit false is "has text" (never cover what we cannot see). */
export function parseTextCheck(reply) {
  const m = String(reply || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]).overlay_text !== false : true; } catch { return true; }
}

/**
 * A detectText for editReel built on a lib/anthropic.js client: one call, the
 * frames as JPEG images. Returns { hasText, error? }; an error counts as text.
 */
export function visionTextDetector(client, model) {
  return async (framePaths) => {
    const { readFileSync: read } = await import('node:fs');
    try {
      const content = framePaths.map((f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: read(f).toString('base64') } }));
      content.push({ type: 'text', text: TEXT_CHECK_PROMPT });
      const msg = await client.messages.create({ model, max_tokens: 100, messages: [{ role: 'user', content }] });
      return { hasText: parseTextCheck((msg.content || []).map((b) => b.text || '').join('')) };
    } catch (err) {
      return { hasText: true, error: err.message };
    }
  };
}

async function defaultUpload(path, alt) {
  // Imported late: lib/shopify.js throws at import time without OAuth credentials.
  const { uploadFileToShopify } = await import('./shopify.js');
  return uploadFileToShopify(path, { mimeType: 'video/mp4', alt });
}

/**
 * Our own ads (config/ugc-reels.json scheduled[]) are posted as made, with no
 * hook, but a dark open is still cut so the Reel never shows as a black square.
 * Returns { ok: true, url, trimmed_s } when it trimmed and hosted a copy,
 * { ok: false, unchanged: true } when the video does not open dark, or
 * { ok: false, error } on any failure (the caller posts the original).
 * Re-encodes at the source resolution (no scaling) and high quality.
 */
export async function trimDarkOpen({ videoUrl, name = 'ad', alt = '', fetchImpl = fetch, runImpl = run, upload = defaultUpload, ffmpeg = 'ffmpeg' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reel-open-'));
  try {
    const input = join(dir, 'in');
    try { await download(videoUrl, input, fetchImpl); } catch (err) { return { ok: false, error: `could not download the video: ${err.message}` }; }
    const open = await runImpl(ffmpeg, ['-hide_banner', '-t', '1', '-i', input, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']);
    if (open.code === -1) return { ok: false, error: `ffmpeg not available: ${open.stderr.trim().slice(0, 200)}` };
    const o = parseOpen(open.stderr);
    const trim = open.code === 0 ? fadeTrimSeconds(o.yavgs, o.fps) : 0;
    if (!trim) return { ok: false, unchanged: true };
    const output = join(dir, `${String(name).replace(/[^a-z0-9-]+/gi, '-').slice(0, 60)}-open.mp4`);
    const enc = await runImpl(ffmpeg, ['-hide_banner', '-y', '-i', input, '-ss', String(trim), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]);
    if (enc.code !== 0 || !existsSync(output)) return { ok: false, error: `encode failed: ${enc.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` };
    let hosted;
    try { hosted = await upload(output, alt); } catch (err) { return { ok: false, error: `upload failed: ${err.message}` }; }
    if (!hosted?.url) return { ok: false, error: 'upload returned no url' };
    return { ok: true, url: hosted.url, trimmed_s: trim };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Edit one video and host it. Returns
 *   { ok: true, url, file_id, trimmed_s, hook, bytes }   or   { ok: false, error }.
 */
export async function editReel({
  videoUrl, hook, name = 'reel', alt = '',
  fetchImpl = fetch, runImpl = run, upload = defaultUpload, font = findFont(), ffmpeg = 'ffmpeg',
  detectText = null,
} = {}) {
  if (!font) return { ok: false, error: 'no bold font found for the hook text' };
  const lines = wrapHook(hook);
  if (!lines.length) return { ok: false, error: 'no hook text' };
  const dir = mkdtempSync(join(tmpdir(), 'reel-edit-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, `${String(name).replace(/[^a-z0-9-]+/gi, '-').slice(0, 60)}-edit.mp4`);
    try { await download(videoUrl, input, fetchImpl); } catch (err) { return { ok: false, error: `could not download the video: ${err.message}` }; }

    const probe = await runImpl(ffmpeg, ['-hide_banner', '-t', '8', '-i', input, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-']);
    if (probe.code === -1) return { ok: false, error: `ffmpeg not available: ${probe.stderr.trim().slice(0, 200)}` };
    const silenceTrim = probe.code === 0 ? trimSeconds(leadingSilence(probe.stderr)) : 0;
    const open = await runImpl(ffmpeg, ['-hide_banner', '-t', '1', '-i', input, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']);
    const fadeTrim = open.code === 0 ? (() => { const o = parseOpen(open.stderr); return fadeTrimSeconds(o.yavgs, o.fps); })() : 0;
    const trim = Math.max(silenceTrim, fadeTrim);

    // Does the creator already have text on screen? Unknown counts as yes.
    let hookSkipped = null;
    if (!detectText) hookSkipped = 'no on-screen text check available';
    else {
      const frames = [];
      for (const [i, t] of TEXT_CHECK_TIMES.entries()) {
        const f = join(dir, `frame${i}.jpg`);
        const r = await runImpl(ffmpeg, ['-hide_banner', '-y', '-ss', String(trim + t), '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', f]);
        if (r.code === 0 && existsSync(f)) frames.push(f);
      }
      const seen = frames.length ? await detectText(frames) : { hasText: true, error: 'no frames extracted' };
      if (seen.hasText) hookSkipped = seen.error ? `text check failed (${seen.error})` : 'the video already has on-screen text';
    }
    if (hookSkipped && trim === 0) return { ok: false, unchanged: true, error: `nothing to change: no silence to trim and ${hookSkipped}` };

    const lineFiles = hookSkipped ? [] : lines.map((l, i) => { const f = join(dir, `line${i}.txt`); writeFileSync(f, l); return f; });
    const enc = await runImpl(ffmpeg, encodeArgs({ input, output, trim, filter: buildFilter({ lineFiles, font }) }));
    if (enc.code !== 0 || !existsSync(output)) return { ok: false, error: `encode failed: ${enc.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` };

    const bytes = statSync(output).size;
    let hosted;
    try { hosted = await upload(output, alt); } catch (err) { return { ok: false, error: `upload failed: ${err.message}` }; }
    if (!hosted?.url) return { ok: false, error: 'upload returned no url' };
    return { ok: true, url: hosted.url, file_id: hosted.id || null, trimmed_s: trim, hook: hookSkipped ? null : lines.join(' '), hook_skipped: hookSkipped, bytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
