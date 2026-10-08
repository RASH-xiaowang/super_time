# -*- coding: utf-8 -*-
"""R6 变异测试：证明 button-disabled-tone.wiring.spec.ts 能咬住问题。
判据：退出码（非 0 = 红了）＋ 必须逐字节还原。
"""
import subprocess, os
from pathlib import Path

ROOT = Path(r'D:/super-time-wechat')
NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
SPEC = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/button-disabled-tone.wiring.spec.ts'
PANELS = ROOT / 'src/client/ui-wechat/src/client/pages/wechat-data/panels'
E = lambda s: s.encode('utf-8')

MUTS = [
    ('M1 把一处好的禁用态改回野值 .45',
     PANELS / 'ask-history.module.css',
     '.dangerBtn:disabled { opacity: 0.5; cursor: not-allowed; }',
     '.dangerBtn:disabled { opacity: 0.45; cursor: not-allowed; }'),

    ('M2 新增一处野值 .7（另一个文件）',
     PANELS / 'graph.module.css',
     '.miniBtn:disabled { opacity: 0.5; cursor: default; }',
     '.miniBtn:disabled { opacity: 0.7; cursor: default; }'),

    ('M3 豁免表腐化：给一个已合规的类登记例外',
     ROOT / SPEC,
     "['ai-model.module.css|profileDel', '基准态即 .5，hover 提 1，禁用 .3 构成三级；改 .5 会与正常态撞值'],",
     "['ai-model.module.css|profileDel', '基准态即 .5，hover 提 1，禁用 .3 构成三级；改 .5 会与正常态撞值'],\n  ['ask-history.module.css|dangerBtn', '伪造的例外，实际已是 .5'],"),

    ('M4 全局焦点环被删（守卫该抓）',
     ROOT / 'src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css',
     'button:focus-visible,\n[role=\'button\']:focus-visible,',
     '[role=\'button\']:focus-visible,'),

    ('M7 哨兵自证：把 Graph.tsx 的 button 全改 div（点名该抓）',
     PANELS / 'Graph.tsx',
     '<button',
     '<div'),
]

# 说明（R6 实测）：还试过「把数字下限 80 降到 1」「把抽样点名表清空」两个变异，
# **都是 GREEN**。这不是守卫缺陷，而是这类变异本身无测试价值：
#   · 数字下限只是粗筛（实际 139），主要防线是抽样点名；
#   · 「点名表被清空」= 守卫自身被篡改，属元问题，没有任何守卫能防自己被删。
# M7 已证明点名对「扫描面塌陷」是敏感的（32 处替换 → 红），哨兵有效。

env = dict(os.environ)
env['CODEBUDDY_SAFE_DELETE_ENABLED'] = '0'
CMD = '"{}" "{}" run --reporter=basic "{}"'.format(NODE, ROOT / 'node_modules/vitest/vitest.mjs', SPEC)

# M5 需要「全量替换」语义（<button 在一个文件里出现多次）——单独处理
ALLOW_MULTI = {'M5 哨兵：把 Graph.tsx 的 button 全改成 div（扫描面塌陷）',
               'M7 哨兵自证：把 Graph.tsx 的 button 全改 div（点名该抓）'}

lines = []
for name, path, old, new in MUTS:
    raw = path.read_bytes()
    o, n = E(old), E(new)
    cnt = raw.count(o)
    if cnt == 0:
        lines.append('%-46s 锚点命中 0 次，跳过' % name)
        continue
    if cnt > 1 and name not in ALLOW_MULTI:
        lines.append('%-46s 锚点命中 %d 次（非唯一），跳过' % (name, cnt))
        continue
    if old == new:
        lines.append('%-46s 空变异（from == to），无效' % name)
        continue
    try:
        path.write_bytes(raw.replace(o, n))
        r = subprocess.run(CMD, cwd=str(ROOT), shell=True, capture_output=True,
                           text=True, encoding='utf-8', errors='replace', env=env)
        red = r.returncode != 0
        lines.append('%-46s %s  (exit %d, %d 处替换)' % (
            name, 'RED-OK' if red else '**GREEN — 守卫没咬住**', r.returncode, cnt))
    finally:
        path.write_bytes(raw)
        assert path.read_bytes() == raw, '%s 未逐字节还原' % path.name

(ROOT / 'tools' / '_r6_mut.txt').write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))
