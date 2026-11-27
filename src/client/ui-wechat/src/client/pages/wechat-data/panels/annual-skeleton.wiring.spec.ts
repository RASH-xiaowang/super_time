/**
 * 年度报告的初始加载态（2026-11-24）。
 *
 * 先前用 8 张空卡片加灰色占位条顶住画布，第一次打开像一排坏掉的卡片。
 * 现在只说明正在整理什么，数据到了再铺画布。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const panel = stripComments(read('Annual.tsx'))

describe('年度报告初始加载', () => {
  it('加载时说明正在整理哪一年，不再铺灰色占位卡', () => {
    expect(panel).toContain('<PageBoot')
    expect(panel).toContain('正在整理 ${year} 年的报告')
    expect(panel).not.toContain('<CardCanvasSkeleton')
    expect(panel).not.toContain('skelBlock')
    expect(panel).not.toContain('<ListSkeleton')
  })

  it('灰色占位卡组件已经拿走', () => {
    expect(existsSync(join(HERE, 'annual-skeleton.tsx'))).toBe(false)
  })
})
