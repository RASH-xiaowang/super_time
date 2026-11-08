/**
 * AI 模型设置的结构守卫。
 *
 * 2026-10-29 重设计后结构变成：
 *   当前连接 → 已保存配置 → 对话模型主编辑器（顶部含保存条）→ 高级能力（嵌入 / 精排）。
 *
 * 仍然钉住旧版最关键的可访问性约束：高级面板必须是可键盘操作的折叠件，
 * 收起时不渲染面板体，且向量 / 精排各有自己的测试按钮。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const WD = join(HERE, '..')
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const shell = strip(read(WD, 'panels', 'ai-model-panel.tsx'))
const card = strip(read(WD, 'panels', 'AiModelConfig.tsx'))
const overview = strip(read(WD, 'panels', 'ai-model-overview.tsx'))
const editor = strip(read(WD, 'panels', 'ai-model-editor.tsx'))
const advanced = strip(read(WD, 'panels', 'ai-model-advanced.tsx'))
const roles = strip(read(WD, 'panels', 'ai-model-roles.tsx'))
const cssText = read(WD, 'panels', 'ai-model.module.css')

describe('可折叠面板外壳', () => {
  it('标题栏是真 button，带 aria-expanded / aria-controls，文案写明展开还是收起', () => {
    expect(shell).toMatch(/<button[\s\S]{0,200}className=\{css\.panelHead\}/)
    expect(shell).toContain('data-model-panel-toggle={id}')
    expect(shell).toContain('aria-expanded={open}')
    expect(shell).toContain('aria-controls={`ai-model-panel-${id}`}')
    expect(shell).toMatch(/title=\{open \? `收起「\$\{title\}」` : `展开「\$\{title\}」`\}/)
  })

  it('收起时不渲染面板体（`open &&`，不是 CSS 隐藏）', () => {
    expect(shell).toMatch(/\{open && \(/)
    expect(shell).not.toMatch(/aria-hidden=\{!open\}/)
  })

  it('折叠图标随状态旋转，状态徽标支持 idle / warn', () => {
    expect(shell).toContain('data-open={open || undefined}')
    expect(shell).toMatch(/<svg[\s\S]{0,200}M6 9l6 6 6-6/)
    expect(cssText).toMatch(/\.panelCaret\[data-open\] svg \{[\s\S]{0,60}rotate\(180deg\)/)
    expect(shell).toContain('data-tone={status.tone}')
    for (const tone of [`'idle'`, `'warn'`]) expect(cssText).toContain(`[data-tone=${tone}]`)
  })
})

describe('页面层级：状态、切换、编辑、高级能力、保存', () => {
  it('五个层级按认知顺序组装', () => {
    const at = (needle: string): number => card.indexOf(needle)
    expect(at('<AiModelOverview')).toBeGreaterThan(-1)
    expect(at('<AiModelOverview')).toBeLessThan(at('<ProfilesQuickSwitch'))
    expect(at('<ProfilesQuickSwitch')).toBeLessThan(at('<AiModelEditor'))
    expect(at('<AiModelEditor')).toBeLessThan(at('<AiModelAdvanced'))
    expect(at('<AiModelSaveBar')).toBeGreaterThan(at('<AiModelEditor'))
    expect(at('<AiModelSaveBar')).toBeLessThan(at('<AiModelAdvanced'))
  })

  it('对话模型始终可见，不再藏在折叠面板里', () => {
    expect(editor).toContain('id="chat"')
    expect(editor).toContain('data-llm-editor')
    expect(editor).toContain('对话模型')
    expect(card).toContain('<AiModelEditor')
    expect(card).not.toContain('id="chat"')
  })

  it('嵌入 / 精排收进高级能力，默认都折叠且没有自动展开旁路', () => {
    for (const [id, title] of [['embed', '嵌入模型'], ['rerank', '重排序模型']] as const) {
      expect(advanced, `缺面板 ${id}`).toContain(`id="${id}"`)
      expect(advanced, `缺标题 ${title}`).toContain(`title="${title}"`)
    }
    expect((advanced.match(/subtitle="/g) ?? []).length).toBe(2)
    expect(advanced).toContain("useState<Record<'embed' | 'rerank', boolean>>({ embed: false, rerank: false })")
    expect(advanced).not.toContain('setPanelOpen')
    expect(advanced).not.toMatch(/embed: true|rerank: true/)
  })

  it('三类端点各挂自己的测试按钮，余额独立于三类端点', () => {
    expect(overview).toContain('<LlmProbeButton kind="chat"')
    expect(roles).toContain('<LlmProbeButton kind="embed"')
    expect(roles).toContain('<LlmProbeButton kind="rerank"')
    expect(overview).toContain('<LlmBalanceButton cfg={draftConfig} />')
  })

  it('高级面板体与主编辑区各接自己的字段与更新函数', () => {
    expect(advanced).toContain('<EmbedPanelBody cfg={cfg} onPatch={onPatch} />')
    expect(advanced).toContain('<RerankPanelBody cfg={cfg} onPatch={onPatch} />')
    expect(card).toContain('<ProfilesQuickSwitch')
    expect(card).toContain('<AiModelSaveBar')
  })

  it('保存条嵌在编辑器顶部，不覆盖表单，也不会被页面底栏裁掉', () => {
    expect(editor).toContain('{saveBar}')
    expect(cssText).toMatch(/\.saveDock \{[\s\S]{0,220}margin-top: 12px/)
    expect(cssText).not.toMatch(/\.saveDock \{[\s\S]{0,120}position: sticky/)
  })
})
