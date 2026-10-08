# -*- coding: utf-8 -*-
"""P2 变异：确认 button-family-a-chip-token.wiring.spec.ts 能咬住真实改动。"""
import subprocess, re, hashlib
from pathlib import Path

ROOT = Path(r"D:/super-time-wechat")
PANELS = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/panels/button-family-a-chip-token.wiring.spec.ts"
NODE = r"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"


def run_spec():
    cmd = (f'cd /d "{ROOT}" && set CODEBUDDY_SAFE_DELETE_ENABLED=0 && '
           f'"{NODE}" node_modules/vitest/vitest.mjs run {SPEC} --reporter=basic')
    return subprocess.run(cmd, shell=True, capture_output=True).returncode


def rule_span(text, cls):
    m = re.compile(r"^\s*\." + re.escape(cls) + r"\s*\{", re.M).search(text)
    if not m:
        return None
    o = text.index("{", m.start()); d = 0
    for j in range(o, len(text)):
        if text[j] == "{": d += 1
        elif text[j] == "}":
            d -= 1
            if d == 0:
                return (o + 1, j)
    return None


def mut(fname, cls, old, new):
    """块内替换，返回 (原文, 新文, 命中数)。"""
    p = PANELS / fname
    text = p.read_bytes().decode("utf-8")
    sp = rule_span(text, cls)
    a, b = sp
    blk = text[a:b]
    n = blk.count(old)
    return text, text[:a] + blk.replace(old, new) + text[b:], n


MUTS = [
    ("M1 chip 字号换回裸 12px",            "graph.module.css",     "chip",       "font-size: var(--nm-fs-sm)",      "font-size: 12px"),
    ("M2 fbBtn 字号换回裸 11px",           "retrieval.module.css", "fbBtn",      "font-size: var(--nm-dense-fs-sm)", "font-size: 11px"),
    ("M3 chip 加了带裸兜底的 fallback",     "monitor.module.css",   "chip",       "font-size: var(--nm-fs-sm)",      "font-size: var(--nm-fs-sm, 12px)"),
    ("M4 把 catBtn 从点名表对应的类改名",   "list-panel.module.css","catBtn",     ".catBtn {",                       ".catBtnX {"),
    ("M5 把某个 chip 的 pill 圆角改成方角",  "contacts.module.css",  "catBtn",     "border-radius: var(--nm-r-pill)", "border-radius: 6px"),
]

results = []
for name, fname, cls, old, new in MUTS:
    p = PANELS / fname
    orig = p.read_bytes()
    text, mutated, n = mut(fname, cls, old, new)
    if n != 1:
        results.append(f"{name}: 块内命中 {n}（期望 1）—— 跳过")
        continue
    p.write_bytes(mutated.encode("utf-8"))
    rc = run_spec()
    p.write_bytes(orig)
    ok = hashlib.sha256(p.read_bytes()).hexdigest()[:12] == hashlib.sha256(orig).hexdigest()[:12]
    results.append(f"{name}: rc={rc} => {'RED-OK' if rc != 0 else '!! GREEN'} | 还原 {'OK' if ok else '!! 失败'}")

# 额外：令牌值被改（等价性前提破坏）—— 改 scifi-theme.css
THEME = PANELS.parent / "scifi-theme.css"
orig = THEME.read_bytes()
txt = orig.decode("utf-8")
old = "--nm-fs-sm: "
m = re.search(re.escape(old) + r"([^;]+)", txt)
results.append(f"\n[令牌等价性] --nm-fs-sm 现值 = {m.group(1).strip()}")
mutated = txt[:m.start(1)] + "13px" + txt[m.end(1):]
THEME.write_bytes(mutated.encode("utf-8"))
rc = run_spec()
THEME.write_bytes(orig)
ok = hashlib.sha256(THEME.read_bytes()).hexdigest()[:12] == hashlib.sha256(orig).hexdigest()[:12]
results.append(f"M6 把 --nm-fs-sm 改成 13px（破坏零视觉变化前提）: rc={rc} => {'RED-OK' if rc != 0 else '!! GREEN'} | 还原 {'OK' if ok else '!! 失败'}")

Path(r"D:/super-time-wechat/working/_p2_mut.txt").write_text("\n".join(results), encoding="utf-8")
print("done")
