/**
 * 菜单关闭接线守卫：手写菜单不能只靠 hover 收起。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(join(import.meta.dirname, name), 'utf8')

describe('手写菜单关闭规则', () => {
  it.each([
    ['kb-batch-actions.tsx', 'toolsMenu'],
    ['GraphExportMenu.tsx', 'menuWrap'],
    ['Contacts.tsx', 'toolRow'],
    ['moments-panel.tsx', 'momentBar'],
    ['chats-head-actions.tsx', 'msgHeaderMoreWrap'],
    ['OperationLogPanel.tsx', 'moreMenu'],
    ['files-cell.tsx', 'moreMenu'],
    ['Tasks.tsx', 'more'],
    ['KbRail.tsx', 'kbList'],
    ['overview-panel.tsx', 'exportWrap'],
  ])('%s 接入 useMenuDismiss、aria-haspopup 与 focus 归还 ref', (file, rootClass) => {
    const source = read(file)
    expect(source).toContain('useMenuDismiss(')
    expect(source).toContain('aria-haspopup="menu"')
    expect(source).toMatch(/ref=\{[^}]*[Rr]ootRef\}/)
    expect(source).toMatch(/ref=\{[^}]*[Tt]riggerRef\}/)
    expect(source).toContain(rootClass)
  })

  it('Tasks 的更多菜单不再依赖原生 details', () => {
    expect(read('Tasks.tsx')).not.toContain('<details className={css.more}>')
  })

  it('会话头部更多菜单只由 useMenuDismiss 管理关闭与焦点', () => {
    const source = read('chats-thread.tsx')
    expect(source).not.toContain('useEscapeToClose(moreOpen')
    expect(source).not.toContain('msg-header-more')
  })

  it('消息右键菜单有可访问名称', () => {
    expect(read('chats-msg-menu.tsx')).toContain('aria-label="消息操作"')
  })
})
