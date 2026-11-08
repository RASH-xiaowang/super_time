// @vitest-environment node
/**
 * 会话列表键盘导航的接线判据。
 *
 * 纯函数在 `list-keyboard.spec.ts` 里已经钉住边界；这条只防“函数写好了但没接上”：
 * - ChatsView 的会话列表容器必须挂 onKeyDown，且选择器与行属性一致；
 * - Chats 的会话按钮必须带 `data-session-row`，否则 querySelector 永远空。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const view = readFileSync(join(HERE, 'chats-view.tsx'), 'utf8')
const chats = readFileSync(join(HERE, 'Chats.tsx'), 'utf8')
const sessionRow = readFileSync(join(HERE, 'chats-session-row.tsx'), 'utf8')

describe('会话列表键盘导航接线', () => {
  it('ChatsView 的会话列表容器挂了 onKeyDown，并指向 data-session-row', () => {
    expect(view).toContain("import { focusListRow } from './list-keyboard.ts'")
    expect(view).toMatch(/<div ref=\{sessionListRef\}[^>]*onKeyDown=/)
    expect(view).toContain("focusListRow(event, sessionListRef.current, '[data-session-row]')")
  })

  it('会话按钮带 data-session-row（键盘导航的选择器不是空集）', () => {
    // M21 把会话行拆成 ChatsSessionRow：Chats.tsx 只负责挂行，属性必须落在真正输出 button 的组件上。
    expect(chats).toContain('<ChatsSessionRow')
    expect(sessionRow).toMatch(/<button\s+type="button"\s+data-session-row=\{session\.username\}/)
  })
})
