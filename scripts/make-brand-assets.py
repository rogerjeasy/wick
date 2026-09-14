#!/usr/bin/env python3
"""
Generate Wick's Alexa+ add-on media assets.

Reproducible on purpose: committing a generator beats committing loose binaries
nobody can regenerate. Colours are the ones defined in
packages/vega-calm-ui/src/tokens.ts — one palette, used everywhere.

    python3 scripts/make-brand-assets.py

Outputs to docs/icons/ and docs/carousel/, which GitHub Pages serves at the exact
URLs referenced in addon-package/addon.json.

These are honest, on-brand marks, not finished design work. Replace them with
designed versions when you have them; the filenames and sizes must not change.
"""
from __future__ import annotations

import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

# packages/vega-calm-ui/src/tokens.ts
GROUND = (0x12, 0x10, 0x0E)
INK = (0xF4, 0xF1, 0xEA)
INK_DIM = (0xC8, 0xC2, 0xB6)
ACCENT = (0xE8, 0xB7, 0x5D)

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_SIZES = [72, 64, 88, 126, 180, 241]   # all six are mandatory
CAROUSEL = (600, 900)
SS = 4                                      # supersample factor for clean edges


def flame_points(cx: float, cy: float, h: float, w: float, steps: int = 240):
    """
    A candle flame: sharp point at the top, slow taper, widest around 70% down,
    rounded at the base where the wick would be.

    The exponent on `t` matters more than it looks. Too low and the width ramps
    up fast near the tip, which reads as a map pin rather than a flame.
    """
    def profile(t: float) -> float:          # t: 0 = tip (top), 1 = base
        return math.sin((t ** 1.7) * math.pi * 0.85) ** 0.8

    def lean(t: float) -> float:             # a little asymmetry; flames are not symmetric
        return -w * 0.06 * (1 - t) ** 2

    pts = []
    for i in range(steps + 1):               # down the right edge
        t = i / steps
        pts.append((cx + lean(t) + w * profile(t) / 2, cy - h / 2 + h * t))

    # Round the base. Closing the polygon straight across leaves a flat cut,
    # which no flame has — it is the single detail that made the first pass read
    # as a droplet rather than a flame.
    y_base = cy + h / 2
    r = w * profile(1.0) / 2
    for i in range(1, steps // 3):
        a = math.pi * i / (steps // 3)
        pts.append((cx + lean(1.0) + r * math.cos(a), y_base + r * 0.5 * math.sin(a)))

    for i in range(steps, -1, -1):           # back up the left edge
        t = i / steps
        pts.append((cx + lean(t) - w * profile(t) / 2, cy - h / 2 + h * t))
    return pts


def glow(size: int, cx: float, cy: float, radius: float, strength: float = 0.5):
    """Soft radial warmth behind the mark. Drawn as concentric rings."""
    layer = Image.new("RGB", (size, size), GROUND)
    d = ImageDraw.Draw(layer)
    rings = 48
    for i in range(rings, 0, -1):
        r = radius * i / rings
        k = (1 - i / rings) ** 2 * strength
        col = tuple(int(GROUND[c] + (ACCENT[c] - GROUND[c]) * k) for c in range(3))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    return layer


def make_icon(px: int) -> Image.Image:
    s = px * SS
    cx, cy = s / 2, s / 2
    img = glow(s, cx, cy * 1.04, s * 0.40, strength=0.30)
    d = ImageDraw.Draw(img)

    # Outer flame.
    d.polygon(flame_points(cx, cy * 1.00, s * 0.66, s * 0.42), fill=ACCENT)
    # Inner core, lighter — reads as heat rather than a flat silhouette.
    core = tuple(int(ACCENT[c] + (INK[c] - ACCENT[c]) * 0.55) for c in range(3))
    d.polygon(flame_points(cx, cy * 1.18, s * 0.30, s * 0.18), fill=core)

    return img.resize((px, px), Image.LANCZOS)


def _font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def make_carousel() -> Image.Image:
    w, h = CAROUSEL[0] * 2, CAROUSEL[1] * 2
    img = glow(max(w, h), w / 2, h * 0.30, h * 0.30, strength=0.22).crop((0, 0, w, h))
    d = ImageDraw.Draw(img)

    # Mark.
    d.polygon(flame_points(w / 2, h * 0.255, h * 0.21, h * 0.128), fill=ACCENT)
    core = tuple(int(ACCENT[c] + (INK[c] - ACCENT[c]) * 0.55) for c in range(3))
    d.polygon(flame_points(w / 2, h * 0.300, h * 0.095, h * 0.055), fill=core)

    serif = ["/System/Library/Fonts/Supplemental/Georgia.ttf",
             "/System/Library/Fonts/Times.ttc",
             "/Library/Fonts/Georgia.ttf"]
    sans = ["/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf"]

    def centred(text, font, y, fill):
        box = d.textbbox((0, 0), text, font=font)
        d.text(((w - (box[2] - box[0])) / 2, y), text, font=font, fill=fill)

    centred("Wick", _font(serif, int(h * 0.075)), h * 0.44, INK)
    centred("Still wick.", _font(serif, int(h * 0.030)), h * 0.545, ACCENT)

    small = _font(sans, int(h * 0.0195))
    lines = [
        "The television as the care surface",
        "for the person being cared for.",
        "",
        "Fire TV  ·  Ring  ·  Bee  ·  Alexa+",
    ]
    y = h * 0.655
    for ln in lines:
        if ln:
            centred(ln, small, y, INK_DIM if "·" not in ln else ACCENT)
        y += h * 0.036

    return img.resize(CAROUSEL, Image.LANCZOS)


def main() -> None:
    icons = ROOT / "docs" / "icons"
    carousel = ROOT / "docs" / "carousel"
    icons.mkdir(parents=True, exist_ok=True)
    carousel.mkdir(parents=True, exist_ok=True)

    for px in ICON_SIZES:
        out = icons / f"light-{px}.png"
        make_icon(px).save(out, "PNG", optimize=True)
        print(f"  {out.relative_to(ROOT)}  {px}x{px}")

    out = carousel / "wick-1.png"
    make_carousel().save(out, "PNG", optimize=True)
    print(f"  {out.relative_to(ROOT)}  {CAROUSEL[0]}x{CAROUSEL[1]}")


if __name__ == "__main__":
    main()
