# -*- coding: utf-8 -*-
"""核实：onboarding/license 的浅色值是否全在 theme-light 作用域内。"""
import re
from pathlib import Path

ROOT = Path("D:/super-time-wechat")
FILES = [
    "src/client/ui-app/onboarding/onboarding.module.css",
    "src/client/ui-app/onboarding/onboarding-stages.module.css",
    "src/client/ui-app/license/license-gate.module.css",
]
LIGHT_HINT = re.compile(r"#(0e7490|f7f9fc|e8eef6|eef2f7|0369a1|0284c7)|rgba\(\s*(255,\s*255,\s*255|15,\s*23,\s*42|247,\s*249,\s*252|238,\s*242,\s*247)\b")

report = []
for f in FILES:
    raw = (ROOT / f).read_text(encoding="utf-8")
    # 预处理：注释替换成等长空格，保持行号
    def blank_comments(s):
        return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), s, flags=re.S)
    s = blank_comments(raw)
    # 逐行跟踪：当前所在的最内层选择器是否含 theme-light
    # 手法：维护一个选择器栈；遇到 { 压栈，} 弹栈
    depth_of_light = []   # 每层是否 light
    stack = []
    i = 0
    line = 1
    buf = ""
    cur_light = False
    findings = []
    # 简单状态机
    sel_buf = ""
    in_sel = True
    for idx, ch in enumerate(s):
        if ch == "\n":
            line += 1
        if ch == "{":
            sel = sel_buf.strip()
            is_light = "theme-light" in sel
            stack.append(is_light)
            sel_buf = ""
            in_sel = False
            continue
        if ch == "}":
            if stack: stack.pop()
            sel_buf = ""
            in_sel = True
            continue
        if ch == ";":
            # 声明结束
            stmt = sel_buf.strip()
            sel_buf = ""
            in_sel = False
            continue
        if not stack or not in_sel:
            sel_buf += ch
        else:
            sel_buf += ch
            # 检测声明
    # 换个更稳的做法：按行 + 大括号计数
    report.append(f"\n### {f}")
    depth = 0
    sel_stack = []
    for ln, l in enumerate(s.split("\n"), 1):
        stripped = l.strip()
        if "{" in l:
            sel = l.split("{")[0].strip()
            st = list(sel_stack)
            if sel: st.append(sel)
            sel_stack = st
            depth += 1
        if LIGHT_HINT.search(stripped) and ":" in stripped and not stripped.startswith("/*"):
            in_light = any("theme-light" in x for x in sel_stack)
            tag = "LIGHT-SCOPE" if in_light else "*** DARK-SCOPE ***"
            report.append(f"  L{ln:<4} [{tag}] {stripped[:78]}")
        if "}" in l:
            cnt = l.count("}")
            for _ in range(cnt):
                if sel_stack: sel_stack.pop()
                depth -= 1
    if not any("LIGHT" in x for x in report[-50:]):
        report.append("  （无浅色值）")

out = ROOT / "tools" / "_r2_scope.txt"
out.write_text("\n".join(report), encoding="utf-8")
print("ok")
