/**
 * lib/transcript-source.js
 *
 * The ONLY file that knows TranscriptAPI exists. Exposes fetchTranscript(),
 * which returns a normalized shape. If the vendor dies or prices badly, a
 * yt-dlp implementation drops in behind the same signature without touching
 * the agent.
 *
 * API facts verified by live probe 2026-07-27 — see the spec.
 */

const BASE = 'https://transcriptapi.com/api/v2';

export class TranscriptError extends Error {
  constructor(message, { status = null, code = 'UNKNOWN' } = {}) {
    super(message);
    this.name = 'TranscriptError';
    this.status = status;
    this.code = code;
  }
}

/** Accepts a bare 11-char id, a watch URL, or a youtu.be short URL. */
export function extractVideoId(urlOrId) {
  const s = String(urlOrId).trim();
  if (/^[\w-]{11}$/.test(s)) return s;

  const patterns = [
    /[?&]v=([\w-]{11})/,          // watch?v=
    /youtu\.be\/([\w-]{11})/,     // youtu.be/
    /\/(?:embed|shorts|v)\/([\w-]{11})/, // /embed/ /shorts/ /v/
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  throw new TranscriptError(`Could not extract a YouTube video id from: ${s}`, { code: 'BAD_URL' });
}

/**
 * Build the comma-separated `language` priority list from /youtube/info's
 * available_languages. Manual English ("en", "en-GB") is preferred over
 * auto-generated ("asr-en") because ASR output is materially noisier.
 * Returns null when the video has no English track at all.
 */
export function pickLanguage(availableLanguages = []) {
  const codes = availableLanguages.map((l) => l.code).filter(Boolean);
  const isAsr = (c) => c.toLowerCase().startsWith('asr-');
  const isEnglish = (c) => /^(asr-)?en(-|$)/i.test(c);

  const english = codes.filter(isEnglish);
  const manual = english.filter((c) => !isAsr(c));
  const asr = english.filter(isAsr);
  const ordered = [...manual, ...asr];
  return ordered.length ? ordered.join(',') : null;
}

/**
 * Caption text arrives with line-wrap newlines mid-sentence. Timestamps are
 * stripped defensively — include_timestamp=false should already prevent them,
 * but the parameter defaults to true and a regression there would silently
 * poison every extraction prompt.
 */
export function normalizeTranscriptText(raw) {
  return String(raw ?? '')
    .replace(/\[\d+(?:\.\d+)?s\]\s*/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
