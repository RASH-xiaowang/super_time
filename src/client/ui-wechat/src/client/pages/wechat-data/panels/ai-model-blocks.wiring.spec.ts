/**
 * 「三块可折叠模型面板」的结构判据（2026-09-30 重做）。
 *
 * 用户要求：把对话模型 / 嵌入模型 / 重排序模型划成**独立板块**，每块带**可折叠/展开的
 * 按钮图标**，结构清晰、交互直观。这条判据钉住的就是"结构清晰"里能被静默做丢的那几件事：
 *   · 三块**确实是三块**（各有 id 与标题），而不是又揉回一大段表单；
 *   · 每块的标题栏是**真按钮**且有 `aria-expanded`（键盘可达 + 读屏能读状态）；
 *   · 收起时**不渲染**内容（不是 CSS 隐藏 —— 隐藏的输入框仍会被读到、仍参与表单语义）；
 *   · 折叠箭头有 `data-open` 供 CSS 旋转（用户要的"图标"就是它）。
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
const cssText = read(WD, 'panels', 'ai-model.module.css')

describe('可折叠面板外壳', () => {
  it('标题栏是真 button，带 aria-expanded / aria-controls，文案写明展开还是收起', () => {
    expect(shell).toMatch(/<button[\s\S]{0,200}className=\{css\.panelHead\}/)
    expect(shell).toContain('data-model-panel-toggle={id}')
    expect(shell).toContain('aria-expanded={open}')
    expect(shell).toContain('aria-controls={`ai-model-panel-${id}`}')
    expect(shell).toMatch(/title=\{open \? `收起「\$\{title\}」` : `展开「\$\{title\}」`\}/)
  })

  it('收起时**不渲染**面板体（`open &&`，不是 CSS 隐藏）', () => {
    expect(shell).toMatch(/\{open && \(/)
    expect(shell).not.toMatch(/aria-hidden=\{!open\}/)
  })

  it('折叠图标随状态旋转（CSS 用 data-open 驱动）', () => {
    expect(shell).toContain('data-open={open || undefined}')
    expect(shell).toMatch(/<svg[\s\S]{0,200}M6 9l6 6 6-6/)
    expect(cssText).toMatch(/\.panelCaret\[data-open\] svg \{[\s\S]{0,60}rotate\(180deg\)/)
  })

  it('面板带状态徽标（三块各自说明自己配好没有）', () => {
    expect(shell).toContain('data-tone={status.tone}')
    expect(shell).toContain('{status.text}')
    for (const tone of [`'idle'`, `'warn'`]) expect(cssText).toContain(`[data-tone=${tone}]`)
  })
})

describe('主卡片：三块独立面板 + 组装顺序', () => {
  it('三块都在，且各有 id 与标题、副标题（不是只有标题的行）', () => {
    for (const [id, title] of [['chat', '对话模型'], ['embed', '嵌入模型'], ['rerank', '重排序模型']] as const) {
      expect(card, `缺面板 ${id}`).toContain(`id="${id}"`)
      expect(card, `缺标题 ${title}`).toContain(`title="${title}"`)
    }
    // 每块都给了副标题（首次看的人不必猜这块管什么）
    expect((card.match(/subtitle="/g) ?? []).length).toBe(3)
  })

  it('顺序是 对话 → 嵌入 → 重排序，余额在最后（账户级信息不属于任何一块）', () => {
    const at = (needle: string): number => card.indexOf(needle)
    expect(at('id="chat"')).toBeLessThan(at('id="embed"'))
    expect(at('id="embed"')).toBeLessThan(at('id="rerank"'))
    expect(at('id="rerank"')).toBeLessThan(at('<LlmBalanceButton'))
  })

  it('**默认全部折叠**（用户 2026-09-30 明确要求），且没有"自动展开"的旁路', () => {
    expect(card).toContain("useState<Record<'chat' | 'embed' | 'rerank', boolean>>({ chat: false, embed: false, rerank: false })")
    expect(card).toMatch(/const togglePanel = useCallback\(\(id: 'chat' \| 'embed' \| 'rerank'\): void => \{/)
    // 反例：配了哪块就自动展开哪块 —— 那会让"默认折叠"名存实亡
    expect(card, '又不许自动展开了').not.toContain('panelTouched')
    expect(card).not.toMatch(/setPanelOpen\(\{ chat: (true|Boolean)/)
  })

  it('每块挂自己的测试按钮（对话在主卡片，向量/精排在各自面板体）', () => {
    expect(card).toContain('<LlmProbeButton kind="chat"')
    const roles = strip(read(WD, 'panels', 'ai-model-roles.tsx'))
    expect(roles).toContain('<LlmProbeButton kind="embed"')
    expect(roles).toContain('<LlmProbeButton kind="rerank"')
  })

  it('三块面板体各自可读：对话=快速切换+表单+保存；向量/精排=各自字段', () => {
    expect(card).toContain('<ProfilesQuickSwitch')
    expect(card).toContain('<EmbedPanelBody cfg={llmConfig} onPatch={patchCfg} />')
    expect(card).toContain('<RerankPanelBody cfg={llmConfig} onPatch={patchCfg} />')
  })
})
