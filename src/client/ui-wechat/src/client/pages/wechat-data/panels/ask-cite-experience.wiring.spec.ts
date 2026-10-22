/**
 * 三个问答入口的「引用 → 详情」一致性接线守卫。
 *
 * 为什么按源码断言：仓库没有可用的 DOM/hook 测试环境，而这条链路最容易静默断在三处：
 *   ① 面板没有把上下文加载器交给 `useCiteDetail`（详情永远显示「缺定位」）；
 *   ② hook 返回了 loading/error/retry，但没传给 `CiteDetailPanel`（用户只能看到空白）；
 *   ③ 知识库引用被当成消息引用（打开一个不存在的会话，且不报错）。
 *
 * 另外钉住两类降级：旧历史记录缺 `locator/kb` 时不得崩溃、错误文本不得带堆栈或本机路径。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readableCiteError } from './use-cite-detail.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')
const bare = (name: string): string =>
  read(name).replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

describe('引用详情：微信问答 / 会话内问答接线一致', () => {
  it('两个入口都把消息上下文加载器交给 useCiteDetail（懒加载入口存在）', () => {
    for (const file of ['Ask.tsx', 'SessionAsk.tsx']) {
      const code = bare(file)
      expect(code, `${file} 未导入 loadMessageContext`).toContain('loadMessageContext')
      expect(code, `${file} 未把 loadMessageContext 交给 useCiteDetail`).toMatch(
        /useCiteDetail\([^)]*\{\s*loadContext:\s*loadMessageContext\s*\}\s*\)/,
      )
    }
  })

  it('hook 的四项上下文状态全部传到 CiteDetailPanel', () => {
    for (const file of ['Ask.tsx', 'SessionAsk.tsx']) {
      const code = bare(file)
      for (const marker of ['context={', 'contextStatus=', 'contextError=', 'onRetryContext=']) {
        expect(code, `${file} 没把 ${marker} 传给详情面板`).toContain(marker)
      }
    }
  })

  it('会话内问答与微信问答使用同一套 PlanLine / RetrMeta，且都放在正文之前', () => {
    for (const file of ['Ask.tsx', 'SessionAsk.tsx']) {
      const code = bare(file)
      const planAt = code.indexOf('<PlanLine plan={t.plan} />')
      const retrAt = code.indexOf('<RetrMeta retrieval={t.retrieval} />')
      const answerAt = code.indexOf('<AnswerBody')
      expect(planAt, `${file} 缺 PlanLine`).toBeGreaterThan(-1)
      expect(retrAt, `${file} 缺 RetrMeta`).toBeGreaterThan(-1)
      expect(planAt, `${file} 的 PlanLine 必须在正文之前`).toBeLessThan(answerAt)
      expect(retrAt, `${file} 的 RetrMeta 必须在正文之前`).toBeLessThan(answerAt)
    }
    expect(bare('SessionAsk.tsx'), '会话内问答要复用微信问答的组件，不能复制一份')
      .toMatch(/import \{[^}]*PlanLine[^}]*RetrMeta[^}]*\} from '\.\/Ask\.tsx'/)
  })

  it('知识库引用在详情与历史里都走 openKbFileFromCitation（不新造旁路）', () => {
    const session = bare('SessionAsk.tsx')
    expect(session).toContain("import { loadMessageContext, openKbFileFromCitation, useCiteDetail } from './use-cite-detail.ts'")
    expect(session.match(/onOpenKbFile=\{openKbFileFromCitation\}/g)?.length, '详情与历史都要接').toBe(2)
    const detail = bare('CiteDetailPanel.tsx')
    expect(detail).toContain('onOpenKbFile')
    expect(detail).toContain('openKb(target.kbId, target.fileId)')
    expect(detail).toContain('citeDetailError')
  })

  it('知识库引用绝不调用消息上下文加载器（合成 username 不是会话）', () => {
    const hook = bare('use-cite-detail.ts')
    expect(hook).toContain("item.source === 'kb'")
    expect(hook).toMatch(/username\.startsWith\('kb:'\)/)
    expect(hook).toMatch(/setContextStatus\('unavailable'\)/)
    expect(hook).toMatch(/if \(username === '' \|\| localId === undefined\)/)
  })

  it('消息上下文是有界懒加载：固定上限、不按 hasMore 翻全量', () => {
    const hook = bare('use-cite-detail.ts')
    expect(hook).toContain('const BEFORE_LIMIT = 6')
    expect(hook).toContain('const AFTER_LIMIT = 13')
    expect(hook).toContain('cursorLocalId: Number.MAX_SAFE_INTEGER')
    expect(hook).not.toContain('hasMore')
    expect(hook).not.toContain('while (')
  })
})

describe('问答历史：知识库可打开、旧记录安全降级', () => {
  it('知识库项是按钮，走 onOpenKbFile(kbId, fileId)，消息项仍走 onOpenCitation', () => {
    const dialog = bare('AskHistoryDialog.tsx')
    const kbAt = dialog.indexOf('data-src="kb"')
    expect(kbAt).toBeGreaterThan(-1)
    // KB 分支必须在 button 内、并且调用 openKb（而不是直接 onOpenCitation）
    const kbBlock = dialog.slice(Math.max(0, kbAt - 900), kbAt + 900)
    expect(kbBlock).toContain('<button')
    expect(kbBlock).toContain('onOpenKbFile')
    expect(dialog).toContain('if (target?.kind !== \'kb\') return')
    expect(dialog).toMatch(/target\?\.kind === 'msg'\) onOpenCitation\?\.\(target\.username, target\.localId\)/)
    expect(dialog).not.toMatch(/onOpenCitation\?\.\(c\.username/)
  })

  it('旧记录缺 locator / kb 字段时降级为可读摘要，不崩溃也不误跳会话', () => {
    const dialog = bare('AskHistoryDialog.tsx')
    expect(dialog).toContain('isKbCitation(c)')
    expect(dialog).toContain("(c.username ?? '').trim().startsWith('kb:')")
    expect(dialog).toContain('这条旧记录缺少文件定位信息，只能查看摘要')
    expect(dialog).toContain('这条旧记录缺少可定位信息，只能查看摘要')
  })

  it('打开失败只给可读文案（调用 readableCiteError，不拼原始 message）', () => {
    const dialog = bare('AskHistoryDialog.tsx')
    expect(dialog).toContain('readableCiteError(e')
    expect(dialog).not.toContain("(e as Error).message")
  })
})

describe('详情面板：四种上下文状态各自说清', () => {
  it('加载中 / 空 / 失败 / 缺定位四种状态都有独立文案', () => {
    const panel = bare('CiteDetailPanel.tsx')
    for (const marker of ["status === 'loading'", "status === 'empty'", "status === 'error'", "status === 'unavailable'"]) {
      expect(panel, `缺 ${marker}`).toContain(marker)
    }
    expect(panel).toContain('正在读取附近消息…')
    expect(panel).toContain('这条引用附近没有更多消息。')
    expect(panel).toContain('暂时无法加载附近消息')
    expect(panel).toContain('打开会话原文')
  })

  it('失败态提供重试 + 可操作建议，不显示内部堆栈', () => {
    const panel = bare('CiteDetailPanel.tsx')
    expect(panel).toContain('onClick={onRetryContext}')
    expect(panel).toContain('也可以先点下方「打开会话原文」核对。')
    expect(panel).not.toContain('stack')
    const err = readableCiteError(new Error('ENOENT: failed\n    at open (D:\\secret\\file.ts:1:1)'))
    expect(err).toBe('ENOENT: failed')
    expect(readableCiteError(new Error('读取失败：D:\\secret\\a.txt'))).not.toContain('D:\\secret')
    expect(readableCiteError('')).toBe('读取失败，请稍后重试')
  })
})
