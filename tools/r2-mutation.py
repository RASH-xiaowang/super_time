# -*- coding: utf-8 -*-
"""R2 变异测试：验证 theme-alpha-ladder.spec.ts 的新增断言真的能咬住。

6 个变异，每个：改源码 → 跑 spec → 必须变红（退出码 != 0）→ 逐字节还原。
Windows shell=True 走 cmd.exe，所以命令行用 cmd 语法。
"""
import os
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path("D:/super-time-wechat")
THEME = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css"
LIGHT = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/light-theme.css"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/theme-alpha-ladder.spec.ts"NODE = os.environ.get("SUPERTIME_NODE", "node")
OUT = ROOT / "tools" / "_mut_r2_out.txt"

MUTATIONS = [
    # (标签, 文件, 原文, 变异后)
    ("M1 cyan 新档缺一（-25 删掉）",
     THEME, "  --nm-cyan-25:        rgba(0, 240, 255, 0.25);\n", ""),
    ("M2 cyan 新档值填错（-42 写成 0.41）",
     THEME, "--nm-cyan-42:        rgba(0, 240, 255, 0.42)", "--nm-cyan-42:        rgba(0, 240, 255, 0.41)"),
    ("M3 cyan 破单调（-18 抬到 0.30 > -20）",
     THEME, "--nm-cyan-18:        rgba(0, 240, 255, 0.18)", "--nm-cyan-18:        rgba(0, 240, 255, 0.30)"),
    ("M4 cyan 浅色漏覆盖（-45 删掉浅色）",
     LIGHT, "  --nm-cyan-45: rgba(8, 145, 178, 0.36);\n", ""),
    ("M5 purple 档值错（-18 写成 0.19）",
     THEME, "--nm-purple-18:      rgba(168, 85, 247, 0.18)", "--nm-purple-18:      rgba(168, 85, 247, 0.19)"),
    ("M6 purple 浅色色相错（改成 cyan 色相）",
     LIGHT, "  --nm-purple-14: rgba(124, 58, 237, 0.11);", "  --nm-purple-14: rgba(0, 145, 178, 0.11);"),
    ("M7 面令牌浅色抄成深色（黑块）",
     LIGHT, "  --nm-panel-solid: rgba(255, 255, 255, 0.85);", "  --nm-panel-solid: rgba(13, 21, 40, 0.72);"),
]


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_spec() -> tuple[int, str]:
    """跑 spec，返回 (退出码, 输出尾 1200 字)。"""
    cmd = (f'cd /d "{ROOT}" && '
           f'"{NODE}" node_modules/vitest/vitest.mjs run {SPEC} > "{OUT}" 2>&1')
    r = subprocess.run(cmd, shell=True)
    txt = OUT.read_text(encoding="utf-8", errors="replace") if OUT.exists() else ""
    return r.returncode, txt[-1200:]


results = []
for label, path, old, new in MUTATIONS:
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    n = text.count(old)
    if n != 1:
        results.append((label, f"SKIP 锚点 {n} 次", ""))
        continue
    before = sha(path)
    path.write_bytes(text.replace(old, new, 1).encode("utf-8"))
    rc, tail = run_spec()
    # 还原
    path.write_bytes(raw)
    after = sha(path)
    ok_restore = (before == after)
    verdict = "RED-OK" if rc != 0 else "*** GREEN (守卫没咬住!) ***"
    results.append((label, f"{verdict} rc={rc} restore={'OK' if ok_restore else 'FAIL'}", tail[:200]))

report = ["R2 变异测试报告", "=" * 70]
for label, verdict, tail in results:
    report.append(f"\n{label}")
    report.append(f"  → {verdict}")

reds = sum(1 for _, v, _ in results if "RED-OK" in v)
restores = sum(1 for _, v, _ in results if "restore=OK" in v)
report.append("\n" + "=" * 70)
report.append(f"RED-OK {reds}/{len(MUTATIONS)} | restore OK {restores}/{len(MUTATIONS)}")

(ROOT / "tools" / "_mut_r2_report.txt").write_text("\n".join(report), encoding="utf-8")
print("\n".join(report[-6:]))
sys.exit(0 if reds == len(MUTATIONS) and restores == len(MUTATIONS) else 1)
