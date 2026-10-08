# -*- coding: utf-8 -*-
"""R4 变异：证明 state-components 守卫咬得住。

M1 ErrorState 去掉 role="alert"
M2 ErrorState 不用 css.error 改裸类名
M3 LoadingState 改回 emptyInline
M4 某面板恢复自定义 .error
M5 某面板 error 渲染漏 role="alert"
M6 某加载态改回 emptyInline（非白名单）
M7 删掉 Privacy 的 ProgressBar

判红**看退出码**；每处逐字节还原。
"""
import os
import subprocess

ROOT = r'D:\super-time-wechat'
NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
VITEST = os.path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

R = os.path.join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
KITF = os.path.join(R, 'ui', 'kit-fields.tsx')
ASSET = os.path.join(R, 'panels', 'AssetInsights.tsx')
CALLS = os.path.join(R, 'panels', 'Calls.tsx')
PRIV = os.path.join(R, 'panels', 'Privacy.tsx')
PTRUST = os.path.join(R, 'panels', 'PrivacyTrust.tsx')
CSS = os.path.join(R, 'panels', 'daily-summary.module.css')

SPEC = 'src/client/ui-wechat/src/client/pages/wechat-data/ui/state-components.wiring.spec.ts'

E = lambda s: s.encode('utf-8')

MUT = [
    ('M1 ErrorState 去掉 role="alert"', KITF,
     E('    <div className={css.error} role="alert" data-st-error="1">'),
     E('    <div className={css.error} data-st-error="1">')),
    ('M2 ErrorState 不用 kit 的 .error', KITF,
     E('    <div className={css.error} role="alert" data-st-error="1">'),
     E('    <div className={css.errBox} role="alert" data-st-error="1">')),
    ('M3 LoadingState 改回 emptyInline', KITF,
     E('      <div className={css.loadingLabel} role="status">{label}{suffix}</div>'),
     E('      <div className={css.emptyInline} role="status">{label}{suffix}</div>')),
    ('M4 面板恢复自定义 .error', CSS,
     E('/* 面板根：变量 + 深空氛围 */'),
     E('.error { color: red; }\n\n/* 面板根：变量 + 深空氛围 */')),
    ('M5 面板 error 渲染退回空态样式', PTRUST,
     E('        {error && <ErrorState message={error} />}'),
     E('        {error && <div className={kitCss.emptyInline}>{error}</div>}')),
    ('M6 加载态改回 emptyInline（非白名单）', CALLS,
     E('      {loading && !snap && <LoadingState variant="compact" label="正在扫描消息库…" />}'),
     E('      {loading && !snap && <div className={kitCss.emptyInline}>正在扫描消息库…</div>}')),
    ('M7 删掉 Privacy 的 ProgressBar', PRIV,
     E('          <ProgressBar value={0} indeterminate />\n'),
     E('')),
]


def run():
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['CODEBUDDY_SAFE_DELETE_ENABLED'] = '0'
    r = subprocess.run(
        f'"{NODE}" "{VITEST}" run "{SPEC}" --maxWorkers=1 --no-file-parallelism',
        cwd=ROOT, capture_output=True, env=env, shell=True, timeout=900)
    return r.returncode


def main():
    lines = ['R4 变异报告', '=' * 60]
    allok = True
    for name, path, old, new in MUT:
        raw = open(path, 'rb').read()
        n = raw.count(old)
        if n != 1:
            lines.append(f'[SKIP] {name}: 锚点 {n} 次（应为 1）')
            allok = False
            continue
        try:
            open(path, 'wb').write(raw.replace(old, new))
            code = run()
        finally:
            open(path, 'wb').write(raw)
        restored = 'OK' if open(path, 'rb').read() == raw else '!!还原失败!!'
        verdict = 'RED-OK' if code != 0 else '!!GREEN 守卫没咬住!!'
        if code == 0:
            allok = False
        lines.append(f'[{verdict}] {name}  (exit={code}, 还原={restored})')
    lines.append('=' * 60)
    lines.append('全 RED-OK' if allok else '存在未咬住的变异（看上面）')
    out = '\n'.join(lines)
    open(os.path.join(ROOT, 'tools', '_r4_mut.txt'), 'w', encoding='utf-8').write(out)
    print('EXIT', 0 if allok else 1)


if __name__ == '__main__':
    main()
