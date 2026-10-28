/**
 * 分析面板内推荐回复的接线守卫。
 *
 * 这里钉住四条容易「看起来有、实际错」的边界：
 *   ① 请求必须带当前分析消息的 localId；
 *   ② 会话/目标变化后用请求世代隔离过期响应；
 *   ③ 3 条候选走真实剪贴板结果，失败不能假装成功；
 *   ④ 分析面板拥有推荐区，但请求逻辑不在纯展示的分析壳里。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (path: string): string => readFileSync(join(HERE, path), 'utf8')
const COMPONENT = read('AnalysisReplySuggest.tsx')
const PANEL = read('ChatAnalysisPanel.tsx')
const RIGHT = read('ChatRightPanel.tsx')

describe('分析面板的上下文推荐回复', () => {
  it('请求带上分析目标和固定 3 条数量', () => {
    expect(COMPONENT).toContain('const REPLY_COUNT = 3')
    expect(COMPONENT).toContain('targetLocalId: Math.trunc(targetLocalId)')
    expect(COMPONENT).toContain('count: REPLY_COUNT')
  })

  it('切换会话/目标/换一批时隔离过期响应', () => {
    expect(COMPONENT).toContain('const seqRef = useRef(0)')
    expect(COMPONENT).toContain('if (seq !== seqRef.current) return')
    expect(COMPONENT).toContain('[username, targetLocalId, round]')
  })

  it('复制以剪贴板真实结果为准，失败有可见反馈', () => {
    expect(COMPONENT).toContain('copyTextToClipboard(text)')
    expect(COMPONENT).toContain('if (ok) setCopied(index)')
    expect(COMPONENT).toContain('setCopyFailed(true)')
    expect(COMPONENT).toContain('复制失败')
  })

  it('推荐区位于分析面板内，并由组合层传入当前会话 username', () => {
    expect(PANEL).toContain("import { AnalysisReplySuggest } from './AnalysisReplySuggest.tsx'")
    expect(PANEL).toContain('<AnalysisReplySuggest username={replyUsername} targetLocalId={targetId} />')
    expect(RIGHT).toContain('replyUsername={target.username}')
  })
})
