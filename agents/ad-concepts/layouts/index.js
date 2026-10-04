import commentCard from './comment-card.js';
import headlineOverPhoto from './headline-over-photo.js';
import splitTwoPanel from './split-two-panel.js';
import checklistSplit from './checklist-split.js';
import photoOnly from './photo-only.js';
import labelledBundle from './labelled-bundle.js';

export const LAYOUT_REGISTRY = Object.freeze(Object.fromEntries(
  [commentCard, headlineOverPhoto, splitTwoPanel, checklistSplit, photoOnly, labelledBundle].map(l => [l.key, l])));

export function getLayout(key) {
  const l = LAYOUT_REGISTRY[key];
  if (!l) throw new Error(`unknown layout "${key}"`);
  return l;
}
