/**
 * 历史 operation_log 中 category=clawbot 的记录仍需可读。
 * 这里只守中性展示兼容，不重新引入对应运行链路。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PANEL = readFileSync(join(import.meta.dirname, 'OperationLogPanel.tsx'), 'utf8')

describe('OperationLogPanel：历史操作分类显示兼容', () => {
  it('历史分类使用中性中文标签', () => {
    expect(PANEL).toMatch(/clawbot:\s*'已退役功能'/)
  })

  it('分类筛选仍由完整标签映射生成，旧记录不会失去筛选项', () => {
    expect(PANEL).toContain('Object.keys(OP_CATEGORY_LABEL)')
  })

  it('表格开启表头列宽拖拽', () => {
    expect(PANEL).toMatch(/<DataTable[\s\S]*?\bresizable\b/)
  })
})
