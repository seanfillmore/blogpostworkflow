# Packaging assets

## `mailer-10x8x4-open.png` / `mailer-10x8x4-closed.png`

The Real Skin Care 10×8×4in mailer, cut from the supplier's 3D visualization
(`mailer-10x8x4-3d-source.pdf`, myPackaging.lane) with
`scripts/cut-component.mjs`. Nothing is redrawn — the flood fill lifts the two
boxes off the flat 216-grey backdrop and keeps every printed element as supplied.

Extraction, for reproducibility:

```
pdftoppm -r 400 -png "Mailer 10x8x4 in 3d.pdf" mailer     # 17846×14028
magick mailer-1.png -resize 5000x mailer-5k.png
node scripts/cut-component.mjs mailer-5k.png open.png   --seed 1650,1450 --fuzz 3 --band 449,3481  --bottom 3481
node scripts/cut-component.mjs mailer-5k.png closed.png --seed 3100,2150 --fuzz 3 --band 1970,3465 --bottom 3465
```

The backdrop is 216,216,216 and the box's interior pattern shapes are 217 — one
step apart. No colour threshold separates them; the flood fill works because it
is topological, and the pattern is enclosed by the box and therefore unreachable
from a corner. That is the same reason it is the right tool for the white-on-white
product cutouts.

## ⚠️ What these are, and what they are not

**These are renderings, not photographs.** They are the supplier's 3D
visualization of the production artwork, so they depict the box design exactly —
the printing, the seals, the interior pattern, the proportions.

They are **not** evidence that a physical box arrives undamaged, which is the
objection our own review corpus actually raises ("wrapped in a thin tissue paper
which was torn in a few places… so it may not work out well as a gift", 5
mentions). A rendering cannot answer that; only a photograph of a real delivered
box can.

**Basis for using them:** Sean, 2026-08-02, on this file — *"That is what the gift
box looks like."* If the mailer is ever redesigned or is not the box actually
shipping, the frames built on it (`data/brand/frames/gift-box/frame-06`, `-07`)
must come down with it.

**Do not composite products into the open box.** The interior is shown empty and
at a fixed perspective; dropping cut-out bottles into it would manufacture a
photograph of an arrangement nobody has ever assembled. The media plan's spec #1
("all four products nested inside") still needs the real shoot.
