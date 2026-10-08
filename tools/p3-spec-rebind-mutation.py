# -*- coding: utf-8 -*-
"""P3 收口时改动的两条既有守卫，做「放松绑定后仍咬得住」的变异自证。

背景：P3 把 `chats-export-dialog.tsx` 的三枚文字链换成 `LinkButton`，
原来的 DOM 用例按类名 `[class*="exportLinkBtn"]` 找元素 ⇒ 命中 0 而红。
修法是**改成按可见文本定位**（类名是实现细节，这次收敛正好把它换掉了）。

**放松绑定必须自证还咬得住**：如果我把选择器写得太宽（比如 `qa('button')[0]`），
用例会变成"点了个什么的都行"的恒真。下面每条变异都针对**行为**，不是针对选择器字符串。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(r"D:/super-time-wechat")
P = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-export-dialog.spec.ts"
NODE = r"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
VITEST = "node_modules/vitest/vitest.mjs"

MUTS = [
    ("N1 「全选」按钮的文案被改成「全不选」（文本定位必须发现）",
     P / "chats-export-dialog.tsx",
     """                  {expTypes.length > 0 ? '取消全选' : '全选'}""",
     """                  {expTypes.length > 0 ? '取消全选' : '全不选'}"""),
    ("N2 「全部时间」按钮的点击处理被摘掉（行为变了）",
     P / "chats-export-dialog.tsx",
     """<LinkButton onClick={() => { setExpFrom(''); setExpTo('') }}>全部时间</LinkButton>""",
     """<LinkButton>全部时间</LinkButton>"""),
    ("N3 「全选」的 updater 反向（空 ⇒ 交回空表）",
     P / "chats-export-dialog.tsx",
     """onClick={() => { setExpTypes(prev => prev.length > 0 ? [] : EXPO_TYPES.map(c => c.key)) }}>""",
     """onClick={() => { setExpTypes(prev => prev.length > 0 ? EXPO_TYPES.map(c => c.key) : []) }}>"""),
]


def run_spec() -> int:
    cmd = f'cd /d {ROOT} && CODEBUDDY_SAFE_DELETE_ENABLED=0 {NODE} {VITEST} run {SPEC}'
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode


def main():
    originals = {}
    for _, f, _, _ in MUTS:
        originals.setdefault(f, f.read_bytes())
    results = []
    try:
        for name, f, old, new in MUTS:
            src = f.read_bytes().decode("utf-8")
            n = src.count(old)
            if n != 1:
                print(f"[SKIP] {name} -- 锚点命中 {n} 次")
                results.append((name, "SKIP", n))
                continue
            f.write_bytes(src.replace(old, new, 1).encode("utf-8"))
            rc = run_spec()
            verdict = "RED-OK" if rc != 0 else "GREEN -- 咬不住！"
            results.append((name, verdict, rc))
            print(f"[{'OK' if rc != 0 else '!!'}] {name}  rc={rc}  {verdict}")
            f.write_bytes(originals[f])
            assert f.read_bytes() == originals[f], "还原失败！"
    finally:
        for f, data in originals.items():
            f.write_bytes(data)
    print("\n===== 汇总 =====")
    for name, verdict, info in results:
        print(f"{verdict:20s}  {name}  ({info})")
    bad = [r for r in results if r[1] != "RED-OK"]
    print(f"\n{len(results) - len(bad)}/{len(results)} RED-OK")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
