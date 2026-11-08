// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function readPanelSource(file: string): string {
  return readFileSync(join(HERE, file), 'utf8')
}

describe('message list notice toast wiring', () => {
  const actions = readPanelSource('use-message-list-actions.ts')
  const panel = readPanelSource('MessageListPanel.tsx')
  const css = readPanelSource('message-list.module.css')

  it('uses the shared two-second transient notice controller', () => {
    expect(actions).toContain('useTransientNotice<Notice>(2000)')
    expect(actions).toContain('flash: setNotice')
    expect(actions).toContain('clear: clearNotice')
    expect(actions).not.toContain('useState<Notice>')
  })

  it('renders action feedback as a fixed floating toast', () => {
    expect(panel).toContain('css.noticeToast')
    expect(panel).not.toContain('css.notice, noticeClass')
    expect(css).toMatch(/\.noticeToast\s*\{[^}]*position:\s*fixed;/)
    expect(css).toMatch(/\.noticeToast\s*\{[^}]*z-index:\s*1200;/)
    expect(css).toMatch(/\.noticeToast\s*\{[^}]*pointer-events:\s*none;/)
  })

  it('keeps the toast inside the viewport on narrow screens', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*560px\)\s*\{[\s\S]*?\.noticeToast/)
  })

  it('keeps the ledger neutral and avoids decorative motion', () => {
    expect(css).not.toContain('linear-gradient')
    expect(css).toMatch(/@keyframes noticeToastIn\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?opacity:\s*1;/)
    expect(css).not.toMatch(/noticeToastIn\s*\{[^}]*transform:/)
  })
})
