#!/usr/bin/env bash
# Rebuild lotion-how-to-use.png with a correct step 2.
#
# The live frame draws a PUMP DISPENSER at step 2 and reads "Pump a small
# amount". This product has no pump — it is a squeeze bottle with a flip-top
# disc cap, which step 1 of the same frame draws correctly.
#
# This is a SURGICAL composite, not a regeneration: it starts from the archived
# original and replaces exactly two regions — the step-2 pictogram and the first
# caption line. The title, the other two steps, the numerals, "small amount" and
# the footnote are the original pixels, untouched.
#
# Caption font: Cabin 400, the brand heading face (data/brand/fonts/cabin-700 /
# cabin-400.woff2), converted to TTF. Rendered at pointsize 67 with kerning -2,
# which reproduces the original "Pump a" ink box of 201x63 to the pixel.
set -euo pipefail

SRC="data/archive/coconut-lotion/lotion-how-to-use.ORIGINAL.png"
ICON="data/creatives/lotion-howto/step2-icon-a3.png"
FONT="${CABIN_TTF:?set CABIN_TTF to the converted cabin-400.ttf}"
OUT="data/creatives/lotion-howto/lotion-how-to-use-v2.png"
TMP="$(mktemp -d)"

# Measured ink boxes in the 1400x1400 original:
#   step-2 pictogram   x 570-861  y 448-773   (291 x 325, centre 715,610)
#   "Pump a"           x 598-799  y 839-902   (201 x  63)
#   "small amount"     x 521-890  y 900-962   → column centre x = 705

# 1. new pictogram, trimmed to ink and scaled to the original's 325px height.
#    Downscaling from the 2048px render leaves the strokes lighter than the
#    neighbouring icons, so thicken first, at NATIVE resolution — thickening a
#    325px raster produces chunky, distorted corners, while thickening at 2048
#    and then downscaling stays smooth.
#    Note the operator: on dark-strokes-over-white, ERODE grows the strokes
#    (it erodes the white). Dilate does the opposite and THINS them, which is
#    the trap this comment exists to record. Disk:6 matches step 3's weight.
magick "$ICON" -bordercolor white -border 1 -fuzz 8% -trim +repage \
  -morphology Erode Disk:6 -resize x325 "$TMP/icon.png"
IW=$(magick identify -format "%w" "$TMP/icon.png")

# 2. erase the two regions, then composite.
#    The "2." numeral occupies x 516-574, y 442-501 and MUST survive: a single
#    rectangle from x=552 clipped its full stop, so the icon area is erased as
#    two rectangles that step around it.
magick "$SRC" \
  -fill white -draw "rectangle 576,425 884,792" \
  -fill white -draw "rectangle 552,505 576,792" \
  -fill white -draw "rectangle 585,828 812,907" \
  "$TMP/base.png"

magick "$TMP/base.png" "$TMP/icon.png" \
  -geometry "+$(( 715 - IW / 2 ))+448" -composite "$TMP/with-icon.png"

# 3. set the replacement caption line
magick -background none -fill black -font "$FONT" -pointsize 67 -kerning -2 \
  label:"Squeeze a" -trim +repage "$TMP/cap.png"
CW=$(magick identify -format "%w" "$TMP/cap.png")

magick "$TMP/with-icon.png" "$TMP/cap.png" \
  -geometry "+$(( 705 - CW / 2 ))+839" -composite "$OUT"

magick identify "$OUT"
echo "icon ${IW}x325   caption ${CW}px wide"
rm -rf "$TMP"
