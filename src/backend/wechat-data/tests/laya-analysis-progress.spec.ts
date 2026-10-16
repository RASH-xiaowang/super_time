// @vitest-environment node
/**
 * 逐条分析的**进度反馈**回归（W3-11.5）。
 *
 * 背景：整批分析实测**均 36s / 峰值 110s**，而界面上只有一个「本地分析中…」——
 * 用户分不清「在跑」还是「卡死」，也不敢切走（切走就白算）。所以给 `analyzeVisibleMessages`
 * 加了一个 `onProgress` 回调，经 `laya-analysis/progress` 事件推到渲染层。
 *
 * 本文件钉四件事：
 *   ① **每条都推进一次**（含命中的缓存条目），`done` 单调不回退；
 *   ② `total` 是本批真正要处理的条数（截到 MAX_ANALYZE_BATCH 之后），不是 targets 的原始长度；
 *   ③ 进度里带**当前处理到的 localId** —— 面板靠它把"正在算哪条"和消息行对上；
 *   ④ 传了回调不该改变任何结果（items 与不传时逐项相同）—— 观测设施不许改变被观测的行为。
 *
 * 不依赖真实模型：这些断言全部走"模型未就绪"之外的路径 —— 用 `laya-fake` 稀疏文件
 * 让 `layaModelStatus` 判为「已装」，但每条目标都走「取不到这条消息」这个
 * **不推理**的逐条失败分支，一样能验证进度语义；推理本身由 `laya-analysis` 的既有用例覆盖。
 *
 * 取消那一半见 `laya-analysis-cancel.spec.ts`（连同槽位与缓存语义）。
 */
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeVisibleMessages, MAX_ANALYZE_BATCH } from '../src/laya/analysis.ts'
import { LAYA_ASSETS } from '../src/laya/model-file.ts'
import { createTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'

const workspaces: TempWorkspace[] = []
afterEach(async () => {
  for (const w of workspaces.splice(0, workspaces.length)) await w.cleanup()
})

/**
 * 造一个「看起来已安装」的模型目录。
 *
 * `analyzeVisibleMessages` 在循环**之前**只查一遍文件是否存在/够不够大（`layaModelStatus`
 * 只 `statSync`，不加载），真的加载发生在第一次推理内部。所以只要四个必需文件都过下界，
 * 整批就会走到循环里 —— 而我们要验的进度语义恰好全在循环里，不需要真跑 ONNX。
 *
 * 四个文件的下界合计 ~66MB（其中权重 64MB）。这里写 1 字节再 `truncate` 到下界：
 * NTFS 会把空洞当稀疏文件，实际占用只有几 KB，写满则是每次单测 66MB 的写盘。
 */
function makeFakeModelDir(w: TempWorkspace): string {
  const dir = w.path(join('laya-fake'))
  for (const asset of LAYA_ASSETS) {
    const p = join(dir, asset.rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'x')
    truncateSync(p, asset.minBytes)
  }
  return dir
}

/**
 * 造一条「消息库里什么都没有」的会话。
 *
 * 这样每条目标都走「取不到这条消息」这个**逐条失败**分支：不推理、不读缓存，
 * 但仍然经过完整的进度推进 —— 进度语义与真实路径一致，且完全不依赖本机模型/转写。
 * 顺带钉住一条契约：**单条取不到不影响整批继续**（这正是进度能把 12 条都走完的前提）。
 */
function makeEmptyTalker(w: TempWorkspace): { talker: string; modelDir: string } {
  mkdirSync(w.path(join('message')), { recursive: true })
  w.db(join('message', 'message_0.db')).close()
  return { talker: 'wxid_empty_chat', modelDir: makeFakeModelDir(w) }
}

describe('W3-11.5：逐条分析的进度反馈', () => {
  it('每条推进一次、单调不回退，且带当前 localId', async () => {
    const w = createTempWorkspace('laya-progress')
    workspaces.push(w)
    const { talker, modelDir } = makeEmptyTalker(w)
    const localIds = [11, 22, 33, 44, 55, 66]

    const seen: Array<{ done: number; total: number; currentLocalId: number }> = []
    const r = await analyzeVisibleMessages({
      decryptedDir: w.dir, decodedDir: w.dir, talker, modelDir,
      targets: localIds.map((localId, i) => ({ localId, sortSeq: i + 1 })),
      useCache: false,
      onProgress: (done, total, currentLocalId) => { seen.push({ done, total, currentLocalId }) },
    })

    // 模型「已装」（稀疏文件过下界）且会话非空 ⇒ 整批走循环，而不是"模型未就绪"早退。
    expect(r.error).toBeUndefined()
    expect(r.items.length).toBe(6)
    // ① 每条一次，total 恒为 6
    expect(seen.length).toBe(6)
    for (const s of seen) expect(s.total).toBe(6)
    // ② 单调不回退，且恰好覆盖 1..6
    expect(seen.map((s) => s.done)).toEqual([1, 2, 3, 4, 5, 6])
    // ③ 每次报的 currentLocalId 就是本批里对应的那条（顺序一致）
    expect(seen.map((s) => s.currentLocalId)).toEqual(localIds)
    // ④ 每条都被标成"取不到这条消息"（单条失败不影响整批继续，也说明进度没有改结果）
    for (const it of r.items) expect(it.error).toContain('取不到这条消息')
  })

  it('total 是截断后的本批条数，不是调用方给的原始长度', async () => {
    const w = createTempWorkspace('laya-progress-cap')
    workspaces.push(w)
    const { talker, modelDir } = makeEmptyTalker(w)

    const totals = new Set<number>()
    // 比上限多 5 条：界面那边如果按\"调用方给的数量\"显示进度条，末尾会永远停在 3/17。
    const targets = Array.from({ length: MAX_ANALYZE_BATCH + 5 }, (_, i) => ({ localId: 1000 + i, sortSeq: i + 1 }))
    const r = await analyzeVisibleMessages({
      decryptedDir: w.dir, decodedDir: w.dir, talker, modelDir, targets, useCache: false,
      onProgress: (_done, total) => { totals.add(total) },
    })
    expect([...totals], 'total 必须等于截断后的条数').toEqual([MAX_ANALYZE_BATCH])
    expect(r.items.length, '被截断掉的那几条不该出现在结果里').toBe(MAX_ANALYZE_BATCH)
  })

  it('不传回调时一切照旧（观测设施不许成为前提）', async () => {
    const w = createTempWorkspace('laya-progress-none')
    workspaces.push(w)
    const { talker, modelDir } = makeEmptyTalker(w)
    const run = async (onProgress?: (done: number, total: number, currentLocalId: number) => void) =>
      analyzeVisibleMessages({
        decryptedDir: w.dir, decodedDir: w.dir, talker, modelDir,
        targets: [{ localId: 7, sortSeq: 1 }, { localId: 8, sortSeq: 2 }],
        useCache: false,
        ...(onProgress ? { onProgress } : {}),
      })
    const a = await run()
    const b = await run(() => {})
    expect(b.items, '带不带回调出来的结果必须逐项相同').toEqual(a.items)
    expect(a.items.length).toBe(2)
  })

  it('会话级早退（没有要分析的消息）不报进度，也不崩', async () => {
    const w = createTempWorkspace('laya-progress-empty')
    workspaces.push(w)
    let called = 0
    const r = await analyzeVisibleMessages({
      decryptedDir: w.dir, decodedDir: w.dir, talker: 'wxid_x', targets: [], useCache: false,
      onProgress: () => { called += 1 },
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有要分析的消息')
    expect(called, '早退路径不该报进度').toBe(0)
  })
})
