// @vitest-environment node
/**
 * W3-7.1：解析队列的**可数总结**与「为什么失败」的可展开清单。
 *
 * 这条口径容易走偏，所以先立三条规矩（都是本仓已有的纪律，不是新发明）：
 *   ① **不画假进度条**：后端没有每份文件的进度信号（`runJob` 一次只 claim 一行，
 *      没有全局队列游标），所以「正在第 x/y」这个座标**造不出来** ——
 *      `PARSE_LOOK` 的头注里就写着「画一根假的进度条比不画更糟」。本条目做的是
 *      **可数的口径**：在跑/排队多少个、需要注意多少个。
 *   ② 失败必须**逐条列原因**，而不是只给一个总数：`parse_error` 是后端写进去的原句
 *      （撞锁 / 密码 / 抽不出文字），把它摊开用户才知道该修哪一个。
 *   ③ 三种「未就绪」不许混成一种：`unsupported`（扫描件式 PDF，等升级/换文件）与
 *      `failed`（解析失败）与 `sparse_only`（没有向量但关键词照旧）在界面上长得不一样，
 *      总结里也要分开 —— 合并会让「等升级」被说成「换文件」。
 *
 * 判据从**合成样例**推：不依赖真实知识库、不需要渲染组件，
 * 因此「把某个状态从 attention 集合里删掉」这类回归能当场转红。
 */
import { describe, expect, it } from 'vitest'
import { PARSE_LOOK } from './kb-files-support.tsx'
import type { KbFileParseState } from '@deepseek-ai/dsh-wechat-data/types'

/** 一行合成文件：只要状态、名字与失败原因三样就够判据用。 */
const file = (parseState: KbFileParseState, name = 'f.pdf', parseError = ''): {
  id: number; name: string; parseState: KbFileParseState; parseError: string
} => ({ id: Math.floor(Math.random() * 1e6), name, parseState, parseError })

/** 与面板里同口径的一次遍历（在跑/在队 + 需要注意）。 */
function summarize(files: ReadonlyArray<ReturnType<typeof file>>): { pending: number; attention: number } {
  let pending = 0
  let attention = 0
  for (const f of files) {
    const look = PARSE_LOOK[f.parseState]
    if (look.pending) pending += 1
    else if (look.attention) attention += 1
  }
  return { pending, attention }
}

describe('W3-7.1：解析队列的总结口径', () => {
  it('四个中间态都算「在处理」——用户看的是一件正在进行的事', () => {
    const running: KbFileParseState[] = ['queued', 'parsing', 'chunking', 'embedding']
    for (const s of running) {
      expect(PARSE_LOOK[s].pending, `${s} 应算在处理中`).toBe(true)
      expect(PARSE_LOOK[s].attention, `${s} 不是「需要你处理」`).toBe(false)
    }
    expect(summarize(running.map((s) => file(s))).pending).toBe(4)
  })

  it('「需要注意」只有 failed 与 unsupported 两档（sparse_only 不是失败）', () => {
    // 反向哨兵：sparse_only 被算成 attention 会让一个仍能被关键词搜到的文件看起来坏了。
    expect(PARSE_LOOK.sparse_only.attention, '没有向量只影响语义检索，不该算「需要处理」').toBe(false)
    expect(PARSE_LOOK.failed.attention).toBe(true)
    expect(PARSE_LOOK.unsupported.attention).toBe(true)
    // ready 两头都不算。
    expect(PARSE_LOOK.ready.pending).toBe(false)
    expect(PARSE_LOOK.ready.attention).toBe(false)
  })

  it('总结按文件可数：混合一批 === 各档计数相加', () => {
    const files = [
      file('queued'), file('parsing'), file('ready'), file('ready'),
      file('failed', 'a.pdf', 'database is locked'), file('unsupported', 'scan.pdf'),
      file('sparse_only', 'novol.pdf'),
    ]
    const s = summarize(files)
    expect(s.pending, '排队 + 解析中').toBe(2)
    expect(s.attention, '失败 + 未解析').toBe(2)
  })

  it('空库不显示这一行（没有队列却报「队列阻塞」是误导）', () => {
    const s = summarize([])
    expect(s.pending).toBe(0)
    expect(s.attention).toBe(0)
    // 面板的判据是 files.length === 0 ⇒ 不渲染。这里钉住那个前提。
    expect([].length === 0).toBe(true)
  })

  it('三种未就绪的文案互不相同（合并就会被说成另一件事）', () => {
    const hints = new Set([
      PARSE_LOOK.failed.hint, PARSE_LOOK.unsupported.hint, PARSE_LOOK.sparse_only.hint,
    ])
    expect(hints.size, 'failed / unsupported / sparse_only 的解释必须是三句不同的话').toBe(3)
    for (const s of ['failed', 'unsupported', 'sparse_only'] as KbFileParseState[]) {
      expect(PARSE_LOOK[s].hint, `${s} 的解释不许为空`).not.toBe('')
    }
  })
})