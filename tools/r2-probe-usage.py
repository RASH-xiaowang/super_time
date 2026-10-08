# -*- coding: utf-8 -*-
"""R2a-2：补齐第二批令牌（按**源文件**真实用量定档，不扫构建产物）。

判据：某 alpha 在 `src/**/*.css`（排除 ui-dist / node_modules）出现 ≥2 次 ⇒ 立档。
"""
import re
from pathlib import Path

ROOT = Path("D:/super-time-wechat")
SRC = ROOT / "src"

cyan_use = {}
purple_use = {}
for f in SRC.rglob("*.css"):
    if "node_modules" in str(f) or "ui-dist" in str(f):
        continue
    t = re.sub(r"/\*.*?\*/", "", f.read_text(encoding="utf-8"), flags=re.S)
    for m in re.finditer(r"rgba\(0,\s*240,\s*255,\s*([\d.]+)\)", t):
        cyan_use[m.group(1)] = cyan_use.get(m.group(1), 0) + 1
    for m in re.finditer(r"rgba\(168,\s*85,\s*247,\s*([\d.]+)\)", t):
        purple_use[m.group(1)] = purple_use.get(m.group(1), 0) + 1

existing_cyan = {"0.04", "0.06", "0.08", "0.10", "0.12", "0.14", "0.16", "0.18",
                 "0.20", "0.25", "0.35", "0.42", "0.45", "0.50"}
existing_purple = {"0.08", "0.10", "0.14", "0.18", "0.20", "0.50"}

out = ["=== 源文件里「未立档且用量>=2」的 cyan ==="]
need_cyan = []
for a in sorted(cyan_use, key=float):
    if a not in existing_cyan and cyan_use[a] >= 2:
        out.append(f"  {a:>6} x{cyan_use[a]}")
        need_cyan.append(a)
out.append("=== 源文件里「未立档且用量>=2」的 purple ===")
need_purple = []
for a in sorted(purple_use, key=float):
    if a not in existing_purple and purple_use[a] >= 2:
        out.append(f"  {a:>6} x{purple_use[a]}")
        need_purple.append(a)

out.append(f"\n建议新增 cyan: {need_cyan}")
out.append(f"建议新增 purple: {need_purple}")

Path("tools/_r2_probe4.txt").write_text("\n".join(out), encoding="utf-8")
print("\n".join(out))
