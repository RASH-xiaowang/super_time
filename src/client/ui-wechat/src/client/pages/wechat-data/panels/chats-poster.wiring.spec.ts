// @vitest-environment node
/**
 * The menu must start selection mode rather than capturing one visible row.
 * These guards protect the virtual-list handoff that pure selection tests
 * cannot see.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')

describe('multi-message poster wiring', () => {
  it('row clicks toggle selection in poster mode and do not open message analysis', () => {
    const view = read('chats-view.tsx')
    expect(view).toContain('onClickCapture={messagePoster.active && posterId > 0')
    expect(view).toContain('messagePoster.toggle(posterId)')
    // 2026-11-18：推荐回复不再锁消息区（合并后点消息就是换分析对象），
    // 因此这里只剩批量海报模式自己的那道门。
    expect(view).toContain("onClick={!messagePoster.active && item.kind === 'msg'")
  })

  it('selection toolbar and scaled preview are both mounted', () => {
    const view = read('chats-view.tsx')
    expect(view).toContain('<ChatsPosterSelectionBar')
    expect(view).toContain('<ChatsPosterOverlay controller={messagePoster}')
    expect(view).toContain('messagePoster.generate(msgItems)')
  })

  it('the right-click action enters multi-select instead of screenshotting one DOM row', () => {
    const tools = read('chats-message-tools.tsx')
    expect(tools).toContain('useChatsPoster(curSession, flash)')
    expect(tools).toContain('beginPoster(m)')
    expect(tools).not.toContain("document.getElementById('msg-' + String(m.localId))")
  })
})
