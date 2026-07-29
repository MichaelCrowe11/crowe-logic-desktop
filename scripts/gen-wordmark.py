#!/usr/bin/env python3
"""Outline "Crowe Logic" from Fraunces into scripts/wordmark-data.js.

Why the wordmark is baked to paths rather than set as SVG <text>: a <text>
element resolves the family on the viewer's machine, so assets/lockup.svg -
the logo - rendered in Georgia anywhere Fraunces was not installed. GitHub, npm,
print, and anyone opening the file standalone all got the fallback. Outlines
carry no such dependency and cannot drift.

Why a generator and a committed artefact rather than a build step: gen-mark.js
runs under plain node with no dependencies, and adding fontTools to that path
would put a Python toolchain between a contributor and `npm run icons`. This
script is run by hand when the wordmark changes; its output is reviewed like any
other source.

The tittle of the "i" is dropped here rather than covered in the lockup. The
spore that replaces it is smaller than the dot's optical weight at some sizes,
so an overlay left a dark crescent peeking out from behind the gold. Removing
the contour means the mark IS the dot at every size.

Requires: fontTools, brotli. Reads the full four-axis Fraunces, which carries
alternates and optical sizes the bundled subset does not need.

    python3 scripts/gen-wordmark.py
"""
import json
import pathlib
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONT = pathlib.Path.home() / "Library/Fonts/Fraunces[SOFT,WONK,opsz,wght].ttf"
TEXT = "Crowe Logic"
SIZE = 100.0
# opsz 144 is the display cut: the lockup is never set small, and the small-text
# cut the bundled subset is pinned to looks blunt above ~40px.
COORDS = {"wght": 600, "opsz": 144, "SOFT": 0, "WONK": 1}
OUT = pathlib.Path(__file__).with_name("wordmark-data.js")


def kern_pairs(font):
    """Pair kerning from the GPOS 'kern' feature: formats 1 (explicit) and 2 (class)."""
    if "GPOS" not in font:
        return {}, []
    gpos = font["GPOS"].table
    want = set()
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag == "kern":
            want.update(fr.Feature.LookupListIndex)
    explicit, classy = {}, []
    for i in sorted(want):
        for st in gpos.LookupList.Lookup[i].SubTable:
            if st.__class__.__name__ == "ExtensionPos":
                st = st.ExtSubTable
            if st.__class__.__name__ != "PairPos":
                continue
            if st.Format == 1:
                for gname, ps in zip(st.Coverage.glyphs, st.PairSet):
                    for rec in ps.PairValueRecord:
                        v = getattr(rec.Value1, "XAdvance", 0) or 0
                        if v:
                            explicit[(gname, rec.SecondGlyph)] = v
            elif st.Format == 2:
                classy.append((
                    set(st.Coverage.glyphs),
                    st.ClassDef1.classDefs,
                    st.ClassDef2.classDefs,
                    [[getattr(r.Value1, "XAdvance", 0) or 0 for r in row.Class2Record]
                     for row in st.Class1Record],
                ))
    return explicit, classy


def kern(explicit, classy, a, b):
    if (a, b) in explicit:
        return explicit[(a, b)]
    for cov, c1, c2, table in classy:
        if a in cov:
            i, j = c1.get(a, 0), c2.get(b, 0)
            if i < len(table) and j < len(table[i]):
                if table[i][j]:
                    return table[i][j]
    return 0


def contours(glyphset, name):
    """Split a glyph into contours so the tittle can be told from the stem."""
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


def main():
    if not FONT.exists():
        sys.exit(f"missing {FONT} - install the full Fraunces first")

    font = instancer.instantiateVariableFont(
        TTFont(FONT), COORDS, inplace=False, updateFontNames=False)
    upem = font["head"].unitsPerEm
    cmap, hmtx, gs = font.getBestCmap(), font["hmtx"], font.getGlyphSet()
    xheight = font["OS/2"].sxHeight
    explicit, classy = kern_pairs(font)
    scale = SIZE / upem

    # Two cuts of the same setting. `full` keeps the dot and is what the
    # mark-plus-words lockup uses - putting the spore there too would print two
    # spores side by side and break the rule that gold appears exactly once.
    # `dotless` is the logotype, where the mark IS the dot.
    # `noOs` drops the round letters too, so the mark can BE them rather than
    # sit on top of one - an overlay leaves the o's own ring showing through the
    # gaps between the hyphae and the letter reads as a smudge behind a star.
    full = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}")
    dotless = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}")
    noos = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}")
    x = 0.0
    tittle = None
    # Per-glyph ink boxes. The logotype needs to place artwork inside specific
    # letters - the mark sits in the bowl of an "o" - and the advance alone will
    # not do it: the advance includes sidebearings, so centring on it puts the
    # artwork off to one side of the round it is meant to fill. These are the
    # drawn extents, in the same SVG-down coordinates as `d`.
    glyphs = []
    for i, ch in enumerate(TEXT):
        if ch == " ":
            x += hmtx[cmap[32]][0] * scale
            continue
        name = cmap[ord(ch)]
        gb = [bounds(c) for c in contours(gs, name)]
        if gb:
            gx0 = min(b[0] for b in gb); gx1 = max(b[2] for b in gb)
            gy0 = min(b[1] for b in gb); gy1 = max(b[3] for b in gb)
            glyphs.append({
                "ch": ch,
                "i": i,
                "cx": round(x + (gx0 + gx1) / 2 * scale, 3),
                "cy": round(-(gy0 + gy1) / 2 * scale, 3),
                "w": round((gx1 - gx0) * scale, 3),
                "h": round((gy1 - gy0) * scale, 3),
            })
        # Font units run up, SVG runs down.
        xform = Transform(scale, 0, 0, -scale, x, 0)
        pf, pd = TransformPen(full, xform), TransformPen(dotless, xform)
        pn = TransformPen(noos, xform)
        if ch == "i":
            for c in contours(gs, name):
                x0, y0, x1, y1 = bounds(c)
                is_dot = y0 > xheight     # sits clear above the x-height
                if is_dot:
                    tittle = {
                        "cx": round(x + (x0 + x1) / 2 * scale, 3),
                        "cy": round(-(y0 + y1) / 2 * scale, 3),
                        "w": round((x1 - x0) * scale, 3),
                        "h": round((y1 - y0) * scale, 3),
                    }
                for op, args in c:
                    getattr(pf, op)(*args)
                    if not is_dot:
                        getattr(pd, op)(*args)
                        getattr(pn, op)(*args)
        else:
            gs[name].draw(pf)
            gs[name].draw(pd)
            if ch != "o":
                gs[name].draw(pn)
        x += hmtx[name][0] * scale
        if i + 1 < len(TEXT) and TEXT[i + 1] != " ":
            x += kern(explicit, classy, name, cmap[ord(TEXT[i + 1])]) * scale

    if tittle is None:
        sys.exit("no tittle contour found on 'i' - the glyph changed shape")

    data = {
        "text": TEXT,
        "size": SIZE,
        "coords": COORDS,
        "d": full.getCommands(),
        "dDotless": dotless.getCommands(),
        "dNoOs": noos.getCommands(),
        "width": round(x, 3),
        "ascent": round(font["hhea"].ascent * scale, 3),
        "descent": round(font["hhea"].descent * scale, 3),
        "capHeight": round(font["OS/2"].sCapHeight * scale, 3),
        "tittle": tittle,
        "glyphs": glyphs,
    }
    OUT.write_text(
        "// GENERATED by scripts/gen-wordmark.py - do not edit by hand.\n"
        f"// {TEXT!r} outlined from Fraunces at {COORDS}, em={SIZE:g}.\n"
        "// `d` keeps the i-dot (mark-plus-words lockup); `dDotless` drops it so the spore can take its place.\n"
        f"module.exports = {json.dumps(data, indent=2)};\n"
    )
    print(f"wrote {OUT.name}: width={data['width']} tittle={tittle}")


if __name__ == "__main__":
    main()
