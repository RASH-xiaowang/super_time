/**
 * 设置工作区布局守卫。
 *
 * 这里钉住三件容易在后续改版中退化的事：
 * - 导航与正文都必须「可滚动但不显示滚动条」；
 * - 820 以下必须切换成顶部横向标签，560 手机档的导航宽度不能再被内容撑开；
 * - 375px 下隐私体检等自动网格必须能缩进正文，而不是靠横向滚动兜底。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { atRuleBlock } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const SETTINGS = read('settings.module.css')
const CSS = stripComments(SETTINGS)
const SHELL = stripComments(readFileSync(join(HERE, '..', 'wechat-data.module.css'), 'utf8'))
const ACCOUNTS = stripComments(read('settings-accounts.module.css'))
const REMOTE = stripComments(read('settings-remote-access.module.css'))
const LIST_PANEL = stripComments(read('list-panel.module.css'))
const PANEL = read('Settings.tsx')
const NAV = read('settings-workspace.tsx')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''
}

describe('设置工作区：结构、滚动与响应式', () => {
  it('设置面板真的使用统一导航与上下文条', () => {
    expect(PANEL).toContain('<SettingsNavRail groups={navGroups}')
    expect(PANEL).toContain('<SettingsWorkspaceHeader groups={navGroups}')
    expect(PANEL).toContain('role="region"')
    expect(NAV).toContain("aria-current={active ? 'page' : undefined}")
    expect(NAV).toContain('revealActiveItem(rail, active)')
  })

  it('导航和正文保留原生滚动，但隐藏滚动条', () => {
    for (const selector of ['.navRail', '.mainScroll']) {
      expect(rule(selector), `${selector} 必须保留 overflow-y: auto`).toMatch(/overflow-y:\s*auto/)
      expect(rule(selector), `${selector} 必须隐藏滚动条`).toMatch(/scrollbar-width:\s*none/)
    }
    expect(CSS).toMatch(/\.navRail::-webkit-scrollbar\s*\{[^}]*width:\s*0/)
    expect(CSS).toMatch(/\.mainScroll::-webkit-scrollbar\s*\{[^}]*width:\s*0/)
    expect(CSS).toContain('.root :where(div, section, nav, main, ul, ol)')
  })

  it('中等宽度改成顶部横向索引，手机档导航宽度不被内容撑开', () => {
    const medium = atRuleBlock(SETTINGS, '@media (max-width: 820px)')
    expect(medium).toMatch(/\.navRail\s*\{[^}]*flex-direction:\s*row/)
    expect(medium).toMatch(/\.navRail\s*\{[^}]*overflow-x:\s*auto/)
    expect(medium).toContain('.navFade')

    const phone = atRuleBlock(SETTINGS, '@media (max-width: 560px)')
    const nav = /\.navRail\s*\{([^}]*)\}/.exec(phone)?.[1] ?? ''
    expect(nav).toMatch(/flex:\s*0 0 auto/)
    expect(nav, '手机档导航必须锁在容器宽度内，否则内部无法横向滚动').toMatch(/width:\s*100%/)
    expect(nav).toMatch(/overflow-x:\s*auto/)
  })

  it('桌面弹窗有足够宽度承载目录与正文', () => {
    expect(SHELL).toMatch(/\.settingsDialog\.settingsDialog\s*\{[^}]*width:\s*min\(1120px,\s*94vw\)/)
    expect(CSS).toMatch(/\.workspace\s*\{[^}]*min-width:\s*0/)
  })
})

describe('设置各页不再制造第二条滚动轨道', () => {
  it('账号列表随页面展开，不固定 252px 内滚', () => {
    expect(ACCOUNTS).not.toMatch(/\.accounts\s*\{[^}]*height:\s*252px/)
    expect(ACCOUNTS).not.toMatch(/\.accounts\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('局域网访问卡不再嵌套 max-height 滚动', () => {
    expect(REMOTE).not.toMatch(/\.card\s*\{[^}]*max-height:/)
    expect(REMOTE).not.toMatch(/\.card\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('隐私体检的自动网格允许缩到 375px 正文宽', () => {
    expect(LIST_PANEL).toContain('minmax(min(100%, 380px), 1fr)')
  })
})
