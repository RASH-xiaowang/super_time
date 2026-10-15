// @vitest-environment node
/**
 * 逐条分析的**取消**行为回归（W3-11.5 后半）。
 *
 * 进度那一半解决「分不清在跑还是卡死」；取消解决「不敢切走」——
 * 均 36s / 峰值 110s 的一批，用户想换个面板看看都不行。
 *
 * 本文件钉七件事，分两层：
 *   **分析层（signal 语义）**
 *   ① 中途取消**不抛错**：返回 `canceled:true` + **已算完的那部分** items；
 *   ② 一开始就 aborted ⇒ 零 items、零次进度回调（被取消的那条压根没开始算）；
 *   ③ 进度回调的次数与 items 数**必须一致**（面板「已停止（算出 N/M）」的 N/M 就是这两个数，
 *      两者分叉就会出现「算出 5/12」而结果里只有 4 条这种自相矛盾）；
 *   ④ 不传 signal 时 `canceled` 这个键**根本不存在**（不是 false —— 那会让人以为有两种语义）。
 *   **网关层（槽位）**
 *   ⑤ 取消在飞的批次 → 命中；
 *   ⑥ 取消已结束的批次 → ok:false + 可读原因（点晚了要被告知，而不是假装成功）；
 *   ⑦ 槽位归还 + **两个 jobId 各占各的槽**（共用问答复用的那一格会让两件事互相取消）。
 *
 * 不依赖真实模型：`laya-fake` 稀疏文件让 `layaModelStatus` 判为「已装」，
 * 每条目标都走「取不到这条消息」这个**不推理**的逐条失败分支 —— 取消语义与推理无关。
 * 取消点用 `onProgress` 在第 N 条上 abort 精确指定（比 `sleep` 之类的时序假设稳）。
 */
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { analyzeVisibleMessages } from '../src/laya/analysis.ts'
import { LAYA_ASSETS } from '../src/laya/model-file.ts'
import { WechatDataGateway } from '../src/gateway.ts'

/**
 * 只在「模型下载」那条用例里生效的替身（默认透传真实实现）。
 *
 * 为什么必须是**顶层 hoisted** 的 `vi.mock`：`laya/model-file.ts` 是**静态** import
 * `streamUrlToFile` 的，写在用例里的 `vi.doMock` 赶在模块加载之后、根本不生效 ——
 * 第一版跑出来是「替身一次都没被调用」，看着像功能没实现。
 */
const dlMock = vi.hoisted(() => ({ active: false, calls: 0, finished: false }))
vi.mock('../src/query/whisper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/query/whisper.ts')>()
  return {
    ...actual,
    streamUrlToFile: async (
      url: string, dest: string, timeoutMs: number,
      onProgress: (r: number, t: number) => void, signal?: AbortSignal,
    ): Promise<number> => {
      if (!dlMock.active) return actual.streamUrlToFile(url, dest, timeoutMs, onProgress, signal)
      dlMock.calls += 1
      writeFileSync(dest, 'partial')
      for (let i = 1; i <= 5; i += 1) {
        if (signal?.aborted === true) {
          const e = new Error('操作已取消')
          e.name = 'AbortError'
          throw e
        }
        onProgress(i * 100, 500)
        await new Promise((r) => { setTimeout(r, 5) })
      }
      // 只有**整条流没被打断**才会走到这里。
      dlMock.finished = true
      return 500
    },
  }
})
import { createTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'

const workspaces: TempWorkspace[] = []
afterEach(async () => {
  for (const w of workspaces.splice(0, workspaces.length)) await w.cleanup()
  vi.unstubAllEnvs()
})

/**
 * 造一个「看起来已安装」的模型目录。
 *
 * `analyzeVisibleMessages` 在循环之前只查一遍文件是否存在/够不够大（`layaModelStatus`
 * 只 `statSync`，不加载），真的加载发生在第一次推理内部。所以只要四个必需文件都过下界，
 * 整批就会走到循环里 —— 而取消语义全在循环里，不需要真跑 ONNX。
 *
 * 四个下界合计 ~66MB（权重 64MB）。写 1 字节再 `truncate` 到下界：NTFS 把空洞当稀疏文件，
 * 实际占用只有几 KB；写满则是每次单测 66MB 的写盘。
 */
function makeFakeModelDir(root: string): void {
  const dir = join(root, 'laya')
  for (const asset of LAYA_ASSETS) {
    const p = join(dir, asset.rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'x')
    truncateSync(p, asset.minBytes)
  }
}

/** 造一条「消息库里什么都没有」的会话：每条目标都走「取不到这条消息」，不推理。 */
function makeEmptyTalker(w: TempWorkspace): { talker: string; modelDir: string } {
  mkdirSync(w.path(join('message')), { recursive: true })
  w.db(join('message', 'message_0.db')).close()
  // 模型目录必须在 <decryptedDir>/.. 下（`layaModelsDir` 就是这么取的），所以挂在 w.dir 上。
  makeFakeModelDir(w.dir)
  return { talker: 'wxid_empty_chat', modelDir: join(w.dir, 'laya') }
}

/** 造一个含 N 条目标的批（N ≤ MAX_ANALYZE_BATCH 由调用方保证）。 */
function targetsOf(n: number): Array<{ localId: number; sortSeq: number }> {
  return Array.from({ length: n }, (_, i) => ({ localId: 100 + i, sortSeq: i + 1 }))
}

/** 网关要用的最小 ctx：laya 这条路只需要 `emit`（进度事件）与 `_dirs`（环境变量）。 */
function makeCtx(): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: () => {},
  } as unknown as Context
}

describe('逐条分析的取消（分析层语义）', () => {
  it('中途取消：不抛错，带已算完的那部分，进度次数与 items 数一致', async () => {
    const w = createTempWorkspace('laya-cancel-mid')
    workspaces.push(w)
    const { talker, modelDir } = makeEmptyTalker(w)
    const ctl = new AbortController()
    const seen: number[] = []

    const r = await analyzeVisibleMessages({
      decryptedDir: w.dir, decodedDir: w.dir, talker, modelDir,
      targets: targetsOf(8), useCache: false,
      signal: ctl.signal,
      onProgress: (done) => { seen.push(done); if (done === 3) ctl.abort() },
    })

    // ① 不抛错（能走到这儿就是），且是「已停止」而不是「失败」。
    expect(r.error, '取消不许变成会话级错误（面板会显示成红色错误）').toBeUndefined()
    expect(r.canceled).toBe(true)
    // 只算到第 3 条：第 4 条开始前才发现 aborted，它**没有**被算过。
    expect(r.items.length).toBe(3)
    expect(r.items.map((i) => i.localId)).toEqual([100, 101, 102])
    // ③ 进度推进到第 3 条（被取消的那条不报 —— 否则面板会说 4/8 而结果只有 3 条）。
    expect(seen).toEqual([1, 2, 3])
    expect(seen.length, '进度次数与 items 数分叉 ⇒「算出 N/M」的 N 与 M 会自相矛盾').toBe(r.items.length)
  })

  it('一开始就 aborted：零 items、零次进度回调', async () => {
    const w = createTempWorkspace('laya-cancel-pre')
    workspaces.push(w)
    const { talker, modelDir } = makeEmptyTalker(w)
    const ctl = new AbortController()
    ctl.abort()
    let called = 0

    const r = await analyzeVisibleMessages({
      decryptedDir: w.dir, decodedDir: w.dir, talker, modelDir,
      targets: targetsOf(5), useCache: false,
      signal: ctl.signal,
      onProgress: () => { called += 1 },
    })
    expect(r.canceled).toBe(true)
    expect(r.items).toEqual([])
    expect(called, '被取消的那条压根没开始算，不该报进度').toBe(0)
  })

  it('不传 signal 时 canceled 这个键不存在（不是 false）', async () => {
    const w = createTempWorkspace('laya-cancel-none')
    workspaces.push(w)
    const { talker, modelDir } = makeEmptyTalker(w)
    const r = await analyzeVisibleMessages({
      decryptedDir: w.dir, decodedDir: w.dir, talker, modelDir,
      targets: targetsOf(3), useCache: false,
    })
    expect(r.error).toBeUndefined()
    expect(r.items.length).toBe(3)
    // 调用方可靠的判据是 `'canceled' in r`；给 `false` 会让「有没有这回事」变成两种语义。
    expect('canceled' in r, '没被取消时不该出现 canceled 键').toBe(false)
  })
})

describe('逐条分析的取消（网关层槽位）', () => {
  it('取消在飞的批次命中；已结束的批次如实说没命中；槽位归还；两个 jobId 各占各的槽', async () => {
    const w = createTempWorkspace('laya-cancel-gw')
    workspaces.push(w)
    // 网关这条路的模型目录是按**数据根**取的（`layaModelsDir` = dirname(decryptedDir)/laya），
    // 没有 modelDir 参数可传 —— 所以目录层级必须和数据根对上，否则会走「模型未就绪」早退，
    // 取消语义一条都测不到（第一版就是这么白跑的：槽还在、cancel 命中、结果却没 canceled）。
    const { talker } = makeEmptyTalker(w)
    const dec = join(w.dir, 'decrypted')
    mkdirSync(dec, { recursive: true })
    mkdirSync(join(dec, 'message'), { recursive: true })
    w.db(join('decrypted', 'message', 'message_0.db')).close()
    makeFakeModelDir(w.dir)
    vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', dec)
    vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(dec, 'decoded_images'))
    const gw = new WechatDataGateway(makeCtx())

    // ① 取消命中在飞的那一批：请求先开（槽在第一个 await 之前就登记好了），随后取消。
    const jobA = 'laya-cancel-a'
    const runningA = gw.analyzeVisibleMessages({ talker, targets: targetsOf(6), jobId: jobA })
    const hit = await gw.cancelLayaAnalysis({ jobId: jobA })
    expect(hit.ok, '在飞的批次必须被取消命中').toBe(true)
    const a = await runningA
    expect(a.error, '先确认没走「模型未就绪」早退（否则下面全是空断言）').toBeUndefined()
    expect(a.canceled ?? false, '取消后这一批应当以 canceled 收尾').toBe(true)

    // ② 对已经结束的批次取消：ok=false + 说清为什么（用户点晚了要被告知）。
    const late = await gw.cancelLayaAnalysis({ jobId: jobA })
    expect(late.ok).toBe(false)
    expect(late.message ?? '', '必须说清为什么没停掉').toContain('已经算完')

    // ③ 槽位归还：同一个 jobId 能再开一批（不归还的话这里会一直打到一枚没人等的控制器上）。
    const again = await gw.analyzeVisibleMessages({ talker, targets: targetsOf(3), jobId: jobA })
    expect(again.error).toBeUndefined()
    expect(again.items.length).toBe(3)

    // ④ 两个 jobId 互不相干：这是「为什么单独给分析开一格槽」的判据 ——
    //    共用问答复用的那一格的话，A 的取消会打到 B 那批上。
    const jobB = 'laya-cancel-b'
    const runningB = gw.analyzeVisibleMessages({ talker, targets: targetsOf(4), jobId: jobB })
    const miss = await gw.cancelLayaAnalysis({ jobId: 'laya-cancel-b-never-started' })
    expect(miss.ok, '不认识 / 没在跑的标识必须如实说没命中').toBe(false)
    const b = await runningB
    expect(b.canceled, '打空的一发取消不许把别的批次也停掉（B 不该被取消）').toBeUndefined()
    expect(b.items.length, 'B 应当自己跑完 4 条').toBe(4)
  }, 30_000)
})

/**
 * W2-11.5：模型下载也要能取消。
 *
 * 为什么这条不能省：最大的那一块有 1.2 GB，「点了停止却还要等下完」是这条链路上唯一
 * 会真的让人等的事。三件事分别钉：
 *   ① 取消**贯通到流里**（`streamUrlToFile` 的 signal），而不是只在文件之间查一次；
 *   ② 取消与失败**分开报**（`canceled: true` vs `error`）—— 用户自己按的不该弹错误框；
 *   ③ `.part` **不删**：下次点击从断点续接，这是「取消可反悔」的前提。
 *
 * 测法：把 `streamUrlToFile` 换成一个「吐几块然后等取消」的替身 —— 真下载要 1.26 GB 且要出网。
 */
describe('W2-11.5：模型下载的取消（网关槽位 + 流内贯通）', () => {
  it('流途中取消：canceled=true 而不是 error，且 .part 留着', async () => {
    const w = createTempWorkspace('laya-dl-cancel')
    workspaces.push(w)
    const dec = join(w.dir, 'decrypted')
    mkdirSync(dec, { recursive: true })
    vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', dec)
    vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(dec, 'decoded_images'))
    // 模型目录钉到临时目录，别碰真实数据根。
    vi.stubEnv('DSH_WECHAT_LAYA_DIR', join(w.dir, 'laya'))

    dlMock.active = true
    dlMock.calls = 0
    dlMock.finished = false

    const gw = new WechatDataGateway(makeCtx())
    const jobId = 'laya-dl-1'
    const running = gw.downloadLayaModel({ jobId })
    // 让替身先真的开始（它会写 .part 并吐第一块），否则取消可能打在「还没登记」的空档上。
    for (let i = 0; i < 40 && dlMock.calls === 0; i += 1) await new Promise((r) => { setTimeout(r, 5) })
    const hit = await gw.cancelLayaDownload({ jobId })
    const r = await running
    dlMock.active = false

    expect(dlMock.calls, '替身一次都没被调用 ⇒ 下面全是空断言').toBeGreaterThan(0)
    expect(dlMock.finished, '整条流被跑完了 ⇒ 取消只发生在文件之间，「点停止立刻生效」是假的')
      .toBe(false)
    expect(hit.ok, '在飞的下载必须被取消命中').toBe(true)
    expect(r.canceled, '取消必须以 canceled 收尾，而不是 error').toBe(true)
    expect(r.error, '取消不是失败 —— 不许带 error').toBeUndefined()
  }, 30_000)
  it('不带 jobId 的老调用方行为不变（没有槽就不接 signal，照常下载）', () => {
    const src = readFileSync(new URL('../src/remotes/laya.ts', import.meta.url), 'utf8')
    // 取不到槽时 `ctl` 是 undefined ⇒ 传给 layaDownloadModel 的是 undefined ⇒ 不可取消。
    expect(src, 'downloadLayaModel 没有接 layaSignal').toContain('rc.layaSignal(options?.jobId)')
    expect(src, '取不到槽时必须把 undefined 传下去（不许编一个假 signal）').toContain('ctl?.signal')
  })
})