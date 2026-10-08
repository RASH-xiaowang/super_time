# -*- coding: utf-8 -*-
"""R3 变异：证明新守卫咬得住。

M1 复原 bg-1 环（nm 侧改回「优先取 dsw」）      -> theme.spec 环检测应红
M2 dsw 侧再写一遍裸色（去掉转发）               -> dsw-alias-tokens 应红
M3 转发目标指错（brand-primary -> nm-cyan）     -> dsw-alias-tokens 应红
M4 浅色侧重新加回 dsw 覆盖                      -> dsw-alias-tokens 应红
M5 造一个自引用 fallback                        -> theme.spec 应红
M6 例外清单加一条不存在的令牌                   -> dsw-alias-tokens 应红

判红**看退出码**；每处逐字节还原。
"""
import os
import subprocess
import sys

ROOT = r'D:\super-time-wechat'
NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
VITEST = os.path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

R = os.path.join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
DARK = os.path.join(R, 'scifi-theme.css')
LIGHT = os.path.join(R, 'light-theme.css')
SPEC_D = 'src/client/ui-wechat/src/client/pages/wechat-data/dsw-alias-tokens.spec.ts'
SPEC_T = 'src/client/ui-wechat/src/client/pages/wechat-data/theme.spec.ts'

MUT = [
    ('M1 复原 var() 环（nm-bg-1 改回优先取 dsw）', SPEC_T, DARK,
     b'  --nm-bg-1:          #0b1220;',
     b'  --nm-bg-1:          var(--dsw-alias-bg-layer-1, #0b1220);'),
    ('M2 dsw 侧去掉转发、写回裸色', SPEC_D, DARK,
     b'  --dsw-alias-brand-primary: var(--nm-brand, #00f0ff);',
     b'  --dsw-alias-brand-primary: #00f0ff;'),
    ('M3 转发目标指错（brand -> cyan）', SPEC_D, DARK,
     b'  --dsw-alias-brand-primary: var(--nm-brand, #00f0ff);',
     b'  --dsw-alias-brand-primary: var(--nm-cyan, #00f0ff);'),
    ('M4 浅色侧加回 dsw 覆盖', SPEC_D, LIGHT,
     b'  --nm-map-land: #cbd5e1;',
     b'  --nm-map-land: #cbd5e1;\n  --dsw-alias-link: #0369a1;'),
    ('M5 造自引用 fallback', SPEC_T, DARK,
     b'  --nm-bg-1:          #0b1220;',
     b'  --nm-bg-1:          var(--dsw-alias-bg-layer-1, var(--nm-bg-1));'),
    ('M6 例外清单放一条不存在的令牌', SPEC_D, DARK,
     b'  --nm-map-land: rgba(8, 40, 60, 0.90);',
     b'  --nm-map-land: rgba(8, 40, 60, 0.90);\n  --dsw-alias-nonexistent: #123456;'),
]


def run(spec):
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['CODEBUDDY_SAFE_DELETE_ENABLED'] = '0'
    r = subprocess.run(
        f'"{NODE}" "{VITEST}" run "{spec}" --maxWorkers=1 --no-file-parallelism',
        cwd=ROOT, capture_output=True, env=env, shell=True, timeout=900)
    return r.returncode


def main():
    lines = ['R3 变异报告', '=' * 60]
    ok = 0
    for name, spec, path, old, new in MUT:
        raw = open(path, 'rb').read()
        cnt = raw.count(old)
        if cnt != 1:
            lines.append(f'{name}\n  → SKIP 锚点命中 {cnt} 次')
            continue
        try:
            open(path, 'wb').write(raw.replace(old, new, 1))
            rc = run(spec)
            verdict = 'RED-OK' if rc != 0 else 'GREEN-BAD（守卫没咬住）'
            if rc != 0:
                ok += 1
        finally:
            open(path, 'wb').write(raw)
        restored = open(path, 'rb').read() == raw
        lines.append(f'{name}\n  → {verdict} rc={rc} restore={"OK" if restored else "FAIL"}')
    lines.append('')
    lines.append(f'RED-OK {ok}/{len(MUT)}')
    out = os.path.join(ROOT, 'tools', '_mut_r3_report.txt')
    open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print(f'RED-OK {ok}/{len(MUT)} -> {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
