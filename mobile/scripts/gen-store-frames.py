#!/usr/bin/env python3
"""Rasterises the framed App Store panels. Driven by gen-store-frames.js.

Reads a JSON spec on stdin: {raw, out, panels:[{file, head, sub}]}.

The brand faces ship as variable woff2, which Pillow cannot open directly, so
they are converted to TTF in a temp dir and the weight axis is set explicitly.
Falling back to a default instance silently would ship a headline at the wrong
weight and look like a rendering bug rather than a missing step, so a failure
to set the axis is reported.
"""
import io
import json
import os
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from fontTools.ttLib import TTFont

W, H = 1320, 2868
PAPER = (247, 243, 234)
INK = (26, 23, 20)
DIM = (107, 100, 87)
GOLD = (184, 137, 58)

MARGIN = 96
SHOT_W = 1040
SHOT_TOP = 700
CORNER = 147

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.normpath(os.path.join(HERE, "..", "..", "assets", "fonts"))


def load_face(woff2_name, ttf_name, weight, size, tmpdir):
    src = os.path.join(FONTS, woff2_name)
    dst = os.path.join(tmpdir, ttf_name)
    if not os.path.exists(dst):
        f = TTFont(src)
        f.flavor = None
        f.save(dst)
    font = ImageFont.truetype(dst, size)
    try:
        font.set_variation_by_axes([weight])
    except Exception as exc:  # noqa: BLE001 - reported, not swallowed
        print(f"  warning: could not set weight {weight} on {ttf_name}: {exc}", file=sys.stderr)
    return font


def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return mask


def build(panel, raw_dir, out_dir, tmpdir):
    canvas = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(canvas)

    head_font = load_face("fraunces-var.woff2", "Fraunces.ttf", 600, 92, tmpdir)
    sub_font = load_face("inter-var.woff2", "Inter.ttf", 400, 36, tmpdir)

    # A short gold rule, the one piece of accent on the panel.
    draw.rectangle([MARGIN, 196, MARGIN + 76, 200], fill=GOLD)

    y = 252
    for line in panel["head"].split("\n"):
        draw.text((MARGIN, y), line, font=head_font, fill=INK)
        y += 104

    y += 24
    for line in wrap(draw, panel["sub"], sub_font, W - MARGIN * 2):
        draw.text((MARGIN, y), line, font=sub_font, fill=DIM)
        y += 52

    shot = Image.open(os.path.join(raw_dir, panel["file"])).convert("RGB")
    sh = round(SHOT_W * shot.height / shot.width)
    shot = shot.resize((SHOT_W, sh), Image.LANCZOS)
    mask = rounded_mask((SHOT_W, sh), CORNER)
    x = (W - SHOT_W) // 2

    # Tinted shadow, never pure black: a black shadow under a warm paper reads
    # as a hole rather than as lift.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [x, SHOT_TOP + 26, x + SHOT_W, SHOT_TOP + sh], CORNER, fill=(26, 23, 20, 74)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(38))
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB"), (0, 0))

    canvas.paste(shot, (x, SHOT_TOP), mask)

    dst = os.path.join(out_dir, panel["file"])
    canvas.save(dst)
    return dst


def main():
    spec = json.load(sys.stdin)
    with tempfile.TemporaryDirectory() as tmpdir:
        for panel in spec["panels"]:
            dst = build(panel, spec["raw"], spec["out"], tmpdir)
            im = Image.open(dst)
            assert im.size == (W, H), f"{dst} came out {im.size}, not {(W, H)}"
            print(f"  {os.path.basename(dst)}  {im.size[0]}x{im.size[1]}")
    print(f"wrote {len(spec['panels'])} framed panels")


if __name__ == "__main__":
    main()
