/**
 * lib/text-source.js
 *
 * The file-source seam, sibling to lib/transcript-source.js. Both loaders return
 * the same normalized shape so everything downstream of the loader stays
 * source-agnostic.
 *
 * Text only, by design: Node has no good built-in PDF extractor and this repo
 * takes no new npm dependencies. Conversion is a documented manual step — see
 * the runbook in docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md
 * and digitalassets/README.md.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/** A converted 188-page book is ~264 KB. A PDF passed by mistake is multiple MB. */
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md']);

export class TextSourceError extends Error {
  constructor(message, { code = 'UNKNOWN' } = {}) {
    super(message);
    this.name = 'TextSourceError';
    this.code = code;
  }
}

/** Kebab slug used for corpus and report paths. */
export function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new TextSourceError(
      `--title "${title}" produced an empty slug; it needs some letters or digits.`,
      { code: 'BAD_TITLE' },
    );
  }
  return slug;
}

/**
 * Collapse the line wrapping pdftotext leaves mid-sentence, WITHOUT collapsing
 * blank lines. This is the one place the file source deliberately differs from
 * normalizeTranscriptText: paragraph boundaries are what chunkText packs on, so
 * losing them would turn the whole book into one unsplittable paragraph.
 */
export function normalizeFileText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n\s*/) // paragraph break: a blank line, plus any run of blanks after it
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function loadTextFile(path, { author, title, publishedAt = null } = {}) {
  if (!author) {
    throw new TextSourceError('--author is required with --file; it is the provenance on every claim.', { code: 'NO_AUTHOR' });
  }
  if (!title) {
    throw new TextSourceError('--title is required with --file; it is the provenance on every claim.', { code: 'NO_TITLE' });
  }

  const ext = extname(path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new TextSourceError(
      `--file must be .txt or .md, got "${ext || '(no extension)'}". Convert first: ` +
      `pdftotext -layout <in.pdf> <out.txt> (see digitalassets/README.md).`,
      { code: 'BAD_EXT' },
    );
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new TextSourceError(`No such file: ${path}`, { code: 'MISSING' });
  }
  if (stat.size > MAX_BYTES) {
    throw new TextSourceError(
      `${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 10 MB ceiling. ` +
      `A converted book is well under 1 MB — this looks like a PDF or binary passed by mistake.`,
      { code: 'TOO_LARGE' },
    );
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new TextSourceError(`Could not read ${path}: ${err.message}`, { code: 'UNREADABLE' });
  }

  const text = normalizeFileText(raw);
  if (!text) throw new TextSourceError(`${path} has no text content.`, { code: 'EMPTY' });

  return {
    sourceId: slugify(title),
    sourceType: 'file',
    videoId: null,
    title,
    creator: author,
    creatorUrl: null,
    durationSeconds: null,
    publishedAt,
    language: 'en',
    text,
  };
}
