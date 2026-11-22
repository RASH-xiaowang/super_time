"""Generate the SuperLanguage application icon without third-party dependencies."""

from __future__ import annotations

import math
import os
import struct
import zlib

SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
SS = 4

BG_LIGHT = (196, 219, 255)
BG_DARK = (54, 105, 224)
PLANE_TOP = (10, 16, 40)
PLANE_BOTTOM = (20, 34, 78)

UPPER_WING = ((0.16, 0.50), (0.855, 0.185), (0.485, 0.575))
LOWER_WING = ((0.485, 0.575), (0.855, 0.185), (0.575, 0.840))


def _rounded_rect_sdf(x: float, y: float, x0: float, y0: float,
                      x1: float, y1: float, radius: float) -> float:
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    hx, hy = (x1 - x0) / 2.0 - radius, (y1 - y0) / 2.0 - radius
    qx, qy = abs(x - cx) - hx, abs(y - cy) - hy
    ox, oy = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ox, oy) + min(max(qx, qy), 0.0) - radius


def _inside_polygon(x: float, y: float, points: tuple[tuple[float, float], ...]) -> bool:
    inside = False
    j = len(points) - 1
    for i, (xi, yi) in enumerate(points):
        xj, yj = points[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size: int) -> list[list[tuple[int, int, int, int]]]:
    rows: list[list[tuple[int, int, int, int]]] = []
    for py in range(size):
        row: list[tuple[int, int, int, int]] = []
        for px in range(size):
            r_sum = g_sum = b_sum = 0
            covered = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) / SS) / size
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    if _rounded_rect_sdf(x, y, 0.055, 0.055, 0.945, 0.945, 0.225) >= 0:
                        continue
                    if _inside_polygon(x, y, UPPER_WING):
                        color = PLANE_TOP
                    elif _inside_polygon(x, y, LOWER_WING):
                        color = PLANE_BOTTOM
                    else:
                        t = ((x - 0.08) * 0.55 + (y - 0.08) * 0.45) / 0.84
                        color = _mix(BG_LIGHT, BG_DARK, t)
                    r_sum += color[0]
                    g_sum += color[1]
                    b_sum += color[2]
                    covered += 1
            if covered:
                row.append((
                    round(r_sum / covered),
                    round(g_sum / covered),
                    round(b_sum / covered),
                    round(255 * covered / (SS * SS)),
                ))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return rows


def frame_to_bmp(rows: list[list[tuple[int, int, int, int]]]) -> bytes:
    size = len(rows)
    mask_stride = ((size + 31) // 32) * 4
    xor = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = rows[y][x]
            xor += bytes((b, g, r, a))
    mask = bytearray()
    for y in range(size - 1, -1, -1):
        line = bytearray(mask_stride)
        for x in range(size):
            if rows[y][x][3] < 128:
                line[x // 8] |= 0x80 >> (x % 8)
        mask += line
    header = struct.pack(
        "<IiiHHIIiiII",
        40, size, size * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0,
    )
    return header + bytes(xor) + bytes(mask)


def write_ico(path: str) -> None:
    frames = [(size, frame_to_bmp(render(size))) for size in SIZES]
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = bytearray()
    payload = bytearray()
    for size, data in frames:
        width = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", width, width, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        payload += data
    with open(path, "wb") as handle:
        handle.write(header + entries + payload)


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_preview(path: str, rows: list[list[tuple[int, int, int, int]]]) -> None:
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))
    png = (b"\x89PNG\r\n\x1a\n"
           + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + _png_chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(png)


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)
    write_ico(os.path.join(assets, "app.ico"))
    preview_dir = os.path.join(root, "build")
    os.makedirs(preview_dir, exist_ok=True)
    write_preview(os.path.join(preview_dir, "icon_preview.png"), render(256))


if __name__ == "__main__":
    main()
