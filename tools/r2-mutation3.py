# -*- coding: utf-8 -*-
"""R2e 收口变异：证明「--nm-cyan-70 加进 LADDER」这一条守卫真的有约束力。

三个变异（每个必须变红，且逐字节还原）：
  M1 把 --nm-cyan-70 的深色值改成 0.71（与档位名不符） → theme-alpha-ladder 应红
  M2 把 --nm-cyan-70 从 scifi-theme.css 的 :root 里删掉      → 阶梯完整性应红
  M3 把 --nm-cyan-70 的浅色覆盖删掉                          → 浅色覆盖应红

判红**看退出码**，不看输出文本。
"""
import os
import subprocess
import sys

ROOT = r'D:\super-time-wechat'
NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
VITEST = os.path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

DARK = os.path.join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages',
                    'wechat-data', 'scifi-theme.css')
LIGHT = os.path.join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages',
                     'wechat-data', 'light-theme.css')
SPEC = ('src/client/ui-wechat/src/client/pages/wechat-data/theme-alpha-ladder.spec.ts')

MUTATIONS = [
    ('M1 cyan-70 深色值改性为 0.71（与档位名不符）',
     DARK, b'--nm-cyan-70:        rgba(0, 240, 255, 0.70);',
     b'--nm-cyan-70:        rgba(0, 240, 255, 0.71);'),
    ('M2 从 :root 删掉 --nm-cyan-70 声明',
     DARK, b'  --nm-cyan-70:        rgba(0, 240, 255, 0.70);\n',
     b''),
    ('M3 删掉 --nm-cyan-70 的浅色覆盖',
     LIGHT, b'  --nm-cyan-70: rgba(8, 145, 178, 0.55);\n',
     b''),
]


def run_spec():
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['CODEBUDDY_SAFE_DELETE_ENABLED'] = '0'
    r = subprocess.run(
        f'"{NODE}" "{VITEST}" run "{SPEC}" --maxWorkers=1 --no-file-parallelism',
        cwd=ROOT, capture_output=True, env=env, shell=True, timeout=900)
    return r.returncode


def main():
    lines = ['R2e 收口变异报告', '=' * 60]
    ok = 0
    for name, path, old, new in MUTATIONS:
        raw = open(path, 'rb').read()
        cnt = raw.count(old)
        if cnt != 1:
            lines.append(f'{name}\n  → SKIP 锚点命中 {cnt} 次（必须恰好 1 次）')
            continue
        try:
            open(path, 'wb').write(raw.replace(old, new, 1))
            rc = run_spec()
            verdict = 'RED-OK' if rc != 0 else 'GREEN-BAD（守卫没咬住）'
            if rc != 0:
                ok += 1
        finally:
            open(path, 'wb').write(raw)
        restored = open(path, 'rb').read() == raw
        lines.append(f'{name}\n  → {verdict} rc={rc} restore={"OK" if restored else "FAIL"}')
    lines.append('')
    lines.append(f'RED-OK {ok}/{len(MUTATIONS)}')
    out = os.path.join(ROOT, 'tools', '_mut_r2e_report.txt')
    open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print(f'RED-OK {ok}/{len(MUTATIONS)} -> {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
