/**
 * ClawBot 库的连接生命周期守卫（P0-1 同族）。
 *
 * 两条：
 *  ① **源码级**：`query/clawbot/*.ts` 一律不许自己 `new DatabaseSync` ——
 *     连接只能走 `withDb` / `withWritableDb`（异常路径也保证 close）；
 *  ② **行为级**：跑过真实读写之后，整个数据根可以被 `rmSync` 直接删掉
 *     （Windows 上泄漏一个句柄就会 `EPERM`，且重试无效 —— 那意味着「数据根换不掉」）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { markBindingQr } from '../src/query/clawbot/clawbot-binding.ts'
import { insertClawbotMessage, listClawbotMessages } from '../src/query/clawbot/clawbot-message.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-life-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 剥注释：源码断言不能被注释里那句「绝不自己 new DatabaseSync」骗过（也不能被它误伤）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('clawbot 连接纪律', () => {
  it('query/clawbot/*.ts 里不出现 `new DatabaseSync`（连接只许走 db-open 家族）', () => {
    const queryDir = join(import.meta.dirname, '..', 'src', 'query', 'clawbot')
    const files = readdirSync(queryDir).filter((f) => f.startsWith('clawbot-') && f.endsWith('.ts'))
    expect(files.length, '一条 clawbot query 文件都没扫到 ⇒ 扫描口径坏了').toBeGreaterThanOrEqual(4)
    for (const f of files) {
      const body = stripComments(readFileSync(join(queryDir, f), 'utf8'))
      expect(body, `${f} 绕过 db-open 自己开了连接（P0-1 的病灶）`).not.toContain('new DatabaseSync')
    }
  })

  it('读写一遍之后整个数据根可以立刻删除（没有句柄残留 ⇒ 不 EBUSY/EPERM）', () => {
    const dir = root()
    const base = join(dir, '..')
    markBindingQr(dir, { token: 't', expiresAt: 1 })
    insertClawbotMessage(dir, { ts: 1, direction: 'in', content: 'x' })
    expect(listClawbotMessages(dir).total).toBe(1)
    // 不重试、不 sleep：句柄泄漏的话这里必定抛
    rmSync(base, { recursive: true, force: true })
    expect(true).toBe(true)
  })

  it('读路径不许假设库已存在（未接入过的机器上不许抛）', () => {
    const dir = root()
    expect(listClawbotMessages(dir).items).toEqual([])
  })
})
