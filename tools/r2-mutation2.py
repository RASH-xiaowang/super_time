# -*- coding: utf-8 -*-
"""R2 第二轮变异：验证 first-impressions-tokens.spec.ts 能咬住。"""
import os
import hashlib, subprocess, sys
from pathlib import Path
ROOT = Path("D:/super-time-wechat")
APP = ROOT/"src/client/ui-app"
SPEC = "src/client/ui-wechat/src/client/pages/wechat-data/first-impressions-tokens.spec.ts"
NODE = os.environ.get("SUPERTIME_NODE", "node")
OUT = ROOT/"tools"/"_mut_r2b_out.txt"
TB = APP/"titlebar.css"
OB = APP/"onboarding/onboarding.module.css"
PC = APP/"privacy/PrivacyConsentGate.module.css"
MUT = [
 ("M1 titlebar 新增裸色（应违规）", TB,
  "  background: var(--nm-hover-neutral, rgba(127, 127, 127, 0.16));",
  "  background: rgba(9, 9, 9, 0.9);"),
 ("M2 onboarding 新增裸色 rgba()", OB,
  "box-shadow: 0 8px 24px var(--nm-ink-8, rgba(15, 23, 42, 0.08));", "box-shadow: 0 8px 24px rgba(99, 99, 99, 0.3);"),
 ("M3 privacy 断点改成非档位 777", PC,
  "@media (max-width: 1100px)", "@media (max-width: 777px)"),
 ("M4 onboarding 断点改成 1234", OB,
  "@media (max-width: 900px)", "@media (max-width: 1234px)"),
 ("M5 断开 min/max 配对", OB,
  "@media (min-width: 901px)", "@media (min-width: 777px)"),
 ("M6 基线虚高检测：删一处豁免裸色", TB,
  "  color: #fff;\n", ""),
]
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def run():
    cmd = (f'cd /d "{ROOT}" && "{NODE}" node_modules/vitest/vitest.mjs run {SPEC} '
           f'> "{OUT}" 2>&1')
    r = subprocess.run(cmd, shell=True)
    return r.returncode
res=[]
for label, path, old, new in MUT:
    raw = path.read_bytes(); t = raw.decode("utf-8")
    if t.count(old) != 1:
        res.append((label, f"SKIP anchor x{t.count(old)}")); continue
    before = sha(path)
    path.write_bytes(t.replace(old,new,1).encode("utf-8"))
    rc = run()
    path.write_bytes(raw)
    ok = sha(path) == before
    res.append((label, f"{'RED-OK' if rc!=0 else '*** GREEN 没咬住 ***'} rc={rc} restore={'OK' if ok else 'FAIL'}"))
rep=["R2b 变异报告","="*60]
for l,v in res: rep.append(f"{l}\n  → {v}")
reds=sum(1 for _,v in res if "RED-OK" in v)
rep.append(f"\nRED-OK {reds}/{len(MUT)}")
txt="\n".join(rep)
(ROOT/"tools"/"_mut_r2b_report.txt").write_text(txt, encoding="utf-8")
print(txt); sys.exit(0 if reds==len(MUT) else 1)
