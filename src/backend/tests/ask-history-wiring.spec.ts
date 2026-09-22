/**
 * 「每次问答自动保存」这条链路的**接线**守卫（源码级）。
 *
 * 为什么需要：`tests/ask-history.spec.ts` 只证明**存储模块本身**能用。
 * 如果网关忘了在返回前落库 —— 或只在一处返回前落库 —— 存储模块的 20 条用例照样全绿，
 * 而用户看到的是「问了半天，历史里一条都没有」。这两件事必须分开钉：
 *   · 存储模块 = 能不能写、写得对不对（单元用例）；
 *   · 网关接线   = **有没有真的写**、写在哪几条路径上（本用例）。
 *
 * 关键细节：`askWechat` 有**两条**成功返回路径 —— ① 没检索到原文的短路返回
 * （未调模型），② 正常回答。两条都必须落库，否则「当时确实问了、也确实没找到」
 * 这类轮次会整段从历史里消失。所以这里断言调用点 ≥ 2，而不是「存在即可」。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

// M21：三个问答历史方法体搬进 remotes/ask.ts（网关只留一行转发）⇒ 读联合（断言未改）；
// 三处「方法体里必须打到存储模块」的正则因此能匹配到实现那份。
const gateway = stripCode([GATEWAY, ...readdirSync(join(dirname(GATEWAY), 'remotes')).filter((f) => f.endsWith('.ts'))
  .sort().map((f) => join(dirname(GATEWAY), 'remotes', f))].map((f) => readFileSync(f, 'utf8')).join('\n'))
const store = codeOf(STORE)

describe('问答历史：网关自动保存', () => {
  it('网关从 ask-history 模块取用写入函数（不是自己另写一份）', () => {
    expect(gateway).toContain("from './query/ask-history.ts'")
    expect(gateway).toMatch(/import \{[^}]*recordAsk[^}]*\} from '\.\/query\/ask-history\.ts'/)
  })

  it('askWechat 的两条成功返回路径都落库（≥2 个调用点）', () => {
    const calls = [...gateway.matchAll(/this\.saveAskHistory\(/g)]
    expect(calls.length, '只在一条路径上落库 ⇒ 另一类问答会整段从历史消失').toBeGreaterThanOrEqual(2)
  })

  it('落库内容取的是**回答本身**（问题/回答/引用/basis/检索统计）', () => {
    const at = gateway.indexOf('private saveAskHistory(')
    expect(at).toBeGreaterThan(-1)
    // 取到方法体（到下一个方法声明前的收尾括号）
    const body = gateway.slice(at, at + 3000)
    for (const marker of ['recordAsk(', 'options.question', 'result.answer', 'result.citations', 'result.citedIndexes', 'result.retrieval', 'elapsedMs']) {
      expect(body, `saveAskHistory 没写 ${marker}`).toContain(marker)
    }
  })

  it('记录写入是 best-effort：包在 try 里，失败不影响已经生成好的回答', () => {
    const at = gateway.indexOf('private saveAskHistory(')
    const body = gateway.slice(at, at + 3000)
    expect(body).toMatch(/try \{/)
  })

  it('问了哪个「入口」也记下来（面板问答 / 会话内问答可分开回看）', () => {
    // askWechat 暴露 source 选项，并把它透传进历史
    expect(gateway).toMatch(/source\?: string/)
    const at = gateway.indexOf('private saveAskHistory(')
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
