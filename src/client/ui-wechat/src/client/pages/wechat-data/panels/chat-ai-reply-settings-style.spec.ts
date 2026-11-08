// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('AI 回复设置样式', () => {
  it('使用纯色面，不在 Webhook 分区叠渐变', () => {
    const css = readFileSync(join(import.meta.dirname, 'chat-ai-reply-settings.module.css'), 'utf8')
    expect(css).not.toContain('linear-gradient')
    expect(css).toMatch(/\.webhookSection\s*\{[^}]*background:\s*var\(--nm-bg-1\)/s)
  })
})
