/**
 * ClawBot 审计口径的三处同步守卫（docs 里 `clawbot-audit.spec.ts` 的落地版）。
 *
 * `OperationCategory` 是**封闭联合**，新增一个类别要同时改三处，缺一整条链路就断在
 * 不同的位置上、而且都不报错：
 *   ① `types-ops.ts` 联合 —— 缺了 typecheck 会红（这条最幸运）；
 *   ② `operation-log.ts` 的 `CATEGORIES` —— 缺了 `categories:['clawbot']` 过滤会**静默退化成
 *      「不筛类别」**（返回全部而不是只返回 clawbot）；
 *   ③ `OperationLogPanel.tsx` 的标签映射 —— 缺了 `Record` 类型报错、下拉里也看不到。
 *
 * 行为断言（②的最硬证据）：塞两行不同类别的记录，按 `[clawbot]` 过滤必须**只**剩一行。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { listOperations, recordOperation } from '../src/query/operation-log.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-audit-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

describe('ClawBot 审计：三处同步', () => {
  it('types-ops.ts 的 OperationCategory 联合含 clawbot', () => {
    const src = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'types-ops.ts'), 'utf8')
    expect(src, '联合类型里没有 clawbot（typecheck 之外还留一条可读的判据）').toMatch(/\|\s*'clawbot'/)
  })

  it('operation-log.ts 的 CATEGORIES 含 clawbot', () => {
    const src = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'operation-log.ts'), 'utf8')
    const m = /const CATEGORIES: readonly OperationCategory\[\] = \[([^\]]+)\]/.exec(src)
    expect(m, '找不到 CATEGORIES 常量（口径变了请同步本用例）').not.toBeNull()
    expect(m![1], 'CATEGORIES 少了 clawbot ⇒ 按类别筛会静默退化成「不筛」').toContain("'clawbot'")
  })

  it('操作日志面板的标签映射含 clawbot（下拉选项由它驱动）', () => {
    const src = readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'OperationLogPanel.tsx'), 'utf8')
    expect(src).toMatch(/clawbot:\s*'ClawBot'/)
  })

  it('行为：按 [clawbot] 过滤只返回 clawbot 行，不退回「不筛类别」', () => {
    const dir = root()
    recordOperation(dir, { category: 'clawbot', action: 'clawbot_bind', status: 'ok', target: 'wxid_a', detail: '已绑定' })
    recordOperation(dir, { category: 'settings', action: 'save_wechat_config', status: 'ok', target: '', detail: '' })
    const only = listOperations(dir, { categories: ['clawbot'] })
    expect(only.total, 'CATEGORIES 掉了 clawbot 时这里会变成 2（过滤退化为不筛）').toBe(1)
    expect(only.items[0]?.category).toBe('clawbot')
    expect(only.items[0]?.action).toBe('clawbot_bind')
  })
})
