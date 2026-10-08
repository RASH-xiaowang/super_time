/**
 * 后端 RPC 通道的超时与死亡收敛，以及长任务名单与 gateway 的一致性。
 *
 * 这些分支原先只能靠手工 taskkill 观察（逻辑住在 Electron 主进程里），
 * 抽到 src/backend/backend-rpc.js 后用假 child 就能确定性覆盖。
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { gatewayClassSource } from './gateway-source.ts'// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { callTimeoutFor, createWorkerChannel, LONG_CALL_METHODS } from '../backend-rpc.js'

/** 最小的 utilityProcess 替身：能收能发能被杀。 */
class FakeChild extends EventEmitter {
  posted: Array<{ id: number; type: string; payload: unknown }> = []
  killed = false
  throwOnPost = false

  postMessage(msg: { id: number; type: string; payload: unknown }): void {
    if (this.throwOnPost) throw new Error('post failed: 进程已退出')
    this.posted.push(msg)
  }

  kill(): void { this.killed = true }

  /** 回包（value 形式）。 */
  reply(id: number, value: unknown): void { this.emit('message', { id, value }) }
  /** 回包（error 形式）。 */
  replyError(id: number, message: string): void { this.emit('message', { id, error: { message } }) }
  /** 进程退出。 */
  exit(code = 1): void { this.emit('exit', code) }
}

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} }

function makeChannel(timeoutMs = 30, extra: Record<string, unknown> = {}) {
  const child = new FakeChild()
  const channel = createWorkerChannel(child, {
    callTimeoutMs: timeoutMs,
    longTimeoutMs: timeoutMs * 10,
    logger: silentLogger,
    ...extra,
  })
  return { child, channel }
}

/**
 * 【长任务台账】`LONG_CALL_METHODS` 的**逐条分类**，用来补上原先缺失的那个方向。
 *
 * 原守卫只查一个方向：名单里的名字必须是真 `@Remote`（防写错名字后静默退化）。
 * 反过来「一个真该进名单的重方法**漏登记**了」**没有任何东西会报错** —— 它悄悄退回
 * 60s 默认窗口，直到线上某次大请求被误杀成「调用超时」才暴露，而那时界面看到的是
 * 「整批失败」，很难联想到是超时窗口的问题。
 *
 * laya 就是这样漏掉的：模型装好了、`configuredDir()` 也对，但
 * `analyzeVisibleMessages` 实测**单次 54,103ms** 对着 60s 窗口只有 1.1 倍余量
 * （PERF-AUDIT 日志口径：均 36s / 峰值 110s）⇒ 稍大的可见窗口必被误杀。
 *
 * 因此这里拿它当**全量台账**：名单必须与下表**完全相等**，增删都得先分类。
 * 只断言 `size >= N` 是形同虚设的下限（实际值远高于 N，塌陷也越不过）——
 * 所以每一条都点出**具体方法名**，并写清「为什么它算重活」。
 */
const HEAVY_LEDGER: ReadonlyArray<{ why: string; methods: readonly string[] }> = [
  { why: '导出：大量写盘 + 压缩', methods: ['exportSessionMessages', 'exportCsv', 'exportAnnualReport', 'exportAllSessions', 'exportMoments', 'exportSnsVideo'] },
  { why: '备份与恢复：整库拷贝', methods: ['createBackup', 'createEncryptedBackup', 'restoreBackup', 'previewBackup', 'deleteBackup'] },
  { why: '解密：全量读 + 写', methods: ['decryptAllDatabases', 'decryptAllImages', 'autoGetDbKey', 'autoGetImageKey'] },
  { why: '升级解码缓存：扫 msg/attach（数万文件）+ 逐条重解', methods: ['upgradeDecodedImages'] },
  { why: '媒体取数：命中不了缓存时退化成全量「读文件 + 解密 + 哈希」（实测 12–21s）', methods: ['getSnsImageDataUrl', 'getSnsVideoCoverDataUrl', 'getSnsVideoDataUrl', 'getArticleCover', 'getImageDataUrl', 'getFileImageDataUrl', 'getEmoticonDataUrl', 'getImageOriginal'] },
  { why: '批量封面（A1）：N 张 × 两次 20s 超时串在一个窗口里', methods: ['getArticleCovers'] },
  { why: '批量取图（P3-12）：一次 200 张，每张都可能退化成读+解密+哈希', methods: ['getImageDataUrlsBatch'] },
  { why: '批量取原图：几千张 × 15s 超时 + 4 并发，远超 60s', methods: ['fetchOriginalImagesBatch'] },
  { why: '语音转写：whisper 本地推理', methods: ['transcribeVoiceBatch', 'transcribeVoiceMessage'] },
  { why: 'laya 本地决策推理：实测单次 54,103ms / 峰值 110s（2026-09-28 补登记）', methods: ['analyzeMessages', 'analyzeVisibleMessages'] },
  { why: 'laya 模型分发：1.26 GB 流式下载 / 1.23 GB 跨盘接管（2026-09-28 补登记）', methods: ['downloadLayaModel', 'adoptLayaModel'] },
  { why: '索引与离线评估', methods: ['buildSearchIndex', 'buildRagVectorIndex', 'buildKbVectorIndex', 'evaluateRetrieval'] },
  { why: 'LLM 长任务：仓库自身 LLM 超时 120s，RPC 窗口必须明显宽于它', methods: ['askWechat', 'optimizeAskQuestion', 'runSummaryTask', 'generateDailySummary', 'generatePeriodSummary', 'summarizeKbFile'] },
  { why: '实体抽取/链接建议：最多 20 个文件串行 LLM / 80 条 embedding', methods: ['extractKbEntities', 'suggestKbLinks'] },
  { why: '年度报告/回顾：跨全年聚合，且可能触发 LLM', methods: ['getAnnual', 'getAnnualReport', 'getAnnualReview'] },
  { why: '任务同步与抽取', methods: ['syncHandoffTasks', 'extractTasks'] },
]

describe('LONG_CALL_METHODS 与 gateway 的一致性', () => {
  // 直接从源码抽 @Remote 名单。写错方法名不会报任何错、只会让该方法静默退回 60s 窗口，
  // 而 60s 对导出/解密/LLM 这类任务明显不够 —— 必须由测试挡住。
  const gatewaySrc = gatewayClassSource()
  const remoteNames = new Set(
    [...gatewaySrc.matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1] as string),
  )

  it('gateway 里能抽到 @Remote 名单（防止正则失效后测试变成空转）', () => {
    expect(remoteNames.size).toBeGreaterThan(100)
  })

  it('长任务名单里每个名字都是真实存在的 @Remote 方法', () => {
    const bogus = [...LONG_CALL_METHODS].filter((m) => !remoteNames.has(m))
    expect(bogus).toEqual([])
  })

  it('【反向】台账必须与 LONG_CALL_METHODS 完全相等 —— 漏登记一个重方法不会有任何其它报错', () => {
    const ledger = HEAVY_LEDGER.flatMap((g) => [...g.methods])
    // 下限只是「防止台账被清空后这条断言变成空转」；真正的判据是下面两个差集。
    expect(ledger.length, '台账被清空了？').toBeGreaterThanOrEqual(45)
    expect(new Set(ledger).size, '台账里有重复条目').toBe(ledger.length)

    const missing = ledger.filter((m) => !LONG_CALL_METHODS.has(m)).sort()
    expect(missing, '这些重方法会静默退回 60s 窗口，线上被 RPC 误杀成「调用超时」').toEqual([])

    const unclassified = [...LONG_CALL_METHODS].filter((m) => !ledger.includes(m)).sort()
    expect(unclassified, '新增的长任务没有写进台账分类（说明它为什么算重活）').toEqual([])
  })

  it('【反向】台账点名的方法都必须是真实存在的 @Remote（防点名打错字变成空转）', () => {
    const ledger = HEAVY_LEDGER.flatMap((g) => [...g.methods])
    expect(ledger.filter((m) => !remoteNames.has(m))).toEqual([])
  })

  it('LLM 长任务拿到宽窗口，普通查询拿到默认窗口', () => {
    // 仓库自身 LLM 超时默认 120s（wechat-host.js），RPC 窗口必须宽于它。
    expect(callTimeoutFor('askWechat', { callTimeoutMs: 60_000, longTimeoutMs: 600_000 })).toBe(600_000)
    expect(callTimeoutFor('runSummaryTask', { callTimeoutMs: 60_000, longTimeoutMs: 600_000 })).toBe(600_000)
    expect(callTimeoutFor('getSessions', { callTimeoutMs: 60_000, longTimeoutMs: 600_000 })).toBe(60_000)
  })
})

describe('createWorkerChannel · 正常路径', () => {
  it('回包后 resolve，并携带同一个 id', async () => {
    const { child, channel } = makeChannel()
    const p = channel.call('getSessions', [])
    expect(child.posted).toHaveLength(1)
    expect(child.posted[0]?.type).toBe('call')
    child.reply(child.posted[0]!.id, { items: [1, 2] })
    await expect(p).resolves.toEqual({ items: [1, 2] })
    expect(channel.pendingCount).toBe(0)
  })

  it('error 形式回包转成 reject', async () => {
    const { child, channel } = makeChannel()
    const p = channel.call('boom', [])
    child.replyError(child.posted[0]!.id, '数据库打不开')
    await expect(p).rejects.toThrow('数据库打不开')
    expect(channel.pendingCount).toBe(0)
  })

  it('事件消息转给 onEvent，且 onEvent 抛异常不影响后续回包', async () => {
    const seen: Array<[string, unknown]> = []
    const { child, channel } = makeChannel(30, {
      onEvent: (name: string, args: unknown) => {
        seen.push([name, args])
        throw new Error('订阅方炸了')
      },
    })
    child.emit('message', { type: 'event', name: 'wechat-data/updated', args: [1] })
    expect(seen).toEqual([['wechat-data/updated', [1]]])
    const p = channel.call('getSessions', [])
    child.reply(child.posted[0]!.id, 'ok')
    await expect(p).resolves.toBe('ok')
  })
})

describe('createWorkerChannel · 超时', () => {
  it('永不回包时按窗口 reject，信息含「调用超时」与方法名', async () => {
    const { channel } = makeChannel(30)
    const err = await channel.call('getSnsImageDataUrl', []).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('调用超时')
    expect(err!.message).toContain('getSnsImageDataUrl')
  })

  it('超时后在途数回落为 0（不会一直占着 id）', async () => {
    const { channel } = makeChannel(20)
    const p = channel.call('slow', []).catch(() => undefined)
    expect(channel.pendingCount).toBe(1)
    await p
    expect(channel.pendingCount).toBe(0)
  })

  it('迟到的回包被丢弃：只 settle 一次，也不产生二次 reject', async () => {
    const { child, channel } = makeChannel(20)
    const settled: string[] = []
    const p = channel.call('slow', []).then(
      () => { settled.push('resolved') },
      () => { settled.push('rejected') },
    )
    await p
    // 超时之后再回包：必须被静默丢弃
    child.reply(child.posted[0]!.id, 'too-late')
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toEqual(['rejected'])
    expect(channel.pendingCount).toBe(0)
  })

  it('长任务方法用更宽的窗口（callTimeoutFor）', () => {
    expect(callTimeoutFor('exportAllSessions', { callTimeoutMs: 1000, longTimeoutMs: 9000 })).toBe(9000)
    expect(callTimeoutFor('getSessions', { callTimeoutMs: 1000, longTimeoutMs: 9000 })).toBe(1000)
  })

  it('毫秒级窗口的提示写成毫秒而非「0 秒」', async () => {
    const { channel } = makeChannel(1)
    const err = await channel.call('tiny', []).then(() => null, (e: Error) => e)
    expect(err!.message).toContain('1 毫秒')
  })
})

describe('createWorkerChannel · 进程死亡', () => {
  it('在途请求以退出原因 reject，且 onExit 被调用一次', async () => {
    const onExit = vi.fn()
    const { child, channel } = makeChannel(5000, { onExit })
    const p = channel.call('getSessions', [])
    child.exit(7)
    await expect(p).rejects.toThrow('已退出')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0]?.[0]).toBe(7)
    expect(channel.pendingCount).toBe(0)
    expect(channel.isDead).toBe(true)
  })

  it('重复的 exit 事件只处理一次', async () => {
    const onExit = vi.fn()
    const { child, channel } = makeChannel(5000, { onExit })
    channel.call('x', []).catch(() => undefined)
    child.exit(1)
    child.exit(1)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('死亡后的新调用立刻 reject，不进入 pending', async () => {
    const { child, channel } = makeChannel(5000)
    child.exit(0)
    await expect(channel.call('anything', [])).rejects.toThrow('已退出')
    expect(channel.pendingCount).toBe(0)
  })

  it('postMessage 抛错（进程刚死）时立即 reject 且不留 pending', async () => {
    const { child, channel } = makeChannel(5000)
    child.throwOnPost = true
    await expect(channel.call('getSessions', [])).rejects.toThrow('post failed')
    expect(channel.pendingCount).toBe(0)
  })

  it('dispose 先发 dispose 消息再 kill', () => {
    const { child, channel } = makeChannel()
    channel.dispose()
    expect(child.posted.some((m) => m.type === 'dispose')).toBe(true)
    expect(child.killed).toBe(true)
  })
})
