#!/usr/bin/env python3
"""Cut the app icon out of the logotype's own typeface.

The icon used to be the hyphal mark on a dark tile. On a home screen beside
thirty other rounded squares that reads as a generic burst; what people
recognise as Crowe Logic is the lettering - the high-contrast Fraunces "C" the
wordmark opens with. So the icon is that letter, set from the same font at the
same axis coordinates gen-wordmark.py uses, with the spore in its aperture so
gold still appears exactly once.

Outlined rather than set as <text>, for the reason gen-wordmark.py gives: an
SVG <text> resolves the family on the viewer's machine and falls back to
Georgia everywhere Fraunces is not installed. Outlines cannot drift.

The spore is lifted out of assets/wordmark.svg rather than redrawn, so the
gold here and the gold over the "i" are the same artwork by construction.

Requires: fontTools. Run by hand when the letter or the type changes; the SVGs
it writes are committed and reviewed like any other source.

    python3 scripts/gen-wordmark-icon.py
"""
import pathlib
import re
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONT = pathlib.Path.home() / "Library/Fonts/Fraunces[SOFT,WONK,opsz,wght].ttf"

LETTER = "C"
# Identical to gen-wordmark.py: the icon is a detail of the logotype, not a
# second interpretation of it.
COORDS = {"wght": 600, "opsz": 144, "SOFT": 0, "WONK": 1}

SIZE = 1024
CREAM = "#f7f3ea"
INK = "#16130f"

# Where the spore sits, in units of the letter's cap height, measured from the
# letter's centre. The C's aperture is the gap on its right flank; the spore
# rides in it rather than on the stroke, which would print gold on cream.
SPORE_X = 0.36
SPORE_Y = 0.00
SPORE_SIZE = 0.57

# How much of the tile the letter and spore together cover, on their long axis.
#
# iOS masks the tile to a rounded rect and nothing else, so the artwork can run
# close to the edge. Android masks the adaptive icon to whatever shape the
# launcher picks - circle, squircle, teardrop - and only the middle 66 of 108dp
# survives all of them. A composition sized for iOS loses its spore to a circle
# mask, so the two get their own coverage.
COVER_TILE = 0.72
COVER_ADAPTIVE = 0.52


def contours(glyphset, name):
    rec = RecordingPen()
    glyphset[name].draw(rec)
    out, cur = [], []
    for op, args in rec.value:
        if op == "moveTo" and cur:
            out.append(cur)
            cur = []
        cur.append((op, args))
    if cur:
        out.append(cur)
    return out


def bounds(contour):
    xs, ys = [], []
    for _, args in contour:
        for pt in args:
            if isinstance(pt, tuple):
                xs.append(pt[0])
                ys.append(pt[1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else (0, 0, 0, 0)


def spore(prefix, source):
    """The gold spore from the wordmark, with its gradient ids renamed.

    Two copies of this markup in one document would collide on `wm-hy`, and
    the second would silently take the first's gradient. The prefix makes each
    embedding self-contained.

    `source` picks which cut: the light wordmark runs the hyphae out to #241F19
    and the dark one out to cream. On an ink tile the first fades its own arms
    into the background and the spore reads as a bare dot, so the tile takes
    the dark cut - the same choice the dark lockup already makes.
    """
    svg = (ASSETS / source).read_text()
    groups = re.findall(r'<g transform="[^"]*">(.*?)</g>', svg, re.S)
    if not groups:
        sys.exit(f"no <g> in {source} - the wordmark changed shape")
    body = groups[-1]                      # the tittle spore is the last group
    if "radialGradient" not in body:
        sys.exit(f"last group in {source} carries no gradient - wrong group")
    for old in set(re.findall(r'id="(w[md]-[\w-]+)"', body)):
        body = body.replace(f'id="{old}"', f'id="{prefix}-{old}"')
        body = body.replace(f"url(#{old})", f"url(#{prefix}-{old})")
    return body.strip()


def letter_path():
    """The letter as an SVG path, plus its drawn extents in SVG coordinates."""
    if not FONT.exists():
        sys.exit(f"missing {FONT} - install the full Fraunces first")
    font = instancer.instantiateVariableFont(
        TTFont(FONT), COORDS, inplace=False, updateFontNames=False)
    upem = font["head"].unitsPerEm
    name = font.getBestCmap()[ord(LETTER)]
    gs = font.getGlyphSet()

    boxes = [bounds(c) for c in contours(gs, name)]
    x0 = min(b[0] for b in boxes); x1 = max(b[2] for b in boxes)
    y0 = min(b[1] for b in boxes); y1 = max(b[3] for b in boxes)

    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}")
    # Font units run up, SVG runs down.
    gs[name].draw(TransformPen(pen, Transform(1, 0, 0, -1, 0, 0)))
    return pen.getCommands(), {
        "x": x0, "y": -y1, "w": x1 - x0, "h": y1 - y0, "upem": upem,
    }


def compose(d, box, background, cover, source):
    """The letter and its spore, fitted to `cover` of a SIZE tile.

    Drawn in a local space where the cap height is 100 and then dropped into a
    nested <svg>, so the fit is the renderer's arithmetic rather than mine: the
    default preserveAspectRatio scales the pair to touch the placement box on
    their long axis and centres them on the other. Changing SPORE_X therefore
    cannot push the artwork off the tile - it re-centres.
    """
    s = 100.0 / box["h"]
    lw = box["w"] * s
    lx, ly = -box["x"] * s, -box["y"] * s        # letter box starts at (0, 0)

    sp = SPORE_SIZE * 100.0
    scx = lw / 2 + SPORE_X * 100.0
    scy = 50.0 + SPORE_Y * 100.0
    sx, sy = scx - sp / 2, scy - sp / 2

    bx0, by0 = min(0.0, sx), min(0.0, sy)
    bx1, by1 = max(lw, sx + sp), max(100.0, sy + sp)

    side = SIZE * cover
    off = (SIZE - side) / 2
    tile = f'  <rect width="{SIZE}" height="{SIZE}" fill="{background}"/>\n' if background else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
{tile}  <svg x="{off:.2f}" y="{off:.2f}" width="{side:.2f}" height="{side:.2f}" viewBox="{bx0:.2f} {by0:.2f} {bx1 - bx0:.2f} {by1 - by0:.2f}">
    <path transform="translate({lx:.4f} {ly:.4f}) scale({s:.6f})" fill="{CREAM}" d="{d}"/>
    <svg x="{sx:.2f}" y="{sy:.2f}" width="{sp:.2f}" height="{sp:.2f}" viewBox="0 0 120 120">
{spore("ic", source)}
    </svg>
  </svg>
</svg>
"""


def main():
    d, box = letter_path()
    written = []
    # The foreground rides on the ink background layer gen-mobile-assets.js
    # writes, so both cuts are cream-on-ink and wear the dark spore.
    for name, background, cover in [
        ("icon-letter.svg", INK, COVER_TILE),
        ("icon-letter-foreground.svg", "", COVER_ADAPTIVE),
    ]:
        (ASSETS / name).write_text(compose(d, box, background, cover, "wordmark-dark.svg"))
        written.append(name)
    print(f"assets/: {' '.join(written)}")
    print("\nNext: cd mobile && node scripts/gen-mobile-assets.js")


main()
