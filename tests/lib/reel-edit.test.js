import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hookFormatCheck, wrapHook, parseTextCheck, leadingSilence, trimSeconds, buildFilter, encodeArgs, editReel, findFont,
  MAX_TRIM_S,
} from '../../lib/reel-edit.js';

test('hookFormatCheck: length, words, characters, dashes and unsupported numbers', () => {
  const c = hookFormatCheck({ transcript: 'only 6 ingredients', products: [{ name: 'Coconut Moisturizer | 4oz' }] });
  assert.deepEqual(c.check({ hook: 'Read this label first' }), []);
  assert.deepEqual(c.check({ hook: 'Only 6 ingredients, really?' }), []);
  const why = (h) => c.check({ hook: h }).map((x) => x.why).join(' | ');
  assert.match(why(''), /missing/);
  assert.match(why('Wow'), /1 words/);
  assert.match(why('one two three four five six seven eight'), /8 words/);
  assert.match(why('Soft skin — finally'), /dash/);
  assert.match(why('Soft skin #glow'), /characters other/);
  assert.match(why('Soft skin 🥥 today'), /characters other/);
  assert.match(why('12 reasons to switch'), /number \(12\)/);
});

test('wrapHook: lines of about 18 characters, at most 3', () => {
  assert.deepEqual(wrapHook('Read the label on your lotion first'), ['Read the label on', 'your lotion first']);
  assert.equal(wrapHook('a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n').length, 3);
});

test('leadingSilence / trimSeconds: only silence from 0 counts, bounded trim', () => {
  assert.equal(leadingSilence('[silencedetect] silence_start: 0\n[silencedetect] silence_end: 1.42 | silence_duration: 1.42'), 1.42);
  assert.equal(leadingSilence('[silencedetect] silence_start: 2.5\n[silencedetect] silence_end: 3.1'), 0);
  assert.equal(leadingSilence('no audio here'), 0);
  assert.equal(trimSeconds(0.3), 0, 'under the minimum: no trim');
  assert.equal(trimSeconds(1.42), 1.27);
  assert.equal(trimSeconds(9), MAX_TRIM_S);
});

test('buildFilter / encodeArgs: fit to 720x1280, one drawtext per line for the first 3.2 s', () => {
  const f = buildFilter({ lineFiles: ['/t/0.txt', '/t/1.txt'], font: '/f.ttf' });
  assert.match(f, /^scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280/);
  assert.equal(f.match(/drawtext=/g).length, 2);
  assert.match(f, /enable='lt\(t,3.2\)'/);
  const a = encodeArgs({ input: 'in', output: 'out.mp4', trim: 1.2, filter: f });
  assert.deepEqual(a.slice(2, 6), ['-ss', '1.2', '-i', 'in']);
  assert.ok(a.includes('0:a:0?'), 'a silent video (no audio stream) still encodes');
  assert.ok(!encodeArgs({ input: 'in', output: 'o', trim: 0, filter: f }).includes('-ss'));
});

test('editReel fails open: missing ffmpeg, bad download and failed upload each return ok:false', async () => {
  const fetchOk = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  const noFfmpeg = await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: '/f.ttf', fetchImpl: fetchOk, runImpl: async () => ({ code: -1, stderr: 'spawn ffmpeg ENOENT' }) });
  assert.equal(noFfmpeg.ok, false);
  assert.match(noFfmpeg.error, /ffmpeg not available/);
  const badDl = await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: '/f.ttf', fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.match(badDl.error, /download HTTP 403/);
  assert.equal((await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: null })).ok, false);
});

const hasFfmpeg = /drawtext/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout || '')) && !!findFont();

test('editReel end to end with real ffmpeg: trims the silent lead-in and burns the hook', { skip: !hasFfmpeg && 'ffmpeg with drawtext, or a bold font, is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reel-edit-test-'));
  const src = join(dir, 'src.mp4');
  // 4 s vertical clip: 1.5 s of silence, then a tone.
  const gen = spawnSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1.5', '-f', 'lavfi', '-i', 'sine=f=440:d=2.5',
    '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src]);
  assert.equal(gen.status, 0, String(gen.stderr));
  let uploaded = null;
  const r = await editReel({
    videoUrl: 'https://example/src.mp4', hook: 'Read the label on your lotion first', name: 'test',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => readFileSync(src) }),
    detectText: async () => ({ hasText: false }),
    upload: async (path) => { uploaded = path; const out = join(dir, 'uploaded.mp4'); writeFileSync(out, readFileSync(path)); return { id: 'gid://x', url: 'https://cdn/x.mp4' }; },
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.trimmed_s > 1 && r.trimmed_s < 1.5, `trimmed ${r.trimmed_s}`);
  assert.ok(uploaded && existsSync(join(dir, 'uploaded.mp4')));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, 'uploaded.mp4')]);
  assert.equal(String(probe.stdout).trim(), '720,1280');
});

test('parseTextCheck: only an explicit false means "no text"', () => {
  assert.equal(parseTextCheck('{"overlay_text": false}'), false);
  assert.equal(parseTextCheck('{"overlay_text": true}'), true);
  assert.equal(parseTextCheck('I am not sure'), true);
  assert.equal(parseTextCheck(''), true);
});

// A fake ffmpeg: silencedetect reports `lead` seconds of silence, frame grabs and
// the encode write their output file, and every encode's -vf is recorded.
const fakeFfmpeg = (lead, filters) => async (cmd, args) => {
  if (args.includes('silencedetect=noise=-35dB:d=0.3')) return { code: 0, stderr: lead ? `silence_start: 0\nsilence_end: ${lead}` : '' };
  const out = args[args.length - 1];
  if (args.includes('-vf') && args.includes('libx264')) filters.push(args[args.indexOf('-vf') + 1]);
  writeFileSync(out, 'x');
  return { code: 0, stderr: '' };
};
const okFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

test('editReel: creator text on screen means NO hook; the trim still applies', async () => {
  const filters = [];
  const r = await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: '/f.ttf', fetchImpl: okFetch, runImpl: fakeFfmpeg(2, filters),
    detectText: async (frames) => { assert.equal(frames.length, 3); return { hasText: true }; },
    upload: async () => ({ id: 'g', url: 'https://cdn/x.mp4' }) });
  assert.equal(r.ok, true);
  assert.equal(r.hook, null);
  assert.equal(r.hook_skipped, 'the video already has on-screen text');
  assert.equal(r.trimmed_s, 1.85);
  assert.ok(!/drawtext/.test(filters[0]));
});

test('editReel: creator text and nothing to trim means the raw video posts (no re-encode, no upload)', async () => {
  const filters = [];
  let uploads = 0;
  const r = await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: '/f.ttf', fetchImpl: okFetch, runImpl: fakeFfmpeg(0, filters),
    detectText: async () => ({ hasText: true }), upload: async () => { uploads++; return { url: 'u' }; } });
  assert.equal(r.ok, false);
  assert.equal(r.unchanged, true);
  assert.equal(filters.length, 0);
  assert.equal(uploads, 0);
});

test('editReel: a failed text check counts as text, never as a clear frame', async () => {
  const filters = [];
  const r = await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: '/f.ttf', fetchImpl: okFetch, runImpl: fakeFfmpeg(1, filters),
    detectText: async () => ({ hasText: true, error: 'model timeout' }), upload: async () => ({ url: 'u' }) });
  assert.match(r.hook_skipped, /text check failed \(model timeout\)/);
  assert.ok(!/drawtext/.test(filters[0]));
});

test('editReel: no creator text means the hook is drawn', async () => {
  const filters = [];
  const r = await editReel({ videoUrl: 'v', hook: 'Soft skin today', font: '/f.ttf', fetchImpl: okFetch, runImpl: fakeFfmpeg(0, filters),
    detectText: async () => ({ hasText: false }), upload: async () => ({ url: 'u' }) });
  assert.equal(r.ok, true);
  assert.equal(r.hook, 'Soft skin today');
  assert.match(filters[0], /drawtext/);
});

test('fadeTrimSeconds: cuts a fade from black to the first full-brightness frame, never a dark scene', async () => {
  const { fadeTrimSeconds, parseOpen } = await import('../../lib/reel-edit.js');
  // Measured on the Water Cooler ad, 24 fps (2026-11-04).
  const water = [16, 36.3, 56.2, 76.2, 95.8, 113.6, 113.6, 113.7, 113.6, 113.8, 113.8, 113.8];
  assert.equal(fadeTrimSeconds(water, 24), 0.2083);
  assert.equal(fadeTrimSeconds([110, 111, 112, 113, 113], 30), 0, 'bright from frame one');
  assert.equal(fadeTrimSeconds([20, 22, 21, 23, 22, 20], 30), 0, 'a dark scene is not a fade');
  assert.equal(fadeTrimSeconds([16, ...Array(40).fill(17), 113, 113, 113, 113], 30), 0, 'longer than 1 s: not trimmed');
  const o = parseOpen('Stream #0:0: Video: h264, yuv420p, 1080x1920, 24 fps, 24 tbr\n[Parsed_metadata_1] frame:0 lavfi.signalstats.YAVG=16\nlavfi.signalstats.YAVG=36.33\n');
  assert.deepEqual(o, { yavgs: [16, 36.33], fps: 24 });
});

test('trimDarkOpen: trims and hosts a dark open; leaves a bright video alone', async () => {
  const { trimDarkOpen } = await import('../../lib/reel-edit.js');
  const okFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  const ff = (vals) => async (cmd, args) => {
    if (args.includes('signalstats,metadata=print:key=lavfi.signalstats.YAVG')) return { code: 0, stderr: `Video: h264, 24 fps\n${vals.map((v) => `lavfi.signalstats.YAVG=${v}`).join('\n')}` };
    writeFileSync(args[args.length - 1], 'x');
    return { code: 0, stderr: '' };
  };
  const dark = await trimDarkOpen({ videoUrl: 'v', fetchImpl: okFetch, runImpl: ff([16, 36, 56, 76, 96, 113, 113, 113]), upload: async () => ({ url: 'https://cdn/x.mp4' }) });
  assert.deepEqual(dark, { ok: true, url: 'https://cdn/x.mp4', trimmed_s: 0.2083 });
  const bright = await trimDarkOpen({ videoUrl: 'v', fetchImpl: okFetch, runImpl: ff([113, 113, 113, 113, 113]), upload: async () => { throw new Error('must not upload'); } });
  assert.deepEqual(bright, { ok: false, unchanged: true });
});
