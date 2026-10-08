# -*- coding: utf-8 -*-
"""P3 族 C 守卫的变异自证。

锚点唯一 / 必须变红 / 逐字节还原。
判「红了没」看 **退出码**（MEMORY：别匹配输出文本；`subprocess.run(列表, shell=True)`
在 Windows 上参数会错乱 ⇒ 假全绿）。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(r"D:/super-time-wechat")
P = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels"
UI = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/ui"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/panels/button-family-c-link.wiring.spec.ts"
NODE = r"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
VITEST = "node_modules/vitest/vitest.mjs"

# (说明, 文件, old, new)
MUTS = [
    # ── 守卫自证：组件体切片真的咬得住（这是本轮修过的 bug）─────────────
    ("M1 组件不渲染 <button>（改成 div）",
     UI / "kit-fields.tsx",
     """    <button type="button" className={clsx(css.link, className)} {...rest}>
      {children}
    </button>""",
     """    <div className={clsx(css.link, className)} {...rest}>
      {children}
    </div>"""),
    ("M2 组件丢掉 type=\"button\"",
     UI / "kit-fields.tsx",
     """    <button type="button" className={clsx(css.link, className)} {...rest}>""",
     """    <button className={clsx(css.link, className)} {...rest}>"""),
    ("M3 组件不挂 css.link",
     UI / "kit-fields.tsx",
     """    <button type="button" className={clsx(css.link, className)} {...rest}>""",
     """    <button type="button" className={clsx(css.panelDesc, className)} {...rest}>"""),

    # ── 样式自证：.link 的六项几何 / hover 纯下划线 ────────────────────
    ("M4 .link 的 padding 0 改成 4px 8px",
     UI / "kit.module.css",
     """  padding: 0;
  border: none;
  background: none;
  color: var(--nm-cyan);""",
     """  padding: 4px 8px;
  border: none;
  background: none;
  color: var(--nm-cyan);"""),
    ("M5 .link 的 border 加回来",
     UI / "kit.module.css",
     """  padding: 0;
  border: none;
  background: none;
  color: var(--nm-cyan);""",
     """  padding: 0;
  border: 1px solid var(--nm-border);
  background: none;
  color: var(--nm-cyan);"""),
    ("M6 .link 字号换回裸值 11px",
     UI / "kit.module.css",
     """  font-size: var(--nm-fs-sm);
  cursor: pointer;
  transition: color 0.15s;""",
     """  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s;"""),
    ("M7 hover 加回装饰性发光（用户裁决禁止）",
     UI / "kit.module.css",
     """.link:hover {
  text-decoration: underline;
}""",
     """.link:hover {
  text-decoration: underline;
  text-shadow: 0 0 8px var(--nm-cyan);
}"""),

    # ── 收编自证：调用点 / 类退役 ────────────────────────────────────
    ("M8 一个调用点改回手写 <button className={css.linkBtn}>",
     P / "Storage.tsx",
     """<LinkButton onClick={() => { onOpenChat(f.username) }}>{f.sessionName || f.username}</LinkButton>""",
     """<button type="button" className={css.linkBtn} onClick={() => { onOpenChat(f.username) }}>{f.sessionName || f.username}</button>"""),
    ("M9 让某个已退役的类复活",
     P / "tasks.module.css",
     """/* Task extraction — NEON MATRIX 科技风（与每日总结共用令牌）。 */""",
     """.linkBtn {
  background: none;
  border: none;
  padding: 0;
  color: var(--nm-cyan);
  font-size: 11px;
  cursor: pointer;
}
.linkBtn:hover { text-decoration: underline; }

/* Task extraction — NEON MATRIX 科技风（与每日总结共用令牌）。 */"""),
]


def run_spec() -> int:
    cmd = f'cd /d {ROOT} && CODEBUDDY_SAFE_DELETE_ENABLED=0 {NODE} {VITEST} run {SPEC}'
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode


def main():
    originals = {}
    for _, f, _, _ in MUTS:
        if f not in originals:
            originals[f] = f.read_bytes()

    results = []
    try:
        for name, f, old, new in MUTS:
            src = f.read_bytes().decode("utf-8")
            n = src.count(old)
            if n != 1:
                print(f"[SKIP] {name} -- 锚点命中 {n} 次（要求 1）")
                results.append((name, "SKIP", n))
                continue
            f.write_bytes(src.replace(old, new, 1).encode("utf-8"))
            rc = run_spec()
            verdict = "RED-OK" if rc != 0 else "GREEN -- 咬不住！"
            results.append((name, verdict, rc))
            print(f"[{'OK' if rc != 0 else '!!'}] {name}  rc={rc}  {verdict}")
            # 逐字节还原
            f.write_bytes(originals[f])
            assert f.read_bytes() == originals[f], f"{f} 还原失败！"
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
