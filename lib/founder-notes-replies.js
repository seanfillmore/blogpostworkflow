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
