/**
 * 会话列表的**后台刷新**不得破坏性重置（否则每约 10 秒"跳动"一次）。
 *
 * 起因（2026-09-20 报障：「每次有新消息时会话列表就跳动一次」）：
 * 实时事件 `dsh-wechat-data-updated` 在活跃期约每 10 秒派发一次，而 `Chats.tsx` 的
 * `onUpdated` 里除了刷消息流，还调了一次 `queueReloadSessions()` → `reloadSessionsList()`
 * → `sessionsPager.reset()`。`reset()` 会**同步 `setItems([])`**：列表瞬间换成骨架屏、
 * 内容高度塌陷，浏览器随即把 `scrollTop` 钳到 0 —— 手感就是"列表自己跳一下"。
 *
 * 讽刺的是 `usePagedList` **内部已经订阅同一事件**并做非破坏性 `refresh()`（按已加载条数
 * 重取、不动滚动），注释里也写着实测记录；外层这一趟 `reset()` 把它整个抵消了。
 *
 * 这里钉住两件事：① 实时处理器里不许再刷列表；② `reloadSessionsList` 必须用 `refresh()`。
 * 用 AST 之外的源码锚点即可（本仓的既有做法，见 `graph-canvas.wiring.spec.ts`）：
 * 断言的字符串都是单行的，不受行尾影响；比较前先剥注释，免得被说明文字骗过。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const code = stripComments(readFileSync(join(HERE, 'Chats.tsx'), 'utf8'))

describe('会话列表的后台刷新', () => {
  it('实时事件处理器里不再刷会话列表（钩子内部已做非破坏性 refresh）', () => {
    const start = code.indexOf('const onUpdated')
    expect(start, '找不到 onUpdated —— 改名后请同步本用例').toBeGreaterThan(-1)
    const end = code.indexOf('addEventListener', start)
    const handler = code.slice(start, end)
    for (const dead of ['reloadSessionsList', 'queueReloadSessions', 'sessionsPager']) {
      expect(handler.includes(dead), `实时处理器里不该再出现 ${dead}（会把列表清空重画）`).toBe(false)
    }
  })

  it('reloadSessionsList 用 refresh() 而不是 reset()', () => {
    const m = /const reloadSessionsList = useCallback\(\(\): void => \{([\s\S]*?)\}, \[/.exec(code)
    expect(m, '找不到 reloadSessionsList 的定义 —— 改名后请同步本用例').not.toBeNull()
    const body = m![1]
    expect(body.includes('.refresh('), 'reloadSessionsList 应当走非破坏性 refresh()').toBe(true)
    expect(body.includes('.reset('), 'reloadSessionsList 不该走 reset()（会闪骨架屏并把滚动钳回顶部）').toBe(false)
    // 防空转：剥注释后若把整份源码剥没了，上面几条会恒真。
    expect(code.length).toBeGreaterThan(10000)
  })
})
