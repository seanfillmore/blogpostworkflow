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

/** Short backoff. lib/retry.js waits 60s per attempt, which is unusable in a CLI. */
const RETRY_STATUSES = new Set([408, 429, 503]);
const DEFAULT_BACKOFF_MS = 1000;

function classify(status, detail) {
  if (status === 401) return new TranscriptError('TranscriptAPI rejected the key (401). Check TRANSCRIPTAPI_KEY in .env.', { status, code: 'AUTH' });
  if (status === 402) return new TranscriptError(`TranscriptAPI is out of credits (402). ${detail ?? ''}`.trim(), { status, code: 'NO_CREDITS' });
  if (status === 404) return new TranscriptError(detail ?? 'Video not found or has no transcript.', { status, code: 'NOT_FOUND' });
  if ([408, 429, 503].includes(status)) return new TranscriptError(`TranscriptAPI returned ${status}. ${detail ?? ''}`.trim(), { status, code: 'RATE_LIMIT' });
  return new TranscriptError(`TranscriptAPI returned ${status}. ${detail ?? ''}`.trim(), { status, code: 'HTTP' });
}

async function request(path, { apiKey, fetchImpl, backoffMs }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return res.json();

    let detail = null;
    try { detail = (await res.json())?.detail ?? null; } catch { /* non-JSON body */ }

    if (RETRY_STATUSES.has(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, backoffMs * 3 ** attempt));
      continue;
    }
    throw classify(res.status, detail);
  }
}

/**
 * Fetch a transcript. Calls the FREE /youtube/info first so that a video with
 * no English captions costs nothing — the common skip case must not burn a credit.
 */
export async function fetchTranscript(urlOrId, { apiKey, fetchImpl = fetch, backoffMs = DEFAULT_BACKOFF_MS } = {}) {
  if (!apiKey) {
    throw new TranscriptError('TRANSCRIPTAPI_KEY is not set. Add it to .env.', { code: 'NO_KEY' });
  }
  const videoId = extractVideoId(urlOrId);

  // 0 credits.
  const info = await request(`/youtube/info?video_url=${videoId}`, { apiKey, fetchImpl, backoffMs });
  const language = pickLanguage(info.available_languages);
  if (!language) {
    throw new TranscriptError(`No English captions available for ${videoId}.`, { status: 404, code: 'NO_ENGLISH' });
  }

  // 1 credit.
  const params = new URLSearchParams({
    video_url: videoId,
    format: 'text',
    include_timestamp: 'false',
    send_metadata: 'true',
    language,
  });
  const data = await request(`/youtube/transcript?${params}`, { apiKey, fetchImpl, backoffMs });
  const meta = data.metadata ?? info.metadata ?? {};

  return {
    videoId,
    title: meta.title ?? null,
    creator: meta.author_name ?? null,
    creatorUrl: meta.author_url ?? null,
    durationSeconds: data.length_seconds ?? null,
    language: data.language ?? language,
    text: normalizeTranscriptText(data.transcript),
  };
}
