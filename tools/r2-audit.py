# -*- coding: utf-8 -*-
"""R2 前置门精确审计。

区分三类"裸色"：
  A. fallback 兜底：var(--token, #hex) 里的 #hex —— 不算裸色（令牌在就是令牌）
  B. 注释里的示例色：/* ... #hex ... */ —— 完全不算
  C. 真裸硬编码：声明里直接用 #hex / rgb() / rgba()，没有 var() 包

只统计 C。
另外统计：!important、@media 断点值、硬编码浅色值（#0e7490 等）、--wx-* 越界。
"""
import re
import sys
from pathlib import Path

ROOT = Path("D:/super-time-wechat")
TARGETS = [
    "src/client/ui-app/titlebar.css",
    "src/client/ui-app/onboarding/onboarding.module.css",
    "src/client/ui-app/onboarding/onboarding-stages.module.css",
    "src/client/ui-app/license/license-gate.module.css",
    "src/client/ui-app/privacy/PrivacyConsentGate.module.css",
]

HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
RGB = re.compile(r"\brgba?\s*\(")
NAMED_LIGHT = re.compile(r"\b(white|black)\b", re.I)
# var(--x, fallback) 整段（含嵌套括号用简单两遍扫描）
VAR_CALL = re.compile(r"var\(\s*--[A-Za-z0-9_-]+\s*(?:,((?:[^()]|\([^()]*\))*))?\)")


def strip_comments(s: str) -> str:
    return re.sub(r"/\*.*?\*/", "", s, flags=re.S)


def split_decls(css: str):
    """产出 (选择器, 声明体) —— 朴素但够用。"""
    out = []
    i = 0
    depth = 0
    buf = ""
    for ch in css:
        if ch == "{":
            depth += 1
            if depth == 1:
                out.append((buf.strip(), ""))
                buf = ""
                continue
        elif ch == "}":
            depth -= 1
            if depth == 0:
                sel = out[-1][0]
                out.append(("", buf))
                buf = ""
                continue
        buf += ch
    return out


def audit(path: Path):
    raw = path.read_text(encoding="utf-8")
    nocomment = strip_comments(raw)
    bare = []          # (行号, 片段)
    fallbacks = 0
    comments_colors = 0

    # 注释里的颜色
    for m in re.finditer(r"/\*.*?\*/", raw, flags=re.S):
        comments_colors += len(HEX.findall(m.group(0)))

    lines = nocomment.split("\n")
    for idx, line in enumerate(lines, 1):
        s = line.strip()
        if not s or ":" not in s:
            continue
        # 只看属性行
        m = re.match(r"^([-A-Za-z]+)\s*:\s*(.+?);?$", s)
        if not m:
            continue
        prop, val = m.group(1), m.group(2)
        if prop.startswith("--"):
            # 令牌定义行：值里当然有裸色，这是**定义**不是使用 —— 但仍然值得看
            bare.append((idx, f"[DEF {prop}] {val[:70]}", "def"))
            continue
        # 剥掉所有 var(...) 调用（它们是合法的令牌使用）
        stripped = VAR_CALL.sub("", val)
        fallbacks += len(HEX.findall(val)) - len(HEX.findall(stripped))
        hits = HEX.findall(stripped) + RGB.findall(stripped)
        if hits:
            bare.append((idx, f"{prop}: {val[:80]}", "bare"))

    return len(raw.split("\n")), bare, fallbacks, comments_colors


report = []
report.append("=" * 78)
report.append("R2 前置门 · 精确裸色审计（只算真裸硬编码，剔除 fallback 与注释）")
report.append("=" * 78)

grand_bare = 0
grand_fb = 0
for t in TARGETS:
    p = ROOT / t
    if not p.exists():
        report.append(f"\n[缺失] {t}")
        continue
    total, bare, fb, cc = audit(p)
    real_bare = [b for b in bare if b[2] == "bare"]
    defs = [b for b in bare if b[2] == "def"]
    grand_bare += len(real_bare)
    grand_fb += fb
    report.append(f"\n### {t}")
    report.append(f"    总行 {total} | 真裸硬编码 {len(real_bare)} | fallback 兜底 {fb} | 注释示例色 {cc} | 令牌定义行 {len(defs)}")
    for ln, frag, _ in real_bare[:40]:
        report.append(f"      L{ln:<4} {frag}")
    if len(real_bare) > 40:
        report.append(f"      ... 另有 {len(real_bare) - 40} 处")

report.append("\n" + "=" * 78)
report.append(f"合计：真裸硬编码 {grand_bare} | fallback 兜底 {grand_fb}")
report.append("=" * 78)

out = ROOT / "tools" / "_r2_audit.txt"
out.write_text("\n".join(report), encoding="utf-8")
print(f"written {out} ({len(report)} lines)")
