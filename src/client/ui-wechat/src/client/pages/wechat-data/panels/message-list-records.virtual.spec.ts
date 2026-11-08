// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const records = readFileSync(join(HERE, 'message-list-records.tsx'), 'utf8')
const virtual = readFileSync(join(HERE, 'message-list-virtual.ts'), 'utf8')
const css = readFileSync(join(HERE, 'message-list.module.css'), 'utf8')

describe('消息列表虚拟化接线', () => {
  it('tbody 走视口切片、动态测高和首尾撑杆，不整表 map', () => {
    expect(records).toContain('useMessageListRowVirtualizer(props.records, tableScrollRef)')
    expect(records).toContain('messageListRowsForRender(rowVirtualizer, props.records)')
    expect(records).toContain('renderedRows.rows.map')
    expect(records).toContain('ref={tableScrollRef}')
    expect(records).toContain('ref={rowVirtualizer.measureElement}')
    expect(records).toContain('renderedRows.pads.top')
    expect(records).toContain('renderedRows.pads.bottom')
    expect(records).not.toContain('props.records.map((record')
  })

  it('数据窗口和 DOM 都有显式硬上界', () => {
    expect(virtual).toContain('MESSAGE_LIST_DOM_MAX = 120')
    expect(virtual).toContain('MESSAGE_LIST_ROW_OVERSCAN = 8')
    expect(virtual).toContain('getItemKey')
    expect(virtual).toContain('records.slice')
  })

  it('分页加载栏提示窗口上限而不是静默停止', () => {
    expect(records).toContain('已达到')
    expect(records).toContain('窗口上限')
    expect(records).toContain('onLoadMore')
    expect(records).toContain('加载更多')
    expect(css).toMatch(/\.loadBar\s*\{/)
    expect(css).toMatch(/\.virtualPad\s*\{/)
  })

  it('记录行保持单行紧凑，不让备注和操作按钮撑高', () => {
    expect(records).toContain('className={css.recordRow}')
    expect(records).toContain('className={css.noteLine}')
    expect(css).toMatch(/\.recordRow,\s*\.recordRow > td\s*\{\s*height: 32px;/)
    expect(css).toMatch(/\.rowActions\s*\{[\s\S]*?flex-wrap: nowrap;/)
    expect(css).toMatch(/\.textCell span\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/)
    expect(css).toMatch(/\.noteCell\s*\{[\s\S]*?overflow: hidden;/)
    expect(css).toMatch(/\.noteText\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/)
  })

  it('关键列前置，1280 宽屏仍能直接看到状态、备注与操作', () => {
    const start = records.indexOf('function MessageListTableHead')
    const header = records.slice(
      start,
      records.indexOf('</thead>', start),
    )
    expect(header.indexOf('>状态<')).toBeLessThan(header.indexOf('>备注<'))
    expect(header.indexOf('>备注<')).toBeLessThan(header.indexOf('>操作<'))
    expect(header.indexOf('>操作<')).toBeLessThan(header.indexOf('>触发对象<'))
    expect(css).toMatch(/\.table\s*\{[\s\S]*?min-width: 1378px;/)
  })

  it('手机档折叠 Webhook 跟随 12px 内容 gutter，不越出视口', () => {
    const rootBase = css.slice(0, css.indexOf('@media')).match(/\.root\s*\{([^}]*)\}/s)?.[1] ?? ''
    const phone = css.slice(css.indexOf('@media (max-width: 560px)'))
    const root = phone.match(/\.root\s*\{([^}]*)\}/s)?.[1] ?? ''
    const collapsed = phone.match(/\.webhookCardCollapsed\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(rootBase).toContain('margin-inline: calc(-1 * var(--nm-s-4, 16px))')
    expect(rootBase).toContain('padding-inline: var(--nm-s-4, 16px)')
    expect(root).toContain('margin-inline: -12px')
    expect(root).toContain('padding-inline: 12px')
    expect(collapsed).toContain('margin-right: -12px')
    expect(collapsed).toContain('margin-left: -12px')
  })
})
