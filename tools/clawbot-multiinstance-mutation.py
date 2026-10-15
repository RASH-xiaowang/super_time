# -*- coding: utf-8 -*-
"""M2（多微信 ClawBot 并行管理 · Remote 面与多实例装配）变异自证。

每条变异：改一处源码 → 跑目标规格 → 期望**断言失败**（RED-OK）→ 逐字节还原（sha256 校验）。
判据分三类：
  RED-OK      —— 规格以 AssertionError 变红（守卫真的咬住了）；
  MISS        —— 规格仍绿（守卫没咬住 ⇒ 必须补断言）；
  ILLEGAL     —— 失败但不是断言（类型/语法错误 ⇒ 这是假咬，判据本身无效）。

用法：python tools/clawbot-multiinstance-mutation.py
"""
import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get('SUPERTIME_NODE', 'node')
VITEST = 'node_modules/vitest/vitest.mjs'
TSC = 'node_modules/typescript/bin/tsc'

SRC = ROOT / 'src' / 'backend' / 'wechat-data' / 'src'
TESTS = ROOT / 'src' / 'backend' / 'wechat-data' / 'tests'
CLIENT = ROOT / 'src' / 'client' / 'ui-wechat' / 'src' / 'client' / 'pages' / 'wechat-data'

F_REMOTES = SRC / 'remotes' / 'clawbot.ts'
F_INSTANCE = SRC / 'query' / 'clawbot-instance.ts'
F_GATEWAY = SRC / 'gateway-clawbot.ts'
F_HOMEPAGE = ROOT / 'src' / 'client' / 'ui-app' / 'onboarding' / 'pages' / 'HomePage.tsx'

S_MULTI = 'src/backend/wechat-data/tests/clawbot-instance-remote.spec.ts'
S_SURFACE = 'src/backend/wechat-data/tests/clawbot-remote-surface.spec.ts'
S_CONTRACT = 'src/backend/wechat-data/tests/remote-contract.spec.ts'
S_DOCS = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/docs-consistency.wiring.spec.ts'


def sha256(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def run(cmd, timeout=600):
    env = dict(os.environ)
    env['CODEBUDDY_SAFE_DELETE_ENABLED'] = '0'
    r = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout, env=env)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def run_spec(files):
    return run([NODE, VITEST, 'run', *files, '--maxWorkers=1', '--no-file-parallelism'])


def classify(code, out):
    if 'AssertionError' in out:
        return 'RED-OK'
    if code != 0 or ' failed' in out:
        return 'ILLEGAL'
    return 'MISS'


# ── 变异表：(名字, 文件, 原文, 变异后, 跑哪些 spec, 期望咬住的命题) ─────────────────
MUTATIONS = [
    ('M1 缺省 slot 不再优先「已绑定」', F_INSTANCE,
     "  const first = bindings.find((b) => b.status === 'bound') ?? bindings[0]",
     "  const first = bindings[0]",
     [S_MULTI], '缺省落到从未绑定的默认实例 ⇒ 会话/发送指向没有身份的号'),
    ('M2 显式 slot 被忽略（一律走缺省）', F_INSTANCE,
     "  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 1) {\n    return Math.floor(requested)\n  }",
     "  if (requested === 0) {\n    return 0\n  }",
     [S_MULTI], '显式指定被吞掉 ⇒ 用户选的实例被换成别的（最危险的串号来源）'),
    ('M3 显式 slot 的合法性门槛被抬高', F_INSTANCE,
     "&& requested >= 1) {",
     "&& requested >= 100) {",
     [S_MULTI], '合法的小编号被当成缺省 ⇒ 落点不是用户选的那个实例'),
    ('M4 入站落库忽略实例（写死 slot 1）', F_REMOTES,
     "        const inserted = insertClawbotMessages(decrypted(), slot, msgs)",
     "        const inserted = insertClawbotMessages(decrypted(), 1, msgs)",
     [S_MULTI], '两个号的入站消息落进同一条会话（通道隔离形同虚设）'),
    ('M5 发送忽略实例（写死 slot 1）', F_REMOTES,
     "      const result = await sendClawbotText(dir(), ilink, options, slotOf(options))",
     "      const result = await sendClawbotText(dir(), ilink, options, 1)",
     [S_MULTI], '发送用错实例的凭证与令牌 ⇒ 消息发到另一个号'),
    ('M6 解绑忽略实例（写死 slot 1）', F_REMOTES,
     "      const slot = slotOf(options)\n      // 只停**已建**的通道：解绑一个从没跑过的实例不该凭空建出通道对象。",
     "      const slot = 1\n      // 只停**已建**的通道：解绑一个从没跑过的实例不该凭空建出通道对象。",
     [S_MULTI], '解绑 A 号把 B 号也解了'),
    ('M7 自检读固定实例的通道', F_REMOTES,
     "      const slot = slotOf(options)\n      const { binding } = readBinding(dir(), slot)\n      const st = channelInfo(slot)",
     "      const slot = slotOf(options)\n      const { binding } = readBinding(dir(), 1)\n      const st = channelInfo(1)",
     [S_MULTI], '自检报告的通道状态不是目标实例的（界面显示假绿/假红）'),
    ('M8 会话检索忽略实例（不带 slot）', F_REMOTES,
     "      return queryClawbotMessages(dir(), { ...options, slot: slotOf(options) })",
     "      return queryClawbotMessages(dir(), { ...options, slot: 1 })",
     [S_MULTI], '默认会话列表不按实例过滤 ⇒ 读到的是默认实例（或全库）'),
    ('M9 kbId 非正数被夹成 1', F_REMOTES,
     "        patch.kbId = options.kbId === null || !Number.isFinite(options.kbId) || options.kbId <= 0\n          ? null\n          : Math.floor(options.kbId)",
     "        patch.kbId = options.kbId === null ? null : Math.max(Math.floor(options.kbId), 1)",
     [S_MULTI], '替用户悄悄选了一个他没选的知识库'),
    ('M10 删除实例不删该实例的会话', F_REMOTES,
     "      const { removedMessages } = deleteInstanceRow(decrypted(), slot)",
     "      deleteInstanceRow(decrypted(), slot)\n      const removedMessages = 0",
     [S_MULTI], '删除实例时不报/不删会话 ⇒ 界面确认框说不清删了什么'),
    ('M11 新建实例用 MAX(slot)+1（编号复用）', F_INSTANCE,
     "    const ins = db.prepare('INSERT INTO clawbot_binding(slot, status, created_at, updated_at) VALUES (?, ?, ?, ?)')\n      .run(DEFAULT_CLAWBOT_SLOT, 'unbound', now, now)\n    const id = Number(ins.lastInsertRowid)\n    db.prepare('UPDATE clawbot_binding SET slot = ? WHERE id = ?').run(id, id)",
     "    const maxSlot = Number((db.prepare('SELECT COALESCE(MAX(slot), 0) AS m FROM clawbot_binding').get() as { m?: number }).m ?? 0)\n    const id = maxSlot + 1\n    db.prepare('INSERT INTO clawbot_binding(id, slot, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id, 'unbound', now, now)",
     [S_MULTI, 'src/backend/wechat-data/tests/clawbot-instance.spec.ts'], '删掉实例后编号被复用 ⇒ 新实例捡到上一个实例的配置与会话'),
    ('M12 游标不按实例分（写死 slot 1）', F_REMOTES,
     "      saveBuf: (buf) => { saveSyncBuf(decrypted(), buf, slot) },",
     "      saveBuf: (buf) => { saveSyncBuf(decrypted(), buf, 1) },",
     [S_MULTI], '两个号共用一条游标 ⇒ 一个号把另一个号的进度当自己的（漏消息）'),
    ('M13 实例列表不注入真实通道状态（恒未运行）', F_REMOTES,
     "    const st = channels.get(slot)?.state()\n    return st === undefined ? { running: false, error: null } : { running: st.running, error: st.lastError }",
     "    return { running: false, error: null }",
     [S_MULTI], '列表永远显示「未运行」⇒ 用户以为收不到消息'),
    ('M14 gateway 少一个壳（listClawbotInstances）', F_GATEWAY,
     "  @Remote('listClawbotInstances')",
     "",
     [S_SURFACE, S_CONTRACT], '方法面少一个壳 ⇒ 协议层枚举不到，界面按钮打了没反应'),
    ('M15 前端镜像缺一个方法声明', CLIENT / 'api-core.ts',
     "  listClawbotInstances(): Promise<RemoteResult<ClawbotInstancesSnapshot>>",
     "  // 变异：前端镜像缺 listClawbotInstances",
     [S_CONTRACT], '前后端方法面对不上（前端会拿到 undefined 的函数）'),
    ('M16 启动页计数漂回旧值', F_HOMEPAGE,
     "{ k: 'REMOTE API', v: '192', h:",
     "{ k: 'REMOTE API', v: '188', h:",
     [S_DOCS], '手写计数与 docs/API.md 漂移'),
]

# ── 闸门活性：塞一个类型错误必须让 tsc 失败（否则「变红」判据不知真假） ──
GATE_PROBE = (F_INSTANCE,
              "export function resolveClawbotSlot(",
              "export function resolveClawbotSlot(\n  __probe__: number,")


def main():
    results = []
    restore_ok = True

    for name, path, old, new, specs, claim in MUTATIONS:
        raw = Path(path).read_bytes()
        before = hashlib.sha256(raw).hexdigest()
        text = raw.decode('utf-8')
        n = text.count(old)
        if n != 1:
            results.append((name, 'ANCHOR', '锚点命中 %d 次（变异表过期）' % n, claim))
            continue
        Path(path).write_bytes(text.replace(old, new, 1).encode('utf-8'))
        try:
            code, out = run_spec(specs)
            verdict = classify(code, out)
        finally:
            Path(path).write_bytes(raw)
        after = sha256(path)
        if after != before:
            restore_ok = False
            verdict = 'RESTORE-BROKEN'
        results.append((name, verdict, '', claim))

    # 闸门活性：类型错误必须让 tsc 非零退出
    raw = Path(GATE_PROBE[0]).read_bytes()
    text = raw.decode('utf-8')
    n = text.count(GATE_PROBE[1])
    gate_verdict = 'ANCHOR'
    if n == 1:
        Path(GATE_PROBE[0]).write_bytes(text.replace(GATE_PROBE[1], GATE_PROBE[2], 1).encode('utf-8'))
        try:
            code, _out = run([NODE, TSC, '-p', 'src/backend/wechat-data/tsconfig.json', '--noEmit'])
            gate_verdict = 'ACTIVE' if code != 0 else 'DEAD'
        finally:
            Path(GATE_PROBE[0]).write_bytes(raw)
        if sha256(GATE_PROBE[0]) != hashlib.sha256(raw).hexdigest():
            restore_ok = False

    # 基线复跑（还原之后必须全绿）
    code, out = run_spec([S_MULTI, S_SURFACE, S_CONTRACT, S_DOCS])
    baseline = 'GREEN' if code == 0 else 'RED'

    lines = []
    lines.append('%-52s %-10s %s' % ('变异', '判定', '它该咬住的命题'))
    lines.append('-' * 120)
    for name, verdict, extra, claim in results:
        lines.append('%-52s %-10s %s%s' % (name, verdict, claim, ('  | ' + extra) if extra else ''))
    lines.append('-' * 120)
    lines.append('tsc 闸门活性: %s（塞类型错误 ⇒ 必须让 tsc 非零）' % gate_verdict)
    lines.append('逐字节还原: %s' % ('OK' if restore_ok else 'FAILED'))
    lines.append('基线复跑: %s' % baseline)
    red = sum(1 for _, v, _, _ in results if v == 'RED-OK')
    bad = [n for n, v, _, _ in results if v in ('MISS', 'ILLEGAL', 'ANCHOR', 'RESTORE-BROKEN')]
    lines.append('结果: %d/%d RED-OK；异常项: %s' % (red, len(results), ', '.join(bad) if bad else '无'))

    report = '\n'.join(lines)
    (ROOT / 'working' / 'clawbot-multiinstance-mutation.txt').write_text(report, encoding='utf-8')
    print(report)
    return 0 if (not bad and gate_verdict == 'ACTIVE' and restore_ok and baseline == 'GREEN') else 1


if __name__ == '__main__':
    sys.exit(main())
