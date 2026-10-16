/**
 * 文件面板网格虚拟化的接线守卫（#22 第三处；另两份是 `longlist-virtualization.wiring.spec.ts`
 * 与 `favorites-virtual.wiring.spec.ts`）。
 *
 * 这里额外钉一条**只有本面板有**的：列宽口径写在两处 —— CSS 的
 * `.fileGrid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)) }` 与
 * 组件里的 `FILE_MIN_COL_PX`。两者不一致时列数会算错（一行格子比 CSS 排的多/少），
 * 症状是"最后一行被截掉"或"格子重叠"，都不报错。所以把 CSS 也读进来比一次。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(join(HERE, 'Files.tsx'), 'utf8')
const css = readFileSync(join(HERE, 'list-panel.module.css'), 'utf8')
const cell = readFileSync(join(HERE, 'files-cell.tsx'), 'utf8')

/** 剥注释（注释里出现 `useProgressiveList(` 是在解释"为什么不用它"）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
function callsProgressive(src: string): boolean {
  return /useProgressiveList\(/.test(stripComments(src))
}

describe('文件面板的网格虚拟化接线', () => {
  it('面板按「行」虚拟化（滚动容器就是那张格子墙本身）', () => {
    expect(panel).toContain("from '@tanstack/react-virtual'")
    expect(panel).toContain('useVirtualizer({')
    expect(panel).toContain('getScrollElement: () => gridRef.current')
    expect(panel).toContain('getVirtualItems()')
    expect(panel).toContain('fileVirtualizer.getTotalSize()')
    expect(panel).toContain('ref={fileVirtualizer.measureElement}')
    expect(panel).toContain('<FileCell')
  })

  it('列数现测，且与 CSS 的格位最小宽一致（两处各写一份就一定会漂）', () => {
    expect(panel).toContain('useGridColumns(gridRef, FILE_MIN_COL_PX)')
    const inJs = Number(/const FILE_MIN_COL_PX = (\d+)/.exec(panel)?.[1] ?? '0')
    const inCss = Number(/\.fileGrid\s*\{\s*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\((\d+)px/.exec(css)?.[1] ?? '0')
    expect(inJs, '读不到 FILE_MIN_COL_PX ⇒ 这条判据在空转').toBeGreaterThan(0)
    expect(inCss, '读不到 .fileGrid 的 minmax ⇒ 这条判据在空转').toBeGreaterThan(0)
    expect(inJs, `列宽口径漂了：JS ${inJs}px vs CSS ${inCss}px`).toBe(inCss)
  })

  it('每一行按测到的列数取自己的区间（不写死列数，也不整表 slice）', () => {
    expect(panel).toContain('gridRowRange(vi.index, visible.length, fileCols)')
    expect(panel).toContain('gridTemplateColumns: `repeat(${fileCols}, 1fr)`')
    expect(panel).toContain('visible.slice(start, end)')
  })

  it('overscan 保持小值；不再对格子墙使用渐进窗口', () => {
    const m = /overscan:\s*(\d+)/.exec(panel)
    expect(m, '找不到 overscan ⇒ 前提不成立').not.toBeNull()
    expect(Number(m?.[1] ?? '0')).toBeLessThanOrEqual(50)
    expect(callsProgressive(panel), 'Files.tsx 里又出现了 useProgressiveList(...)').toBe(false)
    expect(panel).not.toContain('fileCount')
  })

  it('缩略图改成「挂载即解码」+ 有界缓存：整段格子墙的观察器不许长回来', () => {
    expect(cell).toContain('onMounted(key)')
    expect(panel, '又给整张格子墙挂 IntersectionObserver 了').not.toContain("querySelectorAll<HTMLElement>('[data-media-key]')")
    expect(panel).toContain('rememberThumb(')
    expect(cell).toContain('data-file-key=')
  })

  it('分页哨兵还在（虚拟化只接管格子那一段）', () => {
    expect(panel).toContain('refFn={loadMoreRef}')
    expect(panel).toContain('pager.hasMore')
  })

  it('反例自证：坏形状与口径漂移都能被分出来', () => {
    expect(callsProgressive("const { count } = useProgressiveList(items.length, 30)\n")).toBe(true)
    expect(callsProgressive('/* 不再用 useProgressiveList( 因为只增不减 */\n')).toBe(false)
    // 列宽漂了的形状：JS 写 140、CSS 是 200
    const drifted = Number(/minmax\((\d+)px/.exec('.fileGrid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }')?.[1] ?? '0')
    expect(drifted).not.toBe(140)
    // 读不到常量时必须报（而不是把 0 当成"合法列数"放过）
    expect(Number(/const FILE_MIN_COL_PX = (\d+)/.exec('const 别的 = 1')?.[1] ?? '0')).toBe(0)
  })
})
