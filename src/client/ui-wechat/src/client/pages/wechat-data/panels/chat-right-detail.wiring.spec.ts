// @vitest-environment node
/**
 * 右栏「详情」视图：入口、内容与边界。
 *
 * 钉住四件事：
 *  ① 右上角有「详情」按钮，点开后是**同一块面板的第二屏**（不是新面板）；
 *  ② 详情展示两块的过程：分析（上下文/提示词/原始输出）与推荐回复；
 *  ③ 详情**不发请求** —— 数据全部来自已经取回的结果留痕；
 *  ④ 留痕缺失时如实说明（分「还没算」「算失败」「旧缓存无留痕」三种）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

const PANEL = read('ChatRightPanel.tsx')
const DETAIL = read('chat-right-detail.tsx')
const DETAIL_CSS = read('chat-right-detail.module.css')
const SUGGEST = read('ReplySuggest.tsx')

describe('详情入口', () => {
  it('① 右上角有「详情」按钮，且排在「收起整个右栏」之前', () => {
    expect(PANEL).toContain('aria-label="详情"')
    expect(PANEL).toContain('详情：看分析与推荐的思考过程')
    const detailAt = PANEL.indexOf('aria-label="详情"')
    const closeAt = PANEL.indexOf('aria-label="收起整个右栏"')
    expect(detailAt).toBeGreaterThan(-1)
    expect(closeAt).toBeGreaterThan(detailAt)
  })

  it('① 详情是同一面板的第二屏：复用外壳与滚动区，不是另开面板', () => {
    expect(PANEL).toContain('const [detailOpen, setDetailOpen] = useState(false)')
    expect(PANEL).toContain("'data-detail': 'open'")
    // 一个外壳、两个滚动区（主视图用 hidden 保活，详情屏按需挂载）。
    expect((PANEL.match(/className=\{shell\.panel\}/g) ?? []).length).toBe(1)
    expect((PANEL.match(/className=\{css\.scroll\}/g) ?? []).length).toBe(2)
    // 保活的关键：主视图用 `hidden` 隐藏而不是卸载 —— 否则点开详情再返回会
    // 重新挂载 `ReplySuggest`，再付一次模型调用。
    expect(PANEL).toContain('<div className={css.scroll} hidden={detailOpen}>')
  })

  it('① 详情屏有返回主视图的出口（两个：头部按钮 + 正文「← 返回」）', () => {
    expect(PANEL).toContain('aria-label="关闭详情"')
    expect(DETAIL).toContain('← 返回')
  })
})

describe('详情内容', () => {
  it('② 分析过程：上下文、系统提示词、提问提示词、模型原始输出', () => {
    for (const title of [
      '上下文（送给模型的历史对话）',
      '系统提示词',
      '本轮提问提示词',
      '模型原始输出',
    ]) {
      expect(DETAIL, `详情缺少「${title}」`).toContain(title)
    }
    expect(DETAIL).toContain('知识库命中')
  })

  it('② 两段入参：分析段始终在，推荐段由 showReply 控制（群聊没有）', () => {
    expect(DETAIL).toContain('aria-label="分析的思考过程"')
    expect(DETAIL).toContain('aria-label="推荐回复的思考过程"')
    expect(DETAIL).toContain('{showReply && (')
    expect(PANEL).toContain('showReply={allowSuggest}')
  })

  it('② 原始输出默认展开：它是「为什么得出这个结论」的直接证据', () => {
    const rawAt = DETAIL.indexOf('title="模型原始输出"')
    expect(rawAt).toBeGreaterThan(-1)
    expect(DETAIL.slice(rawAt, rawAt + 200)).toContain('open')
  })

  it('③ 详情不发请求：组件里不许出现 api 调用', () => {
    expect(DETAIL).not.toContain('apiAnalyzeMessage')
    expect(DETAIL).not.toContain('apiSuggestReplies')
    expect(DETAIL).not.toContain('remote()')
  })

  it('④ 留痕缺失时分情况说清楚，而不是留白', () => {
    expect(DETAIL).toContain('还没有选中消息')
    expect(DETAIL).toContain('正在分析，完成后这里会出现过程记录')
    expect(DETAIL).toContain('这次分析失败了')
    expect(DETAIL).toContain('没有过程留痕')
    expect(DETAIL).toContain('还没有生成候选回复')
  })

  it('版式：大段文本可折叠且限高，并用等宽字体', () => {
    expect(DETAIL).toContain('<details')
    expect(DETAIL_CSS).toMatch(/\.pre\s*\{[^}]*max-height:/)
    expect(DETAIL_CSS).toMatch(/\.pre\s*\{[^}]*font-family:\s*var\(--nm-font-mono/)
  })
})

describe('留痕来源', () => {
  it('推荐回复把本次留痕上报给组合层（不重复调用模型）', () => {
    expect(SUGGEST).toContain('onTrace?: (trace: ReplyTrace | undefined) => void')
    expect(SUGGEST).toContain('onTraceRef.current?.(r.trace)')
    // 回调存 ref：放进 load 的依赖会让每次父组件重渲染都重取一次（真实计费）。
    expect(SUGGEST).toContain('const onTraceRef = useRef(props.onTrace)')
    expect(SUGGEST).toContain('}, [target.username, kbId, targetLocalId])')
  })

  it('分析留痕来自结果本身（缓存命中时是当初那次的留痕）', () => {
    expect(DETAIL).toContain("analysisEntry.result")
    expect(DETAIL).toContain('done?.trace')
  })
})
