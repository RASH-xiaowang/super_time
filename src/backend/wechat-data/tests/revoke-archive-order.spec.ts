// @vitest-environment node
/**
 * 撤回归档必须跑在 `emit` **之前**（2026-11-19）。
 *
 * ## 为什么值得单独守
 *
 * 顺序错了不会有任何报错，表现只是「刚撤回的那条要等下一拍才出现」——
 * 用户以为防撤回没生效，而代码看着完全正常。真机复现过：
 * 撤回 3s 后归档已入库，但面板拉取时归档还没写，于是拿到上一次的状态。
 *
 * 这条断言直接对比两个调用的**源码位置**，不依赖注释或变量名。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'gateway-core.ts'), 'utf8')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('撤回归档与数据事件的顺序', () => {
  it('`archiveMessages` 在 `emit(wechat-data/updated)` 之前', () => {
    const code = strip(SRC)
    const archiveAt = code.indexOf('archiveMessages(decrypted)')
    const emitAt = code.indexOf("ctx.emit('wechat-data/updated'")
    expect(archiveAt, 'gateway-core.ts 里找不到 archiveMessages 调用').toBeGreaterThan(-1)
    expect(emitAt, 'gateway-core.ts 里找不到 wechat-data/updated 事件').toBeGreaterThan(-1)
    expect(
      archiveAt,
      '归档必须在 emit 之前：否则面板被唤醒时归档还没写，刚撤回那条要等下一拍',
    ).toBeLessThan(emitAt)
  })

  it('只调用一次（挪位置时容易留下旧的重复调用）', () => {
    const code = strip(SRC)
    const hits = code.split('archiveMessages(decrypted)').length - 1
    expect(hits, `archiveMessages 被调用了 ${String(hits)} 次，应为 1 次`).toBe(1)
  })

  it('导入还在（防止只删调用忘了清理死导入）', () => {
    expect(SRC).toContain("import { archiveMessages } from './query/revoke-retain.ts'")
  })
})
