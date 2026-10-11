#!/usr/bin/env python3
"""
Generate Wick's Alexa+ add-on media assets.

Reproducible on purpose: committing a generator beats committing loose binaries
nobody can regenerate. Colours are the ones defined in
packages/vega-calm-ui/src/tokens.ts — one palette, used everywhere.

    python3 scripts/make-brand-assets.py

Outputs to docs/icons/ and docs/carousel/, which GitHub Pages serves at the exact
URLs referenced in addon-package/addon.json, and the Fire OS app's launcher
icons and television banner under apps/tv-fireos/android/app/src/main/res/.

These are honest, on-brand marks, not finished design work. Replace them with
designed versions when you have them; the filenames and sizes must not change.
"""
from __future__ import annotations

import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

# packages/vega-calm-ui/src/tokens.ts
GROUND = (0x12, 0x10, 0x0E)
# The ground of the dark-theme icons: the default card colour of Alexa+'s dark
# theme (the add-on design guide's Visual Foundations; apps/sim-alexa uses the
# same value as --card). The mark sits on the surface it is shown on.
DARK_THEME_GROUND = (0x14, 0x18, 0x1E)
INK = (0xF4, 0xF1, 0xEA)
INK_DIM = (0xC8, 0xC2, 0xB6)
ACCENT = (0xE8, 0xB7, 0x5D)

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_SIZES = [72, 64, 88, 126, 180, 241]   # all six are mandatory, for each theme given
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


def glow(size: int, cx: float, cy: float, radius: float, strength: float = 0.5, ground=GROUND):
    """Soft radial warmth behind the mark. Drawn as concentric rings."""
    layer = Image.new("RGB", (size, size), ground)
    d = ImageDraw.Draw(layer)
    rings = 48
    for i in range(rings, 0, -1):
        r = radius * i / rings
        k = (1 - i / rings) ** 2 * strength
        col = tuple(int(ground[c] + (ACCENT[c] - ground[c]) * k) for c in range(3))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    return layer


def make_icon(px: int, ground=GROUND) -> Image.Image:
    s = px * SS
    cx, cy = s / 2, s / 2
    img = glow(s, cx, cy * 1.04, s * 0.40, strength=0.30, ground=ground)
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
        "Fire TV  ·  Ring  ·  Alexa+",
    ]
    y = h * 0.655
    for ln in lines:
        if ln:
            centred(ln, small, y, INK_DIM if "·" not in ln else ACCENT)
        y += h * 0.036

    return img.resize(CAROUSEL, Image.LANCZOS)


# What Android calls each screen density, and the launcher icon's size at it.
ANDROID_ICON_PX = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# The banner a television launcher shows for an app: 320x180 at xhdpi, which
# is the density of a 1080p television.
ANDROID_BANNER = (320, 180)
ANDROID_RES = ROOT / "apps" / "tv-fireos" / "android" / "app" / "src" / "main" / "res"


def make_tv_banner() -> Image.Image:
    """The mark and the name, side by side: what Fire OS and Android TV list Wick as."""
    w, h = ANDROID_BANNER[0] * SS, ANDROID_BANNER[1] * SS
    img = glow(max(w, h), w * 0.30, h * 0.52, h * 0.70, strength=0.26).crop((0, 0, w, h))
    d = ImageDraw.Draw(img)

    d.polygon(flame_points(w * 0.30, h * 0.50, h * 0.62, h * 0.38), fill=ACCENT)
    core = tuple(int(ACCENT[c] + (INK[c] - ACCENT[c]) * 0.55) for c in range(3))
    d.polygon(flame_points(w * 0.30, h * 0.59, h * 0.28, h * 0.165), fill=core)

    serif = ["/System/Library/Fonts/Supplemental/Georgia.ttf",
             "/System/Library/Fonts/Times.ttc",
             "/Library/Fonts/Georgia.ttf"]
    font = _font(serif, int(h * 0.34))
    box = d.textbbox((0, 0), "Wick", font=font)
    d.text((w * 0.47, (h - (box[3] - box[1])) / 2 - box[1]), "Wick", font=font, fill=INK)

    return img.resize(ANDROID_BANNER, Image.LANCZOS)


def make_round_icon(px: int) -> Image.Image:
    """The launcher icon, cut to a circle for launchers that ask for one."""
    s = px * SS
    square = make_icon(px).resize((s, s), Image.LANCZOS)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, s - 1, s - 1], fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(square, (0, 0), mask)
    return out.resize((px, px), Image.LANCZOS)


def main() -> None:
    icons = ROOT / "docs" / "icons"
    carousel = ROOT / "docs" / "carousel"
    icons.mkdir(parents=True, exist_ok=True)
    carousel.mkdir(parents=True, exist_ok=True)

    for theme, ground in (("light", GROUND), ("dark", DARK_THEME_GROUND)):
        for px in ICON_SIZES:
            out = icons / f"{theme}-{px}.png"
            make_icon(px, ground).save(out, "PNG", optimize=True)
            print(f"  {out.relative_to(ROOT)}  {px}x{px}")

    out = carousel / "wick-1.png"
    make_carousel().save(out, "PNG", optimize=True)
    print(f"  {out.relative_to(ROOT)}  {CAROUSEL[0]}x{CAROUSEL[1]}")

    # The Fire OS app's launcher icons and television banner.
    for density, px in ANDROID_ICON_PX.items():
        folder = ANDROID_RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        make_icon(px).save(folder / "ic_launcher.png", "PNG", optimize=True)
        make_round_icon(px).save(folder / "ic_launcher_round.png", "PNG", optimize=True)
        print(f"  {(folder / 'ic_launcher.png').relative_to(ROOT)}  {px}x{px} (and round)")

    banner = ANDROID_RES / "drawable-xhdpi"
    banner.mkdir(parents=True, exist_ok=True)
    make_tv_banner().save(banner / "tv_banner.png", "PNG", optimize=True)
    print(f"  {(banner / 'tv_banner.png').relative_to(ROOT)}  {ANDROID_BANNER[0]}x{ANDROID_BANNER[1]}")


if __name__ == "__main__":
    main()
