# -*- coding: utf-8 -*-
"""P1 变异测试 v2：用「行号定位」代替「全文唯一片段」."""
import subprocess, re, hashlib
from pathlib import Path

ROOT = Path(r"D:/super-time-wechat")
PANELS = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/panels/button-family-e-align.wiring.spec.ts"
NODE = r"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"


def run_spec():
    cmd = (f'cd /d "{ROOT}" && set CODEBUDDY_SAFE_DELETE_ENABLED=0 && '
           f'"{NODE}" node_modules/vitest/vitest.mjs run {SPEC} --reporter=basic')
    return subprocess.run(cmd, shell=True, capture_output=True).returncode


def rule_span(text, cls):
    m = re.compile(r"^\s*\." + re.escape(cls) + r"\s*\{", re.M).search(text)
    if not m:
        return None
    o = text.index("{", m.start())
    d = 0
    for j in range(o, len(text)):
        if text[j] == "{":
            d += 1
        elif text[j] == "}":
            d -= 1
            if d == 0:
                return (text.count("\n", 0, o), text.count("\n", 0, j))
    return None


def mutate_in_block(fname, cls, old, new):
    """在指定类的规则块内替换 old->new，返回 (原有文本, 新文本, 命中数)。"""
    p = PANELS / fname
    text = p.read_bytes().decode("utf-8")
    span = rule_span(text, cls)
    lines = text.split("\n")
    s, e = span
    hits = 0
    for i in range(s, e + 1):
        if old in lines[i]:
            lines[i] = lines[i].replace(old, new)
            hits += 1
    return text, "\n".join(lines), hits


MUTS = [
    ("M1 .optApply 圆角改回 dense-r",     "ask.module.css",         "optApply", "--nm-r-pill",      "--nm-dense-r"),
    ("M2 .optDismiss 圆角改回 dense-r",   "ask.module.css",         "optDismiss", "--nm-r-pill",    "--nm-dense-r"),
    ("M3 chats-cards .loadMore 改回 16px", "chats-cards.module.css", "loadMore",  "padding: 6px 14px;", "padding: 6px 16px;"),
    ("M4 records .loadMore 改回 16px",    "records.module.css",     "loadMore",  "padding: 6px 14px;", "padding: 6px 16px;"),
    ("M5 .optBtn 固定高被删（豁免项失效）", "ask.module.css",         "optBtn",    "height: 28px;",   ""),
    ("M6 族 E 成员被删（点名哨兵）",       "ask.module.css",         "optDismiss", ".optDismiss {", ".optDismissX {"),
]

results = []
for name, fname, cls, old, new in MUTS:
    p = PANELS / fname
    orig = p.read_bytes()
    text, mutated, hits = mutate_in_block(fname, cls, old, new)
    if hits != 1:
        results.append(f"{name}: 块内命中 {hits} 次（期望 1）—— 跳过")
        continue
    p.write_bytes(mutated.encode("utf-8"))
    rc = run_spec()
    p.write_bytes(orig)
    restored = "OK" if hashlib.sha256(p.read_bytes()).hexdigest()[:12] == hashlib.sha256(orig).hexdigest()[:12] else "!! 还原失败"
    results.append(f"{name}: rc={rc} => {'RED-OK' if rc != 0 else '!! GREEN'} | 还原 {restored}")

Path(r"D:/super-time-wechat/working/_p1_mut2.txt").write_text("\n".join(results), encoding="utf-8")
print("done")
