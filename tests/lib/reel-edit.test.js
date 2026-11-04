import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hookFormatCheck, wrapHook, leadingSilence, trimSeconds, buildFilter, encodeArgs, editReel, findFont,
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
    upload: async (path) => { uploaded = path; const out = join(dir, 'uploaded.mp4'); writeFileSync(out, readFileSync(path)); return { id: 'gid://x', url: 'https://cdn/x.mp4' }; },
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.trimmed_s > 1 && r.trimmed_s < 1.5, `trimmed ${r.trimmed_s}`);
  assert.ok(uploaded && existsSync(join(dir, 'uploaded.mp4')));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, 'uploaded.mp4')]);
  assert.equal(String(probe.stdout).trim(), '720,1280');
});
