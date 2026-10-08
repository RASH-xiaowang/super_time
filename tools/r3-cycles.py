# -*- coding: utf-8 -*-
"""R3 安全检查：静态解析 var() 引用图，检测循环引用与「自引用 fallback」。

背景：`--nm-bg-0: var(--dsw-alias-bg-base, var(--nm-bg-0))` 这种写法，
fallback 里引用了**自己**。CSS 规范下 fallback 只在主引用失败时求值，
所以「主引用成功」时不构成循环；但一旦主引用也失效，就会变成 guaranteed-invalid。

R3 把 25 个 dsw 改成转发 nm 后，新增了 dsw -> nm 的边，
需要确认没有形成 nm -> dsw -> nm 的真环。
"""
import re

ROOT = r'D:\super-time-wechat\src\client\ui-wechat\src\client\pages\wechat-data'
P = ROOT + r'\scifi-theme.css'
L = ROOT + r'\light-theme.css'


def strip(css):
    return re.sub(r'/\*[\s\S]*?\*/', '', css)


def decls(css):
    out = {}
    for m in re.finditer(r'^[ \t]*(--[a-z0-9-]+)[ \t]*:[ \t]*([^;{}]+);', strip(css), re.M):
        out[m.group(1)] = m.group(2).strip()
    return out


D = decls(open(P, encoding='utf-8').read())
LT = decls(open(L, encoding='utf-8').read())

# 展开某一层：值里出现的 var(--x...) 名字（**不区分主引用/fallback**，用于找环）
VAR = re.compile(r'var\(\s*(--[a-z0-9-]+)')


def refs(v):
    return VAR.findall(v)


def find_cycles(table, label):
    cycles = []
    for start in table:
        seen = []
        cur = start
        guard = 0
        while cur in table and guard < 50:
            guard += 1
            nxt = refs(table[cur])
            # 只跟「单引用链」——多引用是复合值，不算链式环
            if len(nxt) == 1 and nxt[0] in table:
                cur = nxt[0]
                if cur in seen:
                    cycles.append(f'{label}: {" -> ".join(seen[seen.index(cur):] + [cur])}')
                    break
                seen.append(cur)
            else:
                break
    return cycles


# 自引用 fallback 检测（同一个 var() 里主引用 == fallback 引用）
SELF = re.compile(r'var\(\s*(--[a-z0-9-]+)\s*,\s*var\(\s*\1\s*[,)]')


lines = []
lines.append('R3 安全检查：var() 引用图')
lines.append('=' * 60)
lines.append('')
lines.append('— 深色侧链式环 —')
c1 = find_cycles(D, 'dark')
lines.append('\n'.join(c1) if c1 else '（无）')
lines.append('')
lines.append('— 浅色侧链式环 —')
c2 = find_cycles(LT, 'light')
lines.append('\n'.join(c2) if c2 else '（无）')
lines.append('')
lines.append('— 自引用 fallback（`var(--x, var(--x))`）—')
selfs = []
for n, v in sorted(D.items()):
    if SELF.search(v):
        selfs.append(f'{n}: {v}')
for n, v in sorted(LT.items()):
    if SELF.search(v):
        selfs.append(f'[light] {n}: {v}')
lines.append('\n'.join(selfs) if selfs else '（无）')
lines.append('')
lines.append('— R3 新增 dsw -> nm 边（确认没有 nm -> dsw -> nm 环）—')
edges = []
for n, v in sorted(D.items()):
    if n.startswith('--dsw-') and v.startswith('var(--nm-'):
        tgt = refs(v)[0] if refs(v) else '?'
        back = refs(D.get(tgt, ''))
        edges.append(f'{n} -> {tgt}   (nm 侧回指: {back if back else "无"})')
lines.append('\n'.join(edges))

out = r'D:\super-time-wechat\tools\_r3_cycles.txt'
open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('dark cycles:', len(c1), ' light cycles:', len(c2), ' self-ref:', len(selfs))
print('written', out)
