# -*- coding: utf-8 -*-
"""R0 基线快照：静态统计全站令牌采纳率与裸色分布。

为什么不用 `npm run ui:panel-audit`：那个脚本要真实 Electron + 真实解密数据，
本机沙箱拦截 GUI 进程（沿用既定结论）。而令牌采纳率是**纯静态**可算的，
且它正是本次重设计的核心判据（"系统只被部分采纳"）。
输出固定为 UTF-8 文件，供人工比对与验收。

用法：python tools/ui-token-baseline.py <输出路径>
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 按"表面"分组（与 docs/UI-REDESIGN-2026-09-28.md 的表一致）
SURFACES = [
    ("自绘标题栏 Titlebar", ["src/client/ui-app/titlebar.css"]),
    ("授权 LicenseGate", ["src/client/ui-app/license/license-gate.module.css"]),
    ("启动引导 Onboarding", [
        "src/client/ui-app/onboarding/onboarding.module.css",
        "src/client/ui-app/onboarding/onboarding-stages.module.css",
    ]),
    ("隐私同意 PrivacyConsent", ["src/client/ui-app/privacy/PrivacyConsentGate.module.css"]),
    ("聊天消息区 Chats", [
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-rows.module.css",
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css",
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats.module.css",
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-shell.module.css",
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-calendar-dialog.module.css",
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-chatlog-dialog.module.css",
        "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-export-dialog.module.css",
    ]),
]

PANELS_DIR = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels"
KIT_FILES = [
    "src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.module.css",
    "src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-table.module.css",
    "src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-overlay.module.css",
    "src/client/ui-wechat/src/client/pages/wechat-data/ui/confirm.module.css",
]

RE_HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
RE_RGB = re.compile(r"\b(?:rgb|rgba|hsl|hsla)\s*\(")
RE_VAR = re.compile(r"var\s*\(\s*(--[A-Za-z0-9_-]+)")


def strip_comments(css: str) -> str:
    return re.sub(r"/\*[\s\S]*?\*/", "", css)


def measure(paths):
    tok = 0
    nm = 0
    hexn = 0
    rgbn = 0
    lines = 0
    hexvals: dict[str, int] = {}
    for p in paths:
        f = ROOT / p
        if not f.exists():
            continue
        raw = f.read_text(encoding="utf-8")
        lines += raw.count("\n") + 1
        css = strip_comments(raw)
        for m in RE_VAR.finditer(css):
            tok += 1
            if m.group(1).startswith("--nm-"):
                nm += 1
        for m in RE_HEX.finditer(css):
            hexn += 1
            hexvals[m.group(0).lower()] = hexvals.get(m.group(0).lower(), 0) + 1
        rgbn += len(RE_RGB.findall(css))
    naked = hexn + rgbn
    rate = (tok / (tok + naked) * 100) if (tok + naked) else 0.0
    return dict(files=len(paths), lines=lines, tok=tok, nm=nm, hex=hexn, rgb=rgbn,
                naked=naked, rate=rate, hexvals=hexvals)


def main():
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tools/ui-token-baseline.txt"
    rows = []
    for label, paths in SURFACES:
        rows.append((label, measure(paths)))

    panels = sorted(PANELS_DIR.glob("*.module.css"))
    panel_paths = [str(p.relative_to(ROOT)).replace("\\", "/") for p in panels]
    rows.append(("数据面板 panels/*", measure(panel_paths)))
    rows.append(("kit 组件库", measure(KIT_FILES)))

    # 全站：所有 CSS（排除 node_modules / ui-dist / working）
    all_css = []
    for p in ROOT.rglob("*.css"):
        s = str(p).replace("\\", "/")
        if "node_modules" in s or "ui-dist" in s or "/working/" in s or "\\working\\" in s:
            continue
        if ".tmp-e2e" in s:
            continue
        all_css.append(p)
    all_paths = [str(p.relative_to(ROOT)).replace("\\", "/") for p in all_css]
    site = measure(all_paths)

    lines = []
    lines.append("R0 基线快照 — 令牌采纳率（静态统计，可复现）")
    lines.append("生成方式：python tools/ui-token-baseline.py")
    lines.append("判据：采纳率 = 令牌引用 var(--*) / (令牌引用 + 裸色 hex/rgb)")
    lines.append("")
    lines.append("%-26s %5s %6s %7s %7s %6s %6s %9s %8s" % (
        "表面", "文件", "行数", "令牌引用", "其中--nm", "裸hex", "裸rgb", "裸色合计", "采纳率"))
    lines.append("-" * 108)
    for label, m in rows:
        lines.append("%-26s %5d %6d %7d %7d %6d %6d %9d %7.1f%%" % (
            label, m["files"], m["lines"], m["tok"], m["nm"], m["hex"], m["rgb"], m["naked"], m["rate"]))
    lines.append("-" * 108)
    lines.append("%-26s %5d %6d %7d %7d %6d %6d %9d %7.1f%%" % (
        "全站合计", site["files"], site["lines"], site["tok"], site["nm"], site["hex"],
        site["rgb"], site["naked"], site["rate"]))
    lines.append("")
    lines.append("=== 裸 hex 去重 Top 20 ===")
    for v, n in sorted(site["hexvals"].items(), key=lambda kv: -kv[1])[:20]:
        lines.append("  %-10s %d" % (v, n))
    lines.append("  去重色值总数 = %d" % len(site["hexvals"]))

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("written:", out_path)


if __name__ == "__main__":
    main()
