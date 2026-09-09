#!/usr/bin/env bash
# Fix two how-to footnotes that make claims we cannot stand behind.
#
# BAR SOAP — cut the footnote entirely.
#   "A coconut bar on a dry surface outlasts tallow bars at twice the price."
#   is an unsubstantiated comparative claim on two axes at once: performance
#   ("outlasts") and price ("at twice the price"), against a competitor class we
#   have measured nothing about. The frame's title and three steps already carry
#   the "make it last" message, so the line is cut rather than reworded — no
#   replacement copy is invented here.
#
# BODY CREAM — delete one word.
#   "Thicker than a pump lotion" implies a comparison to our own lotion, which is
#   a squeeze bottle with a flip-top cap. Removing "pump" leaves "Thicker than a
#   lotion", which is accurate and still does the texture job.
#
# TECHNIQUE — the body-cream line is rebuilt from its OWN PIXELS, not re-typeset.
# The footnote face is not Cabin and not Outfit (both measured ~14% and ~3% off
# the original's width at matched height), and the replacement line sits directly
# above an UNCHANGED second line, where a font mismatch would be more obvious
# than the defect being fixed. So the line is cut into two surviving segments,
# the word is dropped, and the pieces are re-centred with one original-width
# space between them. Zero font matching, perfect fidelity.
#
# Word boundaries came from a column profile of the line: the eight inter-word
# gaps (>=15px) line up exactly with the nine words.
#   "Thicker than a" ends x513 | space | "lotion. It firms in cold" starts x705
# Line 1 ink is y1196-1250 and line 2 begins at y1251, so the working band stops
# at y1250. Nothing retained has a descender, so nothing is clipped.
set -euo pipefail

BAR_SRC="data/archive/coconut-soap/bar-soap-how-to-use.ORIGINAL.png"
CRM_SRC="data/archive/coconut-moisturizer/body-cream-how-to-use.ORIGINAL.png"
OUT="data/creatives/howto-footnotes"
mkdir -p "$OUT"
TMP="$(mktemp -d)"

# ── bar soap: erase the footnote ────────────────────────────────────────────
# footnote ink measured at x168-1238, y1191-1298; erase generously around it.
magick "$BAR_SRC" -fill white -draw "rectangle 150,1180 1260,1310" \
  "$OUT/bar-soap-how-to-use-v2.png"

# ── body cream: excise "pump " and re-centre the line ───────────────────────
LEFT_X=139;  LEFT_W=375     # "Thicker than a"        x139..513
RIGHT_X=705; RIGHT_W=555    # "lotion. It firms in cold" x705..1259
SPACE=21                    # matches the original inter-word gaps (20,21,20)
BAND_Y=1190; BAND_H=61      # y1190..1250, stops short of line 2 at y1251

magick "$CRM_SRC" -crop ${LEFT_W}x${BAND_H}+${LEFT_X}+${BAND_Y}  +repage "$TMP/l.png"
magick "$CRM_SRC" -crop ${RIGHT_W}x${BAND_H}+${RIGHT_X}+${BAND_Y} +repage "$TMP/r.png"

NEW_W=$(( LEFT_W + SPACE + RIGHT_W ))
NEW_X=$(( 700 - NEW_W / 2 ))          # 700 is the frame centre, where line 2 sits

magick "$CRM_SRC" -fill white -draw "rectangle 120,${BAND_Y} 1280,1250" "$TMP/base.png"
magick "$TMP/base.png" \
  "$TMP/l.png" -geometry "+${NEW_X}+${BAND_Y}" -composite \
  "$TMP/r.png" -geometry "+$(( NEW_X + LEFT_W + SPACE ))+${BAND_Y}" -composite \
  "$TMP/joined.png"

# The two segments carry a few stray pixels along the band's bottom edge, left
# over from the deleted "p" descender and from anti-aliasing at the cut. Every
# glyph that survives is descender-free, so the baseline is the lowest ink there
# can legitimately be — anything below it is debris and is cleared. The band runs to y1258: the deleted "p" descenders reach y1253, and line 2 does not begin until y1263.
magick "$TMP/joined.png" -fill white -draw "rectangle 120,1241 1280,1258" \
  "$OUT/body-cream-how-to-use-v2.png"

magick identify "$OUT"/*.png
echo "body-cream line 1: ${NEW_W}px wide, starting x${NEW_X}"
rm -rf "$TMP"
