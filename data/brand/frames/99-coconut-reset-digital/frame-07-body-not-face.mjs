/**
 * 90-Day Coconut Reset — frame 7 (educational infographic).
 *
 * Media plan §6: "Defuse the comedogenic objection without a claim." The buyer
 * believes coconut oil clogs pores. The plan is explicit about why this frame
 * works: it "does not claim non-comedogenic, does not argue with the belief, and
 * does not need to — it relocates the product. Body silhouette with the
 * application zones marked, face excluded, one line of type."
 *
 * So there is no counter-argument on this frame, and no safety claim. The diagram
 * only says where the product goes, and the zones are taken from the lander's own
 * How to Use tab: "Lotion in the morning and after showers. Cream at night on
 * hands, elbows, heels and anywhere that cracks."
 *
 * The head is deliberately drawn *unmarked* rather than crossed out. A ✗ over a
 * face would argue the belief and imply harm — the opposite of the frame's job.
 * Absence of a marker is the whole point: the face simply is not one of the places
 * this goes.
 *
 * The silhouette is drawn as SVG rather than generated. Media plan §3 permits
 * generating a diagram like this, but a generated figure cannot be annotated
 * precisely — the zone dots have to land on the actual elbow and heel, and that
 * needs coordinates, not a render.
 */

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';
const HEADLINE = 'Made for your body,<br>not your face.';
const SUBLINE = 'A body care range — hands, elbows, heels and everywhere in between.';

const FIGURE = '#D8CEBD';   // a shade of the sand, so the body reads as a diagram
const HEAD = '#E6DED1';     // lighter still: present, but not a place the product goes

/**
 * Joints, in viewBox coordinates. Limbs are drawn as round-capped strokes between
 * these points, so a zone marker can sit exactly on a joint instead of being
 * eyeballed onto a freehand outline. The first attempt drew the body as bézier
 * blobs and the arms merged into the torso — the "Hands" dot landed on what read
 * as a hip.
 */
const J = {
  headC: [200, 74], headR: 48,
  neck: [[200, 114], [200, 168]],
  torso: [[200, 206], [200, 448]], torsoW: 104,
  // Shoulders sit ON the torso edge and the arms angle outward, so by the elbow the
  // limb is clear of the body. The first pass tucked them inside the torso capsule
  // and the "Hands" marker landed on what read as a hip.
  shoulderL: [152, 214], shoulderR: [248, 214],
  elbowL: [104, 392], elbowR: [296, 392],
  wristL: [86, 556], wristR: [314, 556],
  handL: [80, 606], handR: [320, 606],
  hipL: [170, 452], hipR: [230, 452],
  kneeL: [164, 700], kneeR: [236, 700],
  ankleL: [160, 900], ankleR: [240, 900],
  toeL: [140, 938], toeR: [260, 938],
};

/** Zone markers. Labels come from the lander's How to Use tab. */
const ZONES = [
  { at: J.shoulderL, side: 'left', label: 'Shoulders' },
  { at: J.elbowL, side: 'left', label: 'Elbows' },
  { at: J.handL, side: 'left', label: 'Hands' },
  { at: [244, 300], side: 'right', label: 'Chest &amp; back' },
  { at: J.kneeR, side: 'right', label: 'Legs' },
  { at: [246, 908], side: 'right', label: 'Heels' },
];

const FIG_W = 560;
const FIG_H = 1456;
const VB_W = 400;
const VB_H = 1040;

function silhouette() {
  /** A round-capped stroke is a capsule — cleaner and far easier to place than a bézier outline. */
  const limb = ([x1, y1], [x2, y2], w) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${FIGURE}" stroke-width="${w}" stroke-linecap="round"/>`;

  const marker = (z) => {
    const [x, y] = z.at;
    const toX = z.side === 'left' ? 26 : VB_W - 26;
    return `<line x1="${x}" y1="${y}" x2="${toX}" y2="${y}" stroke="${BLACK}" stroke-opacity=".3" stroke-width="2.2"/>
            <circle cx="${x}" cy="${y}" r="12" fill="${GREEN}" stroke="${BLACK}" stroke-width="3"/>`;
  };

  return `
  <svg viewBox="0 0 ${VB_W} ${VB_H}" width="${FIG_W}" height="${FIG_H}" aria-hidden="true">
    ${limb(J.neck[0], J.neck[1], 40)}
    ${limb(J.torso[0], J.torso[1], J.torsoW)}
    ${limb(J.shoulderL, J.elbowL, 44)}
    ${limb(J.shoulderR, J.elbowR, 44)}
    ${limb(J.elbowL, J.wristL, 38)}
    ${limb(J.elbowR, J.wristR, 38)}
    ${limb(J.wristL, J.handL, 40)}
    ${limb(J.wristR, J.handR, 40)}
    ${limb(J.hipL, J.kneeL, 56)}
    ${limb(J.hipR, J.kneeR, 56)}
    ${limb(J.kneeL, J.ankleL, 46)}
    ${limb(J.kneeR, J.ankleR, 46)}
    ${limb(J.ankleL, J.toeL, 34)}
    ${limb(J.ankleR, J.toeR, 34)}
    <!-- head last and in a lighter tone: present, and pointedly not a marked zone -->
    <circle cx="${J.headC[0]}" cy="${J.headC[1]}" r="${J.headR}" fill="${HEAD}"/>
    ${ZONES.map(marker).join('')}
  </svg>`;
}

export default {
  product: '99-coconut-reset-digital',
  name: 'frame-07-body-not-face',
  width: 2048,
  height: 2048,
  reads: [],

  /**
   * This frame makes no numeric claim, so there is nothing to bind to a metafield.
   * What it must not do is drift into a safety or efficacy claim, and the only way
   * that happens is if someone edits the copy — so the copy is asserted here.
   * Anything resembling "non-comedogenic", "won't clog", "safe for" or "hypoallergenic"
   * fails the build.
   */
  verify() {
    const text = [HEADLINE, SUBLINE, ...ZONES.map((z) => z.label)].join(' ').toLowerCase();
    const banned = ['comedogenic', 'clog', 'pore', 'safe', 'hypoallergenic', 'won\'t break', 'acne', 'dermatit'];
    const hit = banned.find((w) => text.includes(w));
    if (hit) {
      throw new Error(`frame 7 must relocate the product, not defend it — copy contains "${hit}". `
        + `Media plan §6: it "does not claim non-comedogenic, does not argue with the belief".`);
    }
  },

  alt() {
    return 'A diagram of where the 90-Day Coconut Reset is used: shoulders, chest and back, '
      + 'elbows, hands, legs and heels are marked on a body outline. The face is not marked. '
      + 'Made for your body, not your face.';
  },

  html() {
    return `<div style="
      width:100%;height:100%;background:${SAND};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:88px 96px;text-align:center;">

      <div style="font-family:Outfit;font-weight:300;font-size:36px;letter-spacing:.34em;
                  text-transform:uppercase;color:${BLACK};opacity:.45;margin-bottom:30px;">
        Where it goes
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:120px;line-height:1.04;
                  color:${BLACK};letter-spacing:-.022em;">
        ${HEADLINE}
      </div>

      <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:34px 0 18px;"></div>

      <div style="position:relative;display:flex;align-items:center;justify-content:center;">
        ${silhouette()}
        ${ZONES.map((z) => `
          <div style="position:absolute;${z.side === 'left' ? 'right:calc(50% + 232px)' : 'left:calc(50% + 232px)'};
                      top:${(z.at[1] / VB_H) * FIG_H - 28}px;
                      font-family:Outfit;font-weight:600;font-size:40px;letter-spacing:.03em;
                      color:${BLACK};opacity:.78;white-space:nowrap;
                      text-align:${z.side === 'left' ? 'right' : 'left'};">${z.label}</div>`).join('')}
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:46px;color:${BLACK};opacity:.62;margin-top:22px;">
        ${SUBLINE}
      </div>
    </div>`;
  },
};
