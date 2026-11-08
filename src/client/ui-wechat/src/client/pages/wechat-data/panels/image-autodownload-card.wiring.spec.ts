// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const source = readFileSync(join(HERE, 'image-autodownload-card.tsx'), 'utf8')

describe('微信原图自动下载：未确认清理时仍可手动关闭', () => {
  it('cleanupUnconfirmed 不再无条件禁用按钮', () => {
    expect(source).toContain('const canStop = enabled || status?.hooked === true')
    expect(source).toContain('status.cleanupUnconfirmed && !canStop')
  })

  it('已开启或仍可能注入时，按钮动作必须是 stop', () => {
    expect(source).toContain("const shouldStop = status?.enabled === true || status?.hooked === true")
    expect(source).toContain("apiWechatImageAutoDownload(shouldStop ? 'stop' : 'start')")
  })

  it('未确认清理时区分关闭与重试还原文案', () => {
    expect(source).toContain("status.cleanupUnconfirmed ? '关闭自动下载' : '关闭并还原'")
    expect(source).toContain("'重试还原'")
    expect(source).toContain("'等待重启微信'")
    expect(source).toContain('请重启微信完成清理')
  })
})
