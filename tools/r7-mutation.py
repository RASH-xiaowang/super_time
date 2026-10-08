"""
R7 守卫变异自证：dialog-a11y.wiring.spec.ts

纪律（沿用 r2/r3/r4/r6）：
  * 用**退出码**判红没红，不匹配输出文本（Windows 下 shell=True 走 cmd.exe）
  * 锚点必须**恰好命中 1 次**
  * 改完**逐字节还原**（read_bytes / write_bytes）
  * bytes 字面量不含非 ASCII（用 '…'.encode('utf-8')）

变异设计（R6 教训：哨兵要敏锐就得**点名**，所以 M2/M3 专门打点名表）：
  M1 删掉 chats-contact-info-view.tsx 的 useEscapeToClose 调用  → 必须红
  M2 删掉 chats-contact-info-view.tsx 的 data-st-dialog 属性    → 必须红
  M3 把点名表里 chats-viewer 那一行整行删掉（模拟「漏登记」）    → 必须红
  M4 把 chats-media.tsx 的 useEscapeToClose 换回自定义 keydown  → 必须红
  M5 chatlog 的 focusIn 从 chats-msg-search.tsx 改成错的文件名  → 必须红
"""
import subprocess, pathlib, sys

ROOT = pathlib.Path(r'D:\super-time-wechat')
SPEC = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/dialog-a11y.wiring.spec.ts'
CONTACT = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-contact-info-view.tsx'
MEDIA = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-media.tsx'

MUTS = [
    {
        'id': 'M1',
        'desc': '删掉 chats-contact-info-view 的 useEscapeToClose 调用',
        'file': CONTACT,
        'from': b"  useEscapeToClose(open, onClose)\n",
        'to': b"",
    },
    {
        'id': 'M2',
        'desc': '删掉 chats-contactinfo 的 data-st-dialog 属性',
        'file': CONTACT,
        'from': b'      data-st-dialog="chats-contactinfo"\n',
        'to': b"",
    },
    {
        'id': 'M3',
        'desc': '点名表里 chats-viewer 那行整行删掉（漏登记）',
        'file': SPEC,
        'from': b"  { name: 'chats-viewer', attrIn: 'chats-media.tsx', focusIn: 'chats-media.tsx', escIn: 'chats-media.tsx' },\n",
        'to': b"",
    },
    {
        'id': 'M4',
        'desc': 'chats-media 的 useEscapeToClose 换回自定义 keydown（游离于 escStack 之外）',
        'file': MEDIA,
        'from': b"  useEscapeToClose(!!item, onClose)\n",
        'to': '  /* mutated: esc no longer uses escStack */\n'.encode('utf-8'),
    },
    {
        'id': 'M5',
        'desc': 'chatlog 的 focusIn 指向错误文件（跨文件接线断链）',
        'file': SPEC,
        'from': b"focusIn: 'chats-msg-search.tsx', escIn: 'chats-msg-search.tsx' },\n  { name: 'chats-chatlog'",
        'to': b"focusIn: 'chats-NOPE.tsx', escIn: 'chats-msg-search.tsx' },\n  { name: 'chats-chatlog'",
        'allow_multi': False,
    },
]


def run_spec():
    cmd = ('cd /d "' + str(ROOT) + '" && node node_modules/vitest/vitest.mjs run "' + SPEC + '"')
    p = subprocess.run(cmd, shell=True, capture_output=True)
    return p.returncode


def main():
    lines = []
    ok = 0
    for m in MUTS:
        f = ROOT / m['file']
        raw = f.read_bytes()
        n = raw.count(m['from'])
        if n != 1:
            lines.append(f"[{m['id']}] SKIP 锚点命中 {n} 次（要求恰好 1 次）：{m['desc']}")
            continue
        mutated = raw.replace(m['from'], m['to'])
        if mutated == raw:
            lines.append(f"[{m['id']}] SKIP 替换后内容未变")
            continue
        try:
            f.write_bytes(mutated)
            rc = run_spec()
        finally:
            f.write_bytes(raw)
        back = f.read_bytes()
        restored = (back == raw)
        verdict = 'RED-OK ' if rc != 0 else 'GREEN!!  '
        if rc != 0:
            ok += 1
        lines.append(f"[{m['id']}] {verdict} exit={rc}  还原={'OK' if restored else 'FAIL'}  {m['desc']}")

    lines.append('')
    lines.append(f'结果：{ok}/{len(MUTS)} 条变异正确变红（RED-OK）')
    out = pathlib.Path(r'D:\super-time-wechat\working\_r7_mut.txt')
    out.write_text('\n'.join(lines), encoding='utf-8')
    print('\n'.join(lines))


main()
