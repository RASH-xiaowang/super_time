/**
 * 「每次问答自动保存」这条链路的**接线**守卫（源码级）。
 *
 * 为什么需要：`tests/ask-history.spec.ts` 只证明**存储模块本身**能用。
 * 如果网关忘了在返回前落库 —— 或只在一处返回前落库 —— 存储模块的 20 条用例照样全绿，
 * 而用户看到的是「问了半天，历史里一条都没有」。这两件事必须分开钉：
 *   · 存储模块 = 能不能写、写得对不对（单元用例）；
 *   · 网关接线   = **有没有真的写**、写在哪几条路径上（本用例）。
 *
 * 关键细节：统一 answer runtime 把所有状态（正常、无证据、澄清、阻断、降级、失败）
 * 都收敛到同一个返回点，因此 `askWechat` 只需要**一次**生产落库调用。这里断言
 * 恰好一处，既防止漏写，也防止旧的多路径实现回流后出现重复记录。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gatewaySource } from './gateway-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATEWAY = join(HERE, '..', 'wechat-data', 'src', 'gateway.ts')
const STORE = join(HERE, '..', 'wechat-data', 'src', 'query', 'ask-history.ts')

/** 去掉注释 —— 否则注释里提到旧做法会让断言误判。 */
function stripCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}
function codeOf(file: string): string {
  return stripCode(readFileSync(file, 'utf8'))
}

// M21：三个问答历史方法体搬进 remotes/ask.ts、`saveAskHistory` 住进 gateway-core.ts
// ⇒ 读「类 + 域处理器」的联合（断言未改）。
const gateway = stripCode(gatewaySource())
const store = codeOf(STORE)

describe('问答历史：网关自动保存', () => {
  it('网关从 ask-history 模块取用写入函数（不是自己另写一份）', () => {
    expect(gateway).toContain("from './query/ask-history.ts'")
    expect(gateway).toMatch(/import \{[^}]*recordAsk[^}]*\} from '\.\/query\/ask-history\.ts'/)
  })

  it('askWechat 在统一返回点落库（恰好 1 个生产调用点）', () => {
    // M21：askWechat 搬进 remotes/askdeep.ts ⇒ 调用点前缀变成 `rc.`；同时先剥掉网关里那行
    // ctx 接线（`saveAskHistory: (…) => this.saveAskHistory(…)` 是转发装配，不是落库调用点），
    // 否则调用点计数会被装配代码虚增。
    const calls = [...gateway.replace(/\bsaveAskHistory: \([^)]*\) => this\.saveAskHistory\(/g, '')
      .matchAll(/(?:this|rc)\.saveAskHistory\(/g)]
    expect(calls.length, '统一返回点必须恰好落库一次；0 会丢历史，多条会重复记录').toBe(1)
  })

  it('落库内容取的是**回答本身**（问题/回答/引用/basis/检索统计）', () => {
    const at = gateway.search(/\n  (?:private|protected) saveAskHistory\(/)
    expect(at).toBeGreaterThan(-1)
    // 取到方法体（到下一个方法声明前的收尾括号）
    const body = gateway.slice(at, at + 3000)
    for (const marker of [
      'recordAsk(', 'options.question', 'result.answer', 'result.citations', 'result.citedIndexes', 'result.retrieval', 'elapsedMs',
      // 运行状态不能被旧四态吞掉：原始状态/原因与有界证据摘要都要交给 ask-history 归一。
      'runtimeStatus: result.status', 'statusReason: result.statusReason', 'synthesisError: result.synthesisError',
      'evidence: result.evidence', 'toolCalls: result.toolCalls', 'resources: result.resources',
    ]) {
      expect(body, `saveAskHistory 没写 ${marker}`).toContain(marker)
    }
  })

  it('记录写入是 best-effort：包在 try 里，失败不影响已经生成好的回答', () => {
    const at = gateway.search(/\n  (?:private|protected) saveAskHistory\(/)
    const body = gateway.slice(at, at + 3000)
    expect(body).toMatch(/try \{/)
  })

  it('问了哪个「入口」也记下来（面板问答 / 会话内问答可分开回看）', () => {
    // askWechat 暴露 source 选项，并把它透传进历史
    expect(gateway).toMatch(/source\?: string/)
    const at = gateway.search(/\n  (?:private|protected) saveAskHistory\(/)
    expect(gateway.slice(at, at + 3000)).toContain('options.source')
  })
})

describe('问答历史：三个 Remote 方法', () => {
  it('读取 / 删除 / 清空都已注册为 Remote', () => {
    expect(gateway).toContain("@Remote('getAskHistory')")
    expect(gateway).toContain("@Remote('deleteAskHistory')")
    expect(gateway).toContain("@Remote('clearAskHistory')")
  })

  it('三个方法都真的打到存储模块的对应函数上', () => {
    expect(gateway).toMatch(/getAskHistory\(options\?: AskHistoryQuery\): AskHistorySnapshot \{\s*return listAskHistory\(/)
    expect(gateway).toMatch(/deleteAskHistory\(options: \{ ids: number\[\] \}\): AskHistoryDeleteResult \{\s*const ids = Array\.isArray\(options\?\.ids\) \? options\.ids : \[\]\s*const r = deleteAskHistory\(/)
    expect(gateway).toMatch(/clearAskHistory\(\): AskHistoryClearResult \{\s*const r = clearAskHistory\(/)
  })

  it('清空只由显式入口触发：存储模块没有任何定时/阈值清理逻辑', () => {
    // 静默丢掉用户的问答历史，比库慢慢变大糟得多 —— 这条取舍必须留在源码里。
    for (const marker of ['setInterval', 'setTimeout', 'cron', 'autoPrune']) {
      expect(store, `问答历史不该有自动清理（${marker}）`).not.toContain(marker)
    }
    expect(store).toContain('export function clearAskHistory(')
  })

  it('存储模块不参与导出：没有任何导出/分享路径引用它', () => {
    for (const marker of ['exportCsv', 'exportAllSessions', 'exportSessionMessages', 'zip']) {
      expect(store, `问答历史不该出现在 ${marker} 的链路里`).not.toContain(marker)
    }
  })
})

describe('问答历史：自动回复的问答必须与「用户自己问的」分得开', () => {
  it("ClawBot 的自动回复落 source='auto'（不带就落成缺省的 'ask'）", () => {
    // 缺省是 'ask'（= 用户手动问，见 query/ask-history.ts 的 `cleanText(input.source) || 'ask'`），
    // 所以「忘了传 source」的后果不是报错，而是历史里冒出一条用户没问过的记录 ——
    // 这是本仓第一处「用户没点击、模型也答了」的问答，来源是它唯一的判别位。
    expect(gateway, "自动回复不带 source ⇒ 历史里与用户自己问的分不开")
      .toMatch(/askWechat\(\{[^}]*source:\s*'auto'/)
  })

  it('自动回复走的是注入的 ask 能力（模型统一由「对话模型」决定）', () => {
    // 2026-10-17：签名加了第 4 参 `systemPrompt`（实例的系统提示词）。
    // 2026-10-18：加第 5 参 `context`（最近对话 + 图片），「统一模型」不变。
    expect(gateway, '自动回复没有注入点 ⇒ 它会另找一条模型路径，「统一模型」就守不住了')
      .toMatch(/ask:\s*async \(slot, text, kbId, systemPrompt(?:, context)?\)/)
  })
})
