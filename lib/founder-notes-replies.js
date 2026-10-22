/**
 * Founder notes: recognise Sean's reply to the weekly question email and split
 * it into numbered answers. Pure (the hushmail import has no side effects).
 */
import { isAgentMessageId } from './hushmail.js';

/** True when `message` is a human reply to the question email for `week`. */
export function isReplyTo(message, { messageId, week }) {
  if (!message || isAgentMessageId(message.messageId)) return false;
  if (messageId && message.inReplyTo === messageId) return true;
  if (messageId && (message.references || []).includes(messageId)) return true;
  return String(message.subject || '').includes(`[FN-${week}]`);
}

const MARKER = /^\s*(?:#\s*(\d+)\b[.):\-]?|(\d+)[.)])(?:\s+|$)/;

/**
 * Split already-quote-stripped reply text into [{ index, answer }].
 * index is null for general text. Markers outside 1..questionCount stay in the
 * previous block. Blank answers are dropped.
 */
export function parseAnswers(text, questionCount) {
  const blocks = [{ index: null, lines: [] }];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(MARKER);
    const n = m ? Number(m[1] ?? m[2]) : NaN;
    if (m && n >= 1 && n <= questionCount) {
      blocks.push({ index: n, lines: [line.slice(m[0].length)] });
    } else {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  return blocks
    .map((b) => ({ index: b.index, answer: b.lines.join('\n').trim() }))
    .filter((b) => b.answer);
}

const QUOTE = /^\s*>/;
const QUOTED_MARKER = /^(?:\s*>)+\s*(?:#\s*(\d+)\b[.):\-]?|(\d+)[.)])(?:\s+|$)/;

function quotedMarker(line, questionCount) {
  const m = line.match(QUOTED_MARKER);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return n >= 1 && n <= questionCount ? n : null;
}

/** True when the body quotes at least one of our numbered questions ("> 1. ..."). */
export function hasInlineMarkers(fullText, questionCount) {
  return String(fullText || '').split(/\r?\n/).some((l) => quotedMarker(l, questionCount) != null);
}

/**
 * Parse an inline (interleaved) reply: the client quotes our email with "> ",
 * and Sean types each answer under the quoted question, often without retyping
 * the number. A quoted "> N." line opens question N; the unquoted lines after it,
 * until the next quoted marker, are its answer. Unquoted text before any quoted
 * marker (a top-post) goes through parseAnswers. Attribution lines
 * ("On ... wrote:") are dropped; blank answers are dropped.
 */
export function parseInlineReply(fullText, questionCount) {
  const lines = String(fullText || '').split(/\r?\n/);
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (QUOTE.test(lines[i]) || !/^On\s/.test(l)) continue;
    for (let j = i; j <= i + 2 && j < lines.length; j++) {
      if (QUOTE.test(lines[j])) break;
      if (/wrote:\s*$/.test(lines[j].trim())) { for (let k = i; k <= j; k++) drop.add(k); break; }
    }
  }
  const top = [];
  const blocks = [];
  let current = null;
  lines.forEach((line, i) => {
    if (drop.has(i)) return;
    const n = quotedMarker(line, questionCount);
    if (n != null) { current = { index: n, lines: [] }; blocks.push(current); return; }
    if (QUOTE.test(line)) return;
    (current ? current.lines : top).push(line);
  });
  return [
    ...parseAnswers(top.join('\n'), questionCount),
    ...blocks.map((b) => ({ index: b.index, answer: b.lines.join('\n').trim() })).filter((b) => b.answer),
  ];
}
