/**
 * 90-Day Coconut Reset — frame 7 (educational infographic).
 *
 * Media plan §6: "Defuse the comedogenic objection without a claim." The buyer
 * believes coconut oil clogs pores. The plan is explicit about why this frame
 * works: it "does not claim non-comedogenic, does not argue with the belief, and
 * does not need to — it relocates the product. Body silhouette with the
 * application zones marked, face excluded, one line of type."
 *
 * So there is no counter-argument here and no safety claim. The diagram only says
 * where the product goes, and the zone labels are the lander's own How to Use
 * wording: "Lotion in the morning and after showers. Cream at night on hands,
 * elbows, heels and anywhere that cracks."
 *
 * The head is deliberately unmarked rather than crossed out. A ✗ over a face
 * argues the belief and implies harm — the opposite of this frame's job. The
 * absence of a marker is the point.
 *
 * ── The figure ──────────────────────────────────────────────────────────────
 * Generated, not drawn. It depicts no product, so media plan §3 permits it and
 * there is nothing to ground it in. Three hand-drawn attempts failed the same way:
 * SVG limbs from bézier outlines, then from round-capped strokes — both left the
 * arms merged into the torso with the "Hands" marker landing on what read as a
 * hip. A generated silhouette has real anatomy; the trade is that it cannot be
 * annotated from memory, which is what the measured anchors below solve.
 */

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';

const HEADLINE = 'Made for your body,<br>not your face.';
const SUBLINE = 'A body care range — hands, elbows, heels and everywhere in between.';

/**
 * Zone anchors as fractions of the silhouette's bounding box, so they hold at any
 * display size. Not eyeballed — read off the keyed mask by scanning it row by row:
 * at 37% of figure height the mask resolves into three separate runs (left arm,
 * torso, right arm), which is where the elbows are; at 72% into two runs, the legs;
 * at 97% into two feet. Each x is the centre of the relevant run at that row.
 */
const ZONES = [
  { fx: 0.167, fy: 0.197, side: 'left', label: 'Shoulders' },
  { fx: 0.094, fy: 0.370, side: 'left', label: 'Elbows' },
  { fx: 0.042, fy: 0.530, side: 'left', label: 'Hands' },
  { fx: 0.649, fy: 0.291, side: 'right', label: 'Chest &amp; back' },
  { fx: 0.705, fy: 0.720, side: 'right', label: 'Legs' },
  { fx: 0.832, fy: 0.967, side: 'right', label: 'Heels' },
];

const FIG_W = 452;
const FIG_H = Math.round(FIG_W * (2222 / 685));   // the keyed PNG is 685×2222
const LEAD = 150;                                  // leader-line reach beyond the figure

export default {
  product: '99-coconut-reset-digital',
  name: 'frame-07-body-not-face',
  width: 2048,
  height: 2048,
  reads: [],

  /**
   * There is no number on this frame, so nothing binds to a metafield. What it must
   * never become is a defence of the product, and the only way that happens is a
   * well-meaning copy edit — so the copy is asserted here.
   */
  verify() {
    const text = [HEADLINE, SUBLINE, ...ZONES.map((z) => z.label)].join(' ').toLowerCase();
    const banned = ['comedogenic', 'clog', 'pore', 'safe', 'hypoallergenic', 'acne', 'dermatit', 'non-irritating'];
    const hit = banned.find((w) => text.includes(w));
    if (hit) {
      throw new Error(`frame 7 must relocate the product, not defend it — copy contains "${hit}". `
        + `Media plan §6: it "does not claim non-comedogenic, does not argue with the belief".`);
    }
  },

  alt() {
    return 'A diagram of where the 90-Day Coconut Reset is used: shoulders, chest and back, '
      + 'elbows, hands, legs and heels are marked on a body silhouette. The face is not marked. '
      + 'Made for your body, not your face.';
  },

  html(ctx) {
    const figure = ctx.asset('data/brand/diagrams/body-silhouette.png');

    const marker = (z) => {
      const x = z.fx * FIG_W;
      const y = z.fy * FIG_H;
      const end = z.side === 'left' ? -LEAD : FIG_W + LEAD;
      const lineLeft = Math.min(x, end);
      const lineWidth = Math.abs(end - x);
      const labelSide = z.side === 'left'
        ? `right:${FIG_W + LEAD + 20}px;text-align:right;`
        : `left:${FIG_W + LEAD + 20}px;text-align:left;`;
      return `
        <div style="position:absolute;left:${lineLeft}px;top:${y - 1}px;width:${lineWidth}px;height:2px;
                    background:${BLACK};opacity:.3;"></div>
        <div style="position:absolute;left:${x - 13}px;top:${y - 13}px;width:26px;height:26px;
                    border-radius:50%;background:${GREEN};border:3px solid ${BLACK};box-sizing:border-box;"></div>
        <div style="position:absolute;top:${y - 26}px;${labelSide}
                    font-family:Outfit;font-weight:600;font-size:40px;letter-spacing:.03em;
                    color:${BLACK};opacity:.8;white-space:nowrap;">${z.label}</div>`;
    };

    return `<div style="
      width:100%;height:100%;background:${SAND};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:80px 96px;text-align:center;">

      <div style="font-family:Outfit;font-weight:300;font-size:36px;letter-spacing:.34em;
                  text-transform:uppercase;color:${BLACK};opacity:.45;margin-bottom:26px;">
        Where it goes
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:116px;line-height:1.04;
                  color:${BLACK};letter-spacing:-.022em;">
        ${HEADLINE}
      </div>

      <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:30px 0 24px;"></div>

      <div style="position:relative;width:${FIG_W}px;height:${FIG_H}px;">
        <img src="${figure}" style="width:${FIG_W}px;height:${FIG_H}px;display:block;">
        ${ZONES.map(marker).join('')}
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:44px;color:${BLACK};opacity:.62;margin-top:28px;">
        ${SUBLINE}
      </div>
    </div>`;
  },
};
