/**
 * 修复结果文案的判定口径（表驱动）。
 *
 * 守的是三条曾经同时存在的误报：
 *   · 后端返回 `{ found: 0, error: '已有解密任务进行中' }` 时被说成「没有发现损坏」；
 *   · `ok:false` 也被说成「修复完成」；
 *   · `failed` / `unrepairable` 两类明细在提示语里完全不出现。
 * 因此除了逐格对文案，还专门断言「任务占用」绝不含「没有损坏」。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { DbRepairResult } from '@deepseek-ai/dsh-wechat-data/types'
import { repairNotice } from './repair-notice.ts'

function result(overrides: Partial<DbRepairResult> = {}): DbRepairResult {
  return {
    ok: true,
    checked: 10,
    found: 1,
    repaired: 1,
    stillCorrupted: [],
    failed: [],
    unrepairable: [],
    unreadable: [],
    uncheckable: [],
    ...overrides,
  }
}

const badIssue = { file: 'message_0.db', error: 'database disk image is malformed' }
const unrepairableIssue = { file: 'biz_0.db', reason: '原始 db_storage 里没有对应文件' }

describe('repairNotice', () => {
  const cases: ReadonlyArray<{ name: string; r: DbRepairResult; want: string }> = [
    {
      name: '解密任务占用：换成可照做的提示',
      r: result({ ok: false, found: 0, repaired: 0, error: '已有解密任务进行中（decryptAllDbs）' }),
      want: '已有解密任务进行中，请稍后再试',
    },
    {
      name: '配置类 error：原样转述原因',
      r: result({ ok: false, found: 0, repaired: 0, error: '解密密钥未配置，请先设置密钥' }),
      want: '修复未完成：解密密钥未配置，请先设置密钥',
    },
    {
      name: 'found=0 且无 error/failed：才可以说无需修复',
      r: result({ found: 0, repaired: 0 }),
      want: '体检没有发现损坏的库，无需修复',
    },
    {
      name: '全部恢复',
      r: result({ found: 2, repaired: 2 }),
      want: '修复完成：2 个损坏中恢复 2 个',
    },
    {
      name: '部分仍坏',
      r: result({ ok: false, found: 3, repaired: 2, stillCorrupted: [badIssue] }),
      want: '修复未完成：3 个损坏中恢复 2 个，仍坏 1 个',
    },
    {
      name: '重解密失败：列出首个文件与原因',
      r: result({
        ok: false,
        found: 2,
        repaired: 1,
        failed: [{ db: 'message_0.db', error: 'database is locked' }],
      }),
      want: '修复未完成：2 个损坏中恢复 1 个，1 个重解密失败（首个：message_0.db：database is locked）',
    },
    {
      name: '仍坏 + 原始库缺失：两类都报',
      r: result({ ok: false, found: 2, repaired: 1, stillCorrupted: [badIssue], unrepairable: [unrepairableIssue] }),
      want: '修复未完成：2 个损坏中恢复 1 个，仍坏 1 个，修不了 1 个（原始库缺失）',
    },
    {
      name: 'ok:false（无 stillCorrupted 之外的明细）也要说未完成',
      r: result({ ok: false, found: 1, repaired: 1 }),
      want: '修复未完成：1 个损坏中恢复 1 个，仍坏 0 个',
    },
    {
      name: '修复完成但原始库缺失：追加修不了的数量',
      r: result({ found: 2, repaired: 2, unrepairable: [unrepairableIssue] }),
      want: '修复完成：2 个损坏中恢复 2 个，修不了 1 个（原始库缺失）',
    },
    {
      name: 'error 优先于 failed / found / ok 之外的分支',
      r: result({
        ok: false,
        found: 2,
        repaired: 0,
        failed: [{ db: 'message_0.db', error: 'database is locked' }],
        error: 'db_storage 不存在',
      }),
      want: '修复未完成：db_storage 不存在',
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(repairNotice(c.r)).toBe(c.want)
    })
  }

  it('任务占用绝不说成「没有损坏」，也不冒充「修复完成」', () => {
    const notice = repairNotice(result({
      ok: false,
      found: 0,
      repaired: 0,
      error: '已有解密任务进行中（decryptAllDbs）',
    }))
    expect(notice).not.toContain('没有损坏')
    expect(notice).not.toContain('修复完成')
    expect(notice).toContain('已有解密任务进行中')
  })
})
