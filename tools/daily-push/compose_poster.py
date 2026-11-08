#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""每日一推·产品海报合成：真实界面截图 + 压边文案，输出 1024×1536 竖版 PNG。

为什么不用文生图：产品推销图必须对得上界面，抽象插画证明不了任何功能。
本脚本只做排版 —— 截图来自真实 Electron（tools/daily-push/capture_panels.mjs），
不改动截图内容（除裁切与圆角）。

用法：
    python tools/daily-push/compose_poster.py --spec <spec.json>

spec.json（UTF-8，缺省字段可省）：
{
  "out": "绝对路径.png",
  "shot": "绝对路径.png",
  "crop": [x0, y0, x1, y1],
  "eyebrow": "数据总览 · 真实界面",
  "headline": "聊天记录，不必出门",
  "sub": "读本机微信数据，解密、解析、建索引，全在你自己的机器上完成。",
  "chips": ["本地解析", "不登录不发送", "自配模型"],
  "bullets": ["纯本机：搜索、导出、备份、图谱", "AI 功能需你配置并主动使用才出网"],
  "footer": "Super Time 1.1.0 · Windows 10/11 x64",
  "note": "本图取自真实界面截图 · 数据已脱敏"
}
"""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1024, 1536
BG_TOP = (4, 5, 10)
BG_BOTTOM = (8, 11, 20)
GRID = (122, 160, 255)
CY = (34, 211, 238)
VI = (139, 92, 246)
TXT = (233, 237, 255)
TXT2 = (154, 166, 201)
TXT3 = (99, 112, 143)

MARGIN = 64


def _commercial_font(env_name: str, fallbacks: tuple[str, ...]) -> Path:
    """只接受可商用再分发的字体；默认找 Noto Sans SC / Source Han Sans SC（OFL-1.1）。

    不把字体文件提交进仓库：海报是字形栅格化产物，字体本身不随项目分发。
    需要换字体时通过环境变量显式指定，避免再次误用系统专有字体。
    """
    configured = os.environ.get(env_name, "").strip() or os.environ.get("SUPERTIME_POSTER_FONT", "").strip()
    candidates = ([Path(configured)] if configured else []) + [Path(p) for p in fallbacks]
    for path in candidates:
        if path.is_file():
            return path
    raise SystemExit(
        f"缺少可商用中文字体：请安装 Noto Sans SC 或 Source Han Sans SC（OFL-1.1），"
        f"或用 {env_name} / SUPERTIME_POSTER_FONT 指定字体文件路径。"
    )


FONT_DIR = Path("C:/Windows/Fonts")
F_BOLD = _commercial_font("SUPERTIME_POSTER_FONT_BOLD", (
    str(FONT_DIR / "NotoSansSC-Bold.otf"),
    str(FONT_DIR / "NotoSansSC-VF.ttf"),
    str(FONT_DIR / "SourceHanSansSC-Bold.otf"),
    "assets/fonts/NotoSansSC-Bold.otf",
))
F_REG = _commercial_font("SUPERTIME_POSTER_FONT_REGULAR", (
    str(FONT_DIR / "NotoSansSC-Regular.otf"),
    str(FONT_DIR / "NotoSansSC-VF.ttf"),
    str(FONT_DIR / "SourceHanSansSC-Regular.otf"),
    "assets/fonts/NotoSansSC-Regular.otf",
))


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def vertical_gradient(w: int, h: int, top, bottom) -> Image.Image:
    small = Image.new("RGB", (1, h))
    px = small.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return small.resize((w, h), Image.BICUBIC)


def radial_glow(size: int, color, alpha: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse((0, 0, size - 1, size - 1), fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(size // 4))


def wrap_cjk(draw, text, f, max_w):
    """按宽度折行。中文排版忌讳「标点独自成行」，遇到收尾标点一律回挂到上一行。"""
    NO_LINE_START = "。，、；：？！）》」』”’%…"
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        trial = cur + ch
        if draw.textlength(trial, font=f) > max_w and cur:
            if ch in NO_LINE_START:
                cur = trial
                continue
            lines.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def rounded_shadow(size, radius, blur, alpha):
    w, h = size
    layer = Image.new("RGBA", (w + blur * 4, h + blur * 4), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        (blur * 2, blur * 2, blur * 2 + w, blur * 2 + h), radius, fill=(0, 0, 0, alpha))
    return layer.filter(ImageFilter.GaussianBlur(blur))


def prepare_shot(spec, max_h=None):
    """裁切并缩放截图。给了 max_h 时按高度反推宽度（保持比例、水平居中）。"""
    shot = Image.open(spec["shot"]).convert("RGB")
    if spec.get("crop"):
        shot = shot.crop(tuple(spec["crop"]))
    card_w = W - MARGIN * 2
    card_h = round(shot.height * card_w / shot.width)
    if max_h is not None and card_h > max_h:
        card_h = int(max_h)
        card_w = round(card_h * shot.width / shot.height)
    return shot.resize((card_w, card_h), Image.LANCZOS), card_w, card_h


def build(spec: dict) -> Path:
    canvas = vertical_gradient(W, H, BG_TOP, BG_BOTTOM).convert("RGBA")
    canvas.alpha_composite(radial_glow(1100, CY, 30), (-360, -300))
    canvas.alpha_composite(radial_glow(1200, VI, 34), (420, 620))
    canvas.alpha_composite(radial_glow(900, (244, 114, 182), 14), (620, -260))

    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 64):
        gd.line((x, 0, x, H), fill=GRID + (10,), width=1)
    for y in range(0, H, 64):
        gd.line((0, y, W, y), fill=GRID + (10,), width=1)
    canvas.alpha_composite(grid)
    d = ImageDraw.Draw(canvas)

    # ── 固定头部 ──────────────────────────────────────────────
    f_brand = font(F_BOLD, 26)
    d.text((MARGIN, 72), "SUPER TIME", font=f_brand, fill=TXT)
    bw = d.textlength("SUPER TIME", font=f_brand)
    d.text((MARGIN + bw + 18, 76), "微信 4.x 本地数据工作台", font=font(F_REG, 22), fill=TXT3)
    d.line((MARGIN, 118, W - MARGIN, 118), fill=GRID + (40,), width=1)

    # ── 量一遍高度，再决定从哪里开始画 ────────────────────────
    head = spec["headline"]
    hsize = 76
    while hsize >= 54:
        f_h = font(F_BOLD, hsize)
        head_lines = wrap_cjk(d, head, f_h, W - MARGIN * 2)
        if len(head_lines) <= 2:
            break
        hsize -= 4
    line_h = int(hsize * 1.34)

    f_sub = font(F_REG, 30)
    sub_lines = wrap_cjk(d, spec.get("sub", ""), f_sub, W - MARGIN * 2)[:3]
    f_chip = font(F_REG, 25)
    f_bul = font(F_REG, 27)
    bullets = spec.get("bullets", [])
    bul_lines = []
    for b in bullets:
        bul_lines.append(wrap_cjk(d, b, f_bul, W - MARGIN * 2 - 30)[:2])

    others = 0
    if spec.get("eyebrow"):
        others += 74
    others += 34 + len(head_lines) * line_h + 12
    others += len(sub_lines) * 46
    others += 40
    if spec.get("chips"):
        others += 42 + 52
    if bul_lines:
        others += 34 + sum(len(x) * 46 for x in bul_lines) + 10 * (len(bul_lines) - 1)

    avail = (H - 150) - 150
    shot_img, card_w, card_h = prepare_shot(spec, max_h=max(260, avail - others))
    total = others + card_h

    y = 150 + max(0, (avail - total) // 2)

    # ── 眉标 ─────────────────────────────────────────────────
    if spec.get("eyebrow"):
        f_eb = font(F_REG, 24)
        eb = spec["eyebrow"]
        tw = d.textlength(eb, font=f_eb)
        d.rounded_rectangle((MARGIN, y, MARGIN + tw + 40, y + 46), 23,
                            outline=GRID + (70,), width=1, fill=(12, 17, 31, 120))
        d.ellipse((MARGIN + 16, y + 19, MARGIN + 24, y + 27), fill=CY)
        d.text((MARGIN + 32, y + 9), eb, font=f_eb, fill=(169, 233, 255))
        y += 74

    # ── 主标题 ───────────────────────────────────────────────
    d.rounded_rectangle((MARGIN, y + 8, MARGIN + 64, y + 14), 3, fill=CY)
    y += 34
    for ln in head_lines:
        d.text((MARGIN, y), ln, font=f_h, fill=TXT)
        y += line_h
    y += 12

    for ln in sub_lines:
        d.text((MARGIN, y), ln, font=f_sub, fill=TXT2)
        y += 46

    # ── 截图卡片 ─────────────────────────────────────────────
    card_y = y + 40
    radius = 20
    card_x = MARGIN + (W - MARGIN * 2 - card_w) // 2
    canvas.alpha_composite(rounded_shadow((card_w, card_h), radius, 26, 190),
                           (card_x - 52, card_y - 52))
    mask = Image.new("L", (card_w, card_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card_w - 1, card_h - 1), radius, fill=255)
    canvas.paste(shot_img, (card_x, card_y), mask)

    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle((card_x, card_y, card_x + card_w, card_y + card_h), radius,
                        outline=GRID + (86,), width=1)
    y = card_y + card_h

    # ── 特性标签 ─────────────────────────────────────────────
    if spec.get("chips"):
        chip_y = y + 42
        cx = MARGIN
        for text in spec["chips"]:
            tw = d.textlength(text, font=f_chip)
            pw = tw + 52
            if cx + pw > W - MARGIN:
                break
            d.rounded_rectangle((cx, chip_y, cx + pw, chip_y + 52), 26,
                                fill=(14, 19, 33, 200), outline=GRID + (60,), width=1)
            d.text((cx + 26, chip_y + 11), text, font=f_chip, fill=(200, 224, 255))
            cx += pw + 14
        y = chip_y + 52

    # ── 卖点条目 ─────────────────────────────────────────────
    if bul_lines:
        y += 34
        for lines in bul_lines:
            d.rounded_rectangle((MARGIN + 2, y + 12, MARGIN + 14, y + 16), 2, fill=CY)
            for ln in lines:
                d.text((MARGIN + 30, y), ln, font=f_bul, fill=TXT2)
                y += 46
            y += 10

    # ── 页脚 ─────────────────────────────────────────────────
    d.line((MARGIN, H - 110, W - MARGIN, H - 110), fill=GRID + (34,), width=1)
    f_foot = font(F_REG, 22)
    d.text((MARGIN, H - 84), spec.get("footer", ""), font=f_foot, fill=TXT3)
    note = spec.get("note", "本图取自真实界面截图 · 数据已脱敏")
    d.text((W - MARGIN - d.textlength(note, font=f_foot), H - 84), note, font=f_foot, fill=TXT3)

    out = Path(spec["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out, "PNG", optimize=True)
    return out


def main():
    if "--spec" not in sys.argv:
        raise SystemExit("用法: compose_poster.py --spec <spec.json>")
    spec = json.loads(Path(sys.argv[sys.argv.index("--spec") + 1]).read_text(encoding="utf-8"))
    out = build(spec)
    print(f"OK {out} {out.stat().st_size}")


if __name__ == "__main__":
    main()
