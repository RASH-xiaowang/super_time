#!/usr/bin/env python3
"""Generate Super Time desktop icon: dark disc + geometric sci-fi mark."""
from __future__ import annotations

import math
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent


def polar(cx: float, cy: float, r: float, deg: float) -> tuple[float, float]:
    rad = math.radians(deg)
    return cx + r * math.cos(rad), cy + r * math.sin(rad)


def draw_disc(size: int) -> Image.Image:
    """Dark navy disc with vertical gradient, rim light, soft AA edge."""
    # gradient background (full square, then masked to circle)
    grad = Image.new("RGBA", (size, size))
    top = (8, 14, 28, 255)
    bot = (14, 28, 48, 255)
    for y in range(size):
        t = y / max(1, size - 1)
        row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(4))
        ImageDraw.Draw(grad).line([(0, y), (size, y)], fill=row)

    # center darkening
    vignette = Image.new("L", (size, size), 0)
    vd = ImageDraw.Draw(vignette)
    cx = size / 2
    r0 = size * 0.55
    for i in range(8, 0, -1):
        rr = r0 * i / 8
        a = int(46 * (1 - i / 8))
        vd.ellipse([cx - rr, cx - rr, cx + rr, cx + rr], fill=a)
    vignette = vignette.filter(ImageFilter.GaussianBlur(size * 0.04))
    dark = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dark.putalpha(vignette)
    grad = Image.alpha_composite(
        grad,
        Image.composite(
            Image.new("RGBA", (size, size), (0, 0, 0, 80)),
            Image.new("RGBA", (size, size), (0, 0, 0, 0)),
            vignette,
        ),
    )

    # circle mask with AA
    mask = Image.new("L", (size * 2, size * 2), 0)
    md = ImageDraw.Draw(mask)
    pad = int(size * 0.02)
    md.ellipse([pad, pad, size * 2 - pad, size * 2 - pad], fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)

    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc.paste(grad, (0, 0), mask)

    # cyan rim
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rr = size * 0.46
    w = max(2, int(size * 0.018))
    rd.ellipse([cx - rr, cx - rr, cx + rr, cx + rr], outline=(0, 200, 230, 140), width=w)
    rim = rim.filter(ImageFilter.GaussianBlur(size * 0.006))
    # clip rim to circle
    rim.putalpha(Image.composite(rim.split()[3], Image.new("L", (size, size), 0), mask))
    disc = Image.alpha_composite(disc, rim)
    return disc


def draw_mark(size: int) -> Image.Image:
    """Geometric monogram: dual chevron + diamond core + clock ticks."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = size / 2
    s = size

    cyan = (0, 240, 255, 255)
    cyan_soft = (140, 230, 255, 240)
    silver = (190, 215, 230, 235)
    white_hot = (230, 250, 255, 255)

    # outer thin ring
    ring_r = s * 0.40
    ring_w = max(2, int(s * 0.012))
    d.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=(0, 200, 220, 100),
        width=ring_w,
    )

    # hex frame
    hex_r = s * 0.28
    hex_pts = [polar(cx, cy, hex_r, a) for a in range(-90, 270, 60)]
    d.polygon(hex_pts, outline=(170, 205, 225, 200), width=max(2, int(s * 0.02)))
    inner = [polar(cx, cy, hex_r * 0.86, a) for a in range(-90, 270, 60)]
    d.polygon(inner, fill=(0, 50, 70, 55))

    # dual chevrons (S-flow)
    lw = max(3, int(s * 0.03))
    left = [
        (cx - s * 0.16, cy - s * 0.11),
        (cx - s * 0.015, cy - s * 0.015),
        (cx - s * 0.16, cy + s * 0.075),
    ]
    d.line(left, fill=cyan, width=lw)
    right = [
        (cx + s * 0.16, cy + s * 0.11),
        (cx + s * 0.015, cy + s * 0.015),
        (cx + s * 0.16, cy - s * 0.075),
    ]
    d.line(right, fill=cyan, width=lw)

    # time axis
    d.line(
        [(cx - s * 0.09, cy), (cx + s * 0.09, cy)],
        fill=silver,
        width=max(2, int(s * 0.014)),
    )

    # center diamond
    dia = s * 0.065
    diamond = [
        (cx, cy - dia),
        (cx + dia * 0.72, cy),
        (cx, cy + dia),
        (cx - dia * 0.72, cy),
    ]
    d.polygon(diamond, fill=(10, 30, 48, 255), outline=white_hot, width=max(2, int(s * 0.014)))
    core = s * 0.026
    d.polygon(
        [
            (cx, cy - core),
            (cx + core * 0.7, cy),
            (cx, cy + core),
            (cx - core * 0.7, cy),
        ],
        fill=cyan_soft,
    )

    # clock ticks N/E/S/W
    tick_len = s * 0.04
    tick_off = s * 0.33
    tw = max(2, int(s * 0.012))
    for deg in (-90, 0, 90, 180):
        x1, y1 = polar(cx, cy, tick_off, deg)
        x2, y2 = polar(cx, cy, tick_off + tick_len, deg)
        d.line([(x1, y1), (x2, y2)], fill=(0, 220, 240, 210), width=tw)

    # soft glow under mark
    glow = img.filter(ImageFilter.GaussianBlur(s * 0.025))
    r, g, b, a = glow.split()
    a = a.point(lambda p: p // 3)
    glow_layer = Image.merge("RGBA", (r, g, b, a))
    return Image.alpha_composite(glow_layer, img)


def make_png(size: int) -> Image.Image:
    base = size * 2  # light supersample
    composed = Image.alpha_composite(draw_disc(base), draw_mark(base))
    return composed.resize((size, size), Image.Resampling.LANCZOS)


def write_ico(path: Path, sizes: list[int]) -> None:
    """Write a multi-size ICO with PNG-compressed entries (Vista+)."""
    import struct

    images = [make_png(s) for s in sizes]
    payloads: list[bytes] = []
    for im in images:
        buf = BytesIO()
        im.save(buf, format="PNG")
        payloads.append(buf.getvalue())

    count = len(sizes)
    # ICONDIR + ICONDIRENTRY * count
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    offset = 6 + 16 * count
    for s, data in zip(sizes, payloads):
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack(
            "<BBBBHHII",
            w,
            h,
            0,  # palette
            0,  # reserved
            1,  # color planes
            32,  # bpp
            len(data),
            offset,
        )
        offset += len(data)
    path.write_bytes(header + entries + b"".join(payloads))


def main() -> None:
    make_png(1024).save(OUT / "icon-1024.png", "PNG")
    print("wrote icon-1024.png")
    make_png(512).save(OUT / "icon-512.png", "PNG")
    print("wrote icon-512.png")
    make_png(256).save(OUT / "icon.png", "PNG")
    print("wrote icon.png")
    ico_path = OUT / "icon.ico"
    write_ico(ico_path, [16, 24, 32, 48, 64, 128, 256])
    print(f"wrote icon.ico ({ico_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
