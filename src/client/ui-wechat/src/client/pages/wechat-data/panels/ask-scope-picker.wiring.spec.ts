/**
 * `@` 检索范围浮层的接线守卫。
 *
 * 顶部范围条已移除，范围入口必须出现在输入框旁边的浮层里；
 * 会话行仍复用真实头像，并保留时间范围能力。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('问答检索范围浮层', () => {
  it('面板不再渲染顶部范围条，改为锚定输入框的范围浮层', () => {
    const ask = read('Ask.tsx')
    const composer = read('ask-composer.tsx')
    expect(ask).not.toContain('<AskScopeBar')
    expect(ask).toContain('<AskComposer')
    expect(composer).toContain('<AskScopePicker')
    expect(composer).toContain('useAskScopeTrigger')
    expect(composer).toContain('onChange={trigger.onChange}')
  })

  it('浮层保留会话头像、类型、搜索与时间范围', () => {
    const picker = read('ask-scope-picker.tsx')
    expect(picker).toContain('Avatar')
    expect(picker).toContain('全部会话')
    expect(picker).toContain('群聊')
    expect(picker).toContain('单聊')
    expect(picker).toContain('DateRangeField')
    expect(picker).toContain('全部时间')
  })

  it('浮层向上定位，输入框是定位祖先', () => {
    const css = read('ask-scope-picker.module.css')
    expect(css).toMatch(/\.panel \{[^}]*bottom: calc\(100% \+ 8px\)/s)
    expect(css).toMatch(/\.panel \{[^}]*left: 12px/s)
    expect(read('ask.module.css')).toMatch(/\.composer \{[^}]*position: relative/s)
  })

  it('会话名与类型上下分行，不与来源描述挤在同一行', () => {
    const css = read('ask-scope-picker.module.css')
    expect(css).toMatch(/\.rowText \{[^}]*display: flex[^}]*flex-direction: column/s)
    expect(css).toMatch(/\.rowName \{[^}]*display: block/s)
    expect(css).toMatch(/\.rowMeta \{[^}]*display: block/s)
  })
})
