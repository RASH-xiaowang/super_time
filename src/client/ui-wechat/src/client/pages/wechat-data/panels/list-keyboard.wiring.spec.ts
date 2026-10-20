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

describe('会话列表键盘导航接线', () => {
  it('ChatsView 的会话列表容器挂了 onKeyDown，并指向 data-session-row', () => {
    expect(view).toContain("import { focusListRow } from './list-keyboard.ts'")
    expect(view).toMatch(/<div ref=\{sessionListRef\}[^>]*onKeyDown=/)
    expect(view).toContain("focusListRow(event, sessionListRef.current, '[data-session-row]')")
  })

  it('会话按钮带 data-session-row（键盘导航的选择器不是空集）', () => {
    expect(chats).toMatch(/<button\s+key=\{s\.username\}[\s\S]{0,160}data-session-row=\{s\.username\}/)
  })
})
