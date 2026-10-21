/**
 * 视区外预取 + 缩略图宽度自适应（2026-10-21）。
 *
 * 判据：
 *  ① 宽度按「格宽 × DPR」取固定档位（不糊、也不会每拖一次窗口就多一份缓存）；
 *  ② 预取窗口 = 虚拟行窗口上下各 3 行，跳过非图片、贴边安全、空输入不炸；
 *  ③ LRU 上界随列数放大（预取不能把屏上的图挤掉）；
 *  ④ 接线守卫：面板真的走 hook + prefetchKeys + thumbWidthFor，格宽真的来自实测。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import {
  FILE_THUMB_WIDTH,
  PREFETCH_ROWS,
  prefetchKeys,
  THUMB_WIDTH_STEPS,
  thumbCacheLimitFor,
  thumbWidthFor,
} from './files-thumbs.ts'
import { cellWidthFor } from './files-grid.ts'

const K = (i: number): string => i.toString(16).padStart(32, '0')
const item = (i: number, category = 'image'): FileItem => ({
  md5: K(i), fileName: K(i) + '.dat', category, fileSize: 1, modifyTime: 0,
} as FileItem)

describe('cellWidthFor / thumbWidthFor：按格子实际宽度自适应（原固定 320）', () => {
  it('格宽 = 内容宽扣列间距后均分', () => {
    expect(cellWidthFor(1000, 5, 10)).toBe(192)
    expect(cellWidthFor(1000, 1, 10)).toBe(1000)
    expect(cellWidthFor(0, 5, 10)).toBe(0)
    expect(cellWidthFor(1000, 4, 0)).toBe(250)
    expect(cellWidthFor(Number.NaN, 4, 10)).toBe(0)
  })

  it('宽度按 DPR 向上取档：窄格小档、2x 屏翻倍、超宽封顶 640', () => {
    expect(thumbWidthFor(192, 1)).toBe(240)
    expect(thumbWidthFor(192, 2)).toBe(480)
    expect(thumbWidthFor(320, 1)).toBe(320)
    expect(thumbWidthFor(700, 1)).toBe(640)
    expect(thumbWidthFor(10, 1)).toBe(160)
    expect(THUMB_WIDTH_STEPS).toEqual([160, 240, 320, 480, 640])
  })

  it('非法输入回退兜底宽度；DPR 限制在 1–3', () => {
    expect(thumbWidthFor(0, 1)).toBe(FILE_THUMB_WIDTH)
    expect(thumbWidthFor(Number.NaN, 2)).toBe(FILE_THUMB_WIDTH)
    expect(thumbWidthFor(200, 0)).toBe(240)
    expect(thumbWidthFor(200, 10)).toBe(640)
  })
})

describe('prefetchKeys：视区外上下各扩 PREFETCH_ROWS 行', () => {
  const files: FileItem[] = Array.from({ length: 12 }, (_, i) => item(i))
  files.push(item(12, 'video'))

  it('按行列序返回、跳过非图片、贴边安全', () => {
    const keys = prefetchKeys(files, 4, { startIndex: 2, endIndex: 2 })
    expect(keys.length).toBe(12)
    expect(keys[0]).toBe(K(0))
    expect(keys).not.toContain(K(12))
    expect(PREFETCH_ROWS).toBe(3)
    expect(prefetchKeys(files, 4, { startIndex: 0, endIndex: 0 }, 0).length).toBe(4)
    expect(prefetchKeys(files, 4, { startIndex: 999, endIndex: 999 }, 1)).toEqual([])
  })

  it('空列表 / 空 range 不炸', () => {
    expect(prefetchKeys([], 4, { startIndex: 0, endIndex: 0 })).toEqual([])
    expect(prefetchKeys(files, 4, null)).toEqual([])
    expect(prefetchKeys(files, 0, { startIndex: 0, endIndex: 0 }).length).toBeGreaterThan(0)
  })
})

describe('thumbCacheLimitFor：预取窗口不能挤掉屏上的图', () => {
  it('随列数放大、不低于 60、封顶 240', () => {
    expect(thumbCacheLimitFor(1)).toBe(60)
    expect(thumbCacheLimitFor(6)).toBe(96)
    expect(thumbCacheLimitFor(0)).toBe(60)
    expect(thumbCacheLimitFor(100)).toBe(240)
  })
})

describe('接线守卫：预取/自适应宽度真的接在面板上', () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url))

  it('Files 走 useFileThumbnails + prefetchKeys + thumbWidthFor；hook 两条 lane；格宽来自实测', () => {
    const files = readFileSync(join(HERE, 'Files.tsx'), 'utf8')
    expect(files).toContain('useFileThumbnails({ width: thumbWidth, cols: fileCols })')
    expect(files).toContain('prefetchThumbs(prefetchKeys(visible, fileCols, fileVirtualizer.range))')
    expect(files).toContain('thumbWidthFor(cellWidth, dpr)')
    expect(files).toContain('const { cols: fileCols, cellWidth } = useGridColumns(')
    const hook = readFileSync(join(HERE, 'use-file-thumbs.ts'), 'utf8')
    expect(hook).toContain('const VISIBLE_FLUSH_MS = 24')
    expect(hook).toContain('const PREFETCH_FLUSH_MS = 180')
    expect(hook).toContain('thumbCacheLimitFor(options.cols)')
    const grid = readFileSync(join(HERE, 'use-grid-columns.ts'), 'utf8')
    expect(grid).toContain('cellWidthFor(width, cols, gap)')
  })
})
