# -*- coding: utf-8 -*-
"""world-map-data.gate.spec.ts 边界守卫的变异自证（P2 收尾）。

为什么要修这条用例：全量跑时它红了，但单跑 10/10 绿。根因是**测量方式**用了真墙钟
（seed 与判定之间隔着一次 await，慢机器上能超过 15s）。修法 = 冻结时钟（vi.useFakeTimers）。

但"改完绿了"不等于"还咬得住" —— 冻结时钟把边界量成了确定值，也可能顺手把边界量没了。
所以这里把**被测逻辑**（world-map-data.ts 的 `ageMs <= FLAG_FRESH_MS`）按两个方向各推一次，
断言用例必须转红：
  M1 收紧：`<=` 改 `<`     ⇒ 刚好压线的那条应判过期 ⇒ 红
  M2 放宽：`<=` 改 `< +1`  ⇒ 这一条不红，但「刚过期」那组应变绿 ⇒ 所以要靠 M3
  M3 放宽（换靶）：FLAG_FRESH_MS 15_000 → 60_000 ⇒ 「过期镜像」组里 ageMs=60000 的那条应红

固定命令行字符串 + 看 returncode（不看输出文本）：本机踩过
`subprocess.run(列表, shell=True)` 在 Windows 上参数错乱的坑，会假全绿。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(r"D:/super-time-wechat")
SRC = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.gate.spec.ts"
NODE = r"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
VITEST = "node_modules/vitest/vitest.mjs"

MUTS = [
    ("M1 边界收紧：ageMs <= FLAG_FRESH_MS  →  ageMs < FLAG_FRESH_MS",
     "if (mirrored !== null && ageMs !== null && ageMs <= FLAG_FRESH_MS) return mirrored",
     "if (mirrored !== null && ageMs !== null && ageMs < FLAG_FRESH_MS) return mirrored"),
    ("M2 边界放宽：ageMs <= FLAG_FRESH_MS  →  ageMs <= FLAG_FRESH_MS + 1",
     "if (mirrored !== null && ageMs !== null && ageMs <= FLAG_FRESH_MS) return mirrored",
     "if (mirrored !== null && ageMs !== null && ageMs <= FLAG_FRESH_MS + 1) return mirrored"),
    ("M3 新鲜期放大：FLAG_FRESH_MS = 15_000  →  60_000",
     "const FLAG_FRESH_MS = 15_000",
     "const FLAG_FRESH_MS = 60_000"),
]


def run_spec() -> int:
    cmd = f'cd /d {ROOT} && CODEBUDDY_SAFE_DELETE_ENABLED=0 {NODE} {VITEST} run {SPEC}'
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode


def main() -> int:
    original = SRC.read_text(encoding="utf-8", newline="")
    results = []
    try:
        for name, old, new in MUTS:
            n = original.count(old)
            if n != 1:
                print(f"[SKIP] {name} -- 锚点命中 {n} 次（要求恰好 1）")
                results.append((name, "SKIP", n))
                continue
            SRC.write_text(original.replace(old, new, 1), encoding="utf-8", newline="")
            rc = run_spec()
            verdict = "RED-OK" if rc != 0 else "GREEN -- 咬不住！"
            results.append((name, verdict, rc))
            print(f"[{'OK' if rc != 0 else '!!'}] {name}  rc={rc}  {verdict}")
            # 逐字节还原
            SRC.write_text(original, encoding="utf-8", newline="")
            assert SRC.read_text(encoding="utf-8", newline="") == original, "还原失败！"
    finally:
        SRC.write_text(original, encoding="utf-8", newline="")

    print("\n===== 汇总 =====")
    for name, verdict, info in results:
        print(f"{verdict:22s}  {name}  ({info})")
    bad = [r for r in results if r[1] != "RED-OK"]
    print(f"\n{len(results) - len(bad)}/{len(results)} RED-OK")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
