#!/usr/bin/env python3
"""Rasterises the framed store panels. Driven by gen-store-frames.js.

Reads a JSON spec on stdin: {raw, targets:[{out, ...geometry}], panels:[...]}.

Two targets, because the stores do not accept the same picture. App Store
Connect takes the device capture itself at 1320x2868, so the framed iOS panel
keeps that size. Play caps a phone screenshot at 2:1 and the raw capture is
2.17:1, so it would be refused as-is; the Play panel is a shorter canvas with
the same capture inset, which is a reframing rather than a crop.

The brand faces ship as variable woff2, which Pillow cannot open, so they are
converted to TTF in a temp dir and the weight axis is set explicitly. Falling
back to a default instance silently would ship a headline at the wrong weight
and read as a rendering bug rather than a missing step, so a failure to set the
axis is reported.
"""
import json
import os
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from fontTools.ttLib import TTFont

PAPER = (247, 243, 234)
INK = (26, 23, 20)
DIM = (107, 100, 87)
GOLD = (184, 137, 58)

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


def build(panel, raw_dir, t, tmpdir):
    W, H = t["w"], t["h"]
    margin = t["margin"]
    canvas = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(canvas)

    head_font = load_face("fraunces-var.woff2", "Fraunces.ttf", 600, t["head_size"], tmpdir)
    sub_font = load_face("inter-var.woff2", "Inter.ttf", 400, t["sub_size"], tmpdir)

    # A short gold rule, the one piece of accent on the panel.
    draw.rectangle([margin, t["rule_y"], margin + t["rule_w"], t["rule_y"] + 4], fill=GOLD)

    y = t["head_y"]
    for line in panel["head"].split("\n"):
        draw.text((margin, y), line, font=head_font, fill=INK)
        y += t["head_step"]

    y += t["sub_gap"]
    for line in wrap(draw, panel["sub"], sub_font, W - margin * 2):
        draw.text((margin, y), line, font=sub_font, fill=DIM)
        y += t["sub_step"]

    shot = Image.open(os.path.join(raw_dir, panel["file"])).convert("RGB")
    sw = t["shot_w"]
    sh = round(sw * shot.height / shot.width)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    # The device corner radius, carried through the same scale the shot was.
    corner = round(186 * sw / 1320)
    mask = rounded_mask((sw, sh), corner)
    x = (W - sw) // 2
    top = t["shot_top"]

    # Tinted shadow, never pure black: a black shadow under warm paper reads as
    # a hole rather than as lift.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [x, top + round(26 * sw / 1040), x + sw, top + sh], corner, fill=(26, 23, 20, 74)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(12, round(38 * sw / 1040))))
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB"), (0, 0))
    canvas.paste(shot, (x, top), mask)

    dst = os.path.join(t["out"], panel["file"])
    canvas.save(dst)
    return dst, (W, H)


def main():
    spec = json.load(sys.stdin)
    with tempfile.TemporaryDirectory() as tmpdir:
        for t in spec["targets"]:
            os.makedirs(t["out"], exist_ok=True)
            print(f"{t['label']} -> {t['w']}x{t['h']}  (ratio {t['h'] / t['w']:.2f}:1)")
            for panel in spec["panels"]:
                dst, size = build(panel, spec["raw"], t, tmpdir)
                im = Image.open(dst)
                assert im.size == (t["w"], t["h"]), f"{dst} came out {im.size}, not {(t['w'], t['h'])}"
                print(f"  {os.path.basename(dst)}  {im.size[0]}x{im.size[1]}")
    print("done")


if __name__ == "__main__":
    main()
