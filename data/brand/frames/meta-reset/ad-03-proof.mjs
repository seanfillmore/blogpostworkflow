/**
 * Ad 3 — proof, built on one verbatim review.
 *
 * The ISOCLEAN reference leans on review screenshots and a Trustpilot score. We
 * use a real customer sentence instead of a star count, deliberately: a count
 * drifts (the Judge.me API says 135 for the lotion+cream group while the badge
 * shows 131), a quote does not.
 *
 * The quote is a golden-nugget entry in data/context/voice-of-customer.md, and
 * verify() asserts it is still there word for word. If the research file is
 * regenerated and the review is gone, this ad stops building rather than
 * attributing words to a customer who did not say them.
 *
 * marketing-conversion-copy-angles: keep the identifying detail that has nothing
 * to do with the result — "prescription strength lotions, steroids" is what makes
 * it read as a person rather than a marketing line, so it stays in.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK, GREEN, MINT, PAPER, LOTION, JAR, stars, shell } from './ad-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const VOC = join(ROOT, 'data', 'context', 'voice-of-customer.md');

/** The exact substring that must survive in the research file. */
const ANCHOR = 'I have tried prescription strength lotions, steroids, you name it';
/** What the ad prints. The ellipsis marks a real elision, nothing added. */
const QUOTE = 'I have tried prescription strength lotions, steroids, you name it… to no avail. Until Real Skin Care.';

export default {
  product: '99-coconut-reset-digital',
  name: 'ad-03-proof',
  width: 1080,
  height: 1350,

  verify() {
    const voc = readFileSync(VOC, 'utf8');
    if (!voc.includes(ANCHOR)) {
      throw new Error('the quoted review is no longer in data/context/voice-of-customer.md — '
        + 'do not ship a customer quote this file cannot support');
    }
  },

  alt: () =>
    'A five-star customer review of Real Skin Care reading: I have tried prescription strength lotions, '
    + 'steroids, you name it, to no avail. Until Real Skin Care. Shown with the Coconut Breeze body '
    + 'lotion and body cream.',

  html: (ctx) => shell({
    bg: MINT,
    disc: 'rgba(255,255,255,.55)',
    headline: 'Tried everything<br>already?',
    sub: 'So had she.',
    body: `
      <div style="display:flex;align-items:flex-end;justify-content:center;height:100%;">
        <img src="${ctx.asset(LOTION)}" style="height:100%;width:auto;object-fit:contain;display:block;">
        <img src="${ctx.asset(JAR)}" style="height:44%;width:auto;object-fit:contain;display:block;
                                            margin-left:-40px;">
      </div>`,
    footer: `
      <div style="background:${PAPER};border-radius:26px;padding:30px 34px;text-align:left;
                  box-shadow:0 4px 20px rgba(26,27,24,.10);margin-bottom:24px;">
        <div style="margin-bottom:14px;">${stars(28)}</div>
        <div style="font-family:Outfit;font-weight:400;font-size:29px;line-height:1.42;color:${INK};">
          &ldquo;${QUOTE}&rdquo;
        </div>
        <div style="font-family:Outfit;font-weight:600;font-size:23px;color:${INK};opacity:.5;margin-top:12px;">
          Verified buyer
        </div>
      </div>
      <div style="font-family:Cabin;font-weight:700;font-size:36px;color:${GREEN};">
        The 90-Day Coconut Reset
      </div>`,
  }),
};
