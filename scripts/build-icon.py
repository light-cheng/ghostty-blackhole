#!/usr/bin/env python3
"""Build the Black Hole Screensaver icon set from the supplied artwork.

Source:  build/icon-source.png  (1254x1254 RGBA, user-supplied tilted
         Gargantua artwork: opaque dark rounded-square tile with transparent
         corners and transparent padding around it)

Outputs (all RGBA PNG, one deterministic run):
  build/icon-1024.png   1024x1024 master, tile cropped to the canvas
  assets/icon.png        256x256  app / exe / shortcut / installer icon
  assets/icon-ui.png     128x128  settings-window header icon (shown at 24px)
  assets/tray.png         32x32   tray / taskbar / settings-window icon
  tmp/icon-review/*      review sheets (dark/light/checkerboard, small sizes)

The artwork itself is never redrawn; the script only removes the transparent
padding around the rounded-square tile (so it fills the icon canvas like a
regular Windows app icon), resizes with premultiplied alpha and derives the
small tray/UI variants.

Usage:
  python scripts/build-icon.py            # build all deliverables + previews
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "build", "icon-source.png")
PREVIEW_DIR = os.path.join(ROOT, "tmp", "icon-review")

# Crop: plate bbox is detected from the alpha channel; a hair of padding keeps
# the rounded-square anti-aliasing from being clipped.
CROP_PAD = 0.006


def premul_resize(img: Image.Image, size: int) -> Image.Image:
    """High-quality resize that never bleeds colour out of transparent pixels."""
    arr = np.asarray(img.convert("RGBA")).astype(np.float32)
    rgb = arr[..., :3]
    alpha = arr[..., 3:4] / 255.0
    premul = np.concatenate([rgb * alpha, alpha * 255.0], axis=-1)

    chans = []
    for c in range(4):
        band = Image.fromarray(np.clip(premul[..., c], 0, 255).astype(np.uint8))
        chans.append(np.asarray(band.resize((size, size), Image.LANCZOS)).astype(np.float32))
    p = np.stack(chans, axis=-1)
    a = np.clip(p[..., 3:4] / 255.0, 0.0, 1.0)
    out_rgb = np.where(a > 1e-4, p[..., :3] / np.maximum(a, 1e-4), 0.0)
    out = np.concatenate([np.clip(out_rgb, 0, 255), p[..., 3:4]], axis=-1)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


def crop_square(img: Image.Image, cx: float, cy: float, side: float) -> Image.Image:
    left = int(round(cx - side / 2.0))
    top = int(round(cy - side / 2.0))
    return img.crop((left, top, left + int(round(side)), top + int(round(side))))


def plate_box(img: Image.Image) -> tuple[float, float, float]:
    """Return (cx, cy, side) of the opaque rounded-square tile."""
    a = np.asarray(img.getchannel("A")).astype(np.float32) / 255.0
    ys, xs = np.where(a > 0.985)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    side = max(x1 - x0 + 1, y1 - y0 + 1) * (1.0 + 2.0 * CROP_PAD)
    return (x0 + x1) / 2.0, (y0 + y1) / 2.0, side


def sheet(images: list[tuple[str, Image.Image]], backgrounds: list[tuple[str, tuple[int, int, int]]],
          path: str, cell: int = 128, pad: int = 10, cols: int | None = None) -> None:
    """Lay out icon previews on solid backgrounds."""
    n = len(images) * len(backgrounds)
    cols = cols or len(images)
    rows = (n + cols - 1) // cols
    W = cols * (cell + pad) + pad
    H = rows * (cell + pad) + pad
    canvas = Image.new("RGB", (W, H), (128, 128, 128))
    i = 0
    for name, bg in backgrounds:
        for _label, icon in images:
            r, c = divmod(i, cols)
            tile = Image.new("RGB", (cell, cell), bg)
            try:
                resized = premul_resize(icon, cell)
            except Exception:
                resized = icon.resize((cell, cell), Image.LANCZOS)
            tile.paste(resized, (0, 0), resized)
            canvas.paste(tile, (pad + c * (cell + pad), pad + r * (cell + pad)))
            i += 1
    canvas.save(path)


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f"missing artwork: {SOURCE}", file=sys.stderr)
        return 1
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    src = Image.open(SOURCE).convert("RGBA")
    cx, cy, side = plate_box(src)
    tile = crop_square(src, cx, cy, side)
    master = premul_resize(tile, 1024)

    # App / exe icon (electron-builder converts this to the .ico).
    app_icon = premul_resize(tile, 256)
    app_icon.save(os.path.join(ROOT, "assets", "icon.png"), "PNG")

    # Settings-window header icon, displayed at 24x24 CSS px.
    ui_icon = premul_resize(tile, 128)
    ui_icon.save(os.path.join(ROOT, "assets", "icon-ui.png"), "PNG")

    # Tray icon: the same rounded tile so the tray icon matches the app icon.
    # The transparent corners keep it from reading as a dark rectangle on a
    # light taskbar, and the glowing disk keeps it visible on a dark one.
    tray_icon = premul_resize(tile, 32)
    tray_icon.save(os.path.join(ROOT, "assets", "tray.png"), "PNG")

    master.save(os.path.join(ROOT, "build", "icon-1024.png"), "PNG")

    # ---- review sheets -----------------------------------------------------
    sizes = [256, 64, 48, 32, 16]
    variants = [(str(s), premul_resize(tile, s)) for s in sizes]
    sheet(variants, [("dark", (32, 32, 32)), ("light", (243, 243, 243))],
          os.path.join(PREVIEW_DIR, "app-sizes-dark-light.png"),
          cell=256, pad=14, cols=5)
    variants_small = [(str(s), premul_resize(tile, s)) for s in [64, 48, 32, 16]]
    sheet(variants_small, [("dark", (32, 32, 32)), ("light", (243, 243, 243))],
          os.path.join(PREVIEW_DIR, "app-sizes-64-16.png"),
          cell=96, pad=12, cols=4)
    sheet([("32", premul_resize(tile, 32)), ("16", premul_resize(tile, 16))],
          [("dark", (32, 32, 32)), ("light", (243, 243, 243))],
          os.path.join(PREVIEW_DIR, "tray-dark-light.png"),
          cell=64, pad=12, cols=2)
    # UI icon at its real display size on the app's window background.
    ui_cell = 24
    canvas = Image.new("RGB", (200, 64), (10, 10, 15))
    small = premul_resize(tile, ui_cell)
    canvas.paste(small, (24, 20), small)
    ui_cell2 = 48
    big = premul_resize(tile, ui_cell2)
    canvas.paste(big, (100, 8), big)
    canvas.resize((400, 128), Image.NEAREST).save(
        os.path.join(PREVIEW_DIR, "ui-24-on-window.png"))
    # Transparency proof: checkerboard behind the 256 px icon.
    chk = Image.new("RGB", (300, 300), (60, 60, 60))
    step = 20
    for y in range(0, 300, step):
        for x in range(0, 300, step):
            if (x // step + y // step) % 2:
                chk.paste((90, 90, 90), (x, y, x + step, y + step))
    big = premul_resize(tile, 256)
    chk.paste(big, (22, 22), big)
    chk.save(os.path.join(PREVIEW_DIR, "app-on-checkerboard.png"))

    # ---- report ------------------------------------------------------------
    out = Image.open(os.path.join(ROOT, "assets", "icon.png"))
    a = np.asarray(out.getchannel("A"))
    corners = [int(a[0, 0]), int(a[0, -1]), int(a[-1, 0]), int(a[-1, -1])]
    print(f"source        : {os.path.basename(SOURCE)} {src.size}")
    print(f"tile crop     : center=({cx:.1f},{cy:.1f}) side={side:.1f}")
    print(f"icon 256      : alpha extrema={a.min()}..{a.max()} corners={corners}")
    for rel in ("assets/icon.png", "assets/tray.png", "assets/icon-ui.png", "build/icon-1024.png"):
        im = Image.open(os.path.join(ROOT, rel))
        print(f"{rel:22s}: {im.size[0]}x{im.size[1]} {im.mode}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
