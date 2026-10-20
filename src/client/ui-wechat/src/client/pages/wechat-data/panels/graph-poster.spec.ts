/**
 * 社交图谱导出海报的版式与内容（2026-10-18 重设计）：
 *   ① 三种画幅都是「刊头 + 右 KPI + 图谱卡 + 洞察双卡 + 页脚」，区块不越界/不重叠；
 *   ② 图谱图层按目标框比例渲染（修旧版竖版左右被裁的 bug）；
 *   ③ 每套风格有强调色，图谱卡带元信息与图例 chips。
 *
 * 渲染本身依赖 Canvas，node 环境只测纯版式函数 + 源码接线；真实出图由真机探针验证。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { POSTER_THEMES, getPosterLayout, type PosterRatio } from './graph-poster.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')
const RATIOS: PosterRatio[] = ['1:1', '3:4', '16:9']

describe('海报版式：三种画幅的区块关系', () => {
  it.each(RATIOS)('%s：所有区块都在画布内，图谱卡包住图谱区，底部卡在页脚之上', (ratio) => {
    const L = getPosterLayout(ratio)
    const rects = [L.masthead, L.stats, L.graphCard, L.graphArea, L.relations, L.communities]
    for (const r of rects) {
      expect(r.x, `${ratio} x<0`).toBeGreaterThanOrEqual(0)
      expect(r.y, `${ratio} y<0`).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w, `${ratio} 右边越界`).toBeLessThanOrEqual(L.width)
      expect(r.y + r.h, `${ratio} 下边越界`).toBeLessThanOrEqual(L.height)
    }
    // 图谱区在卡内（扣掉标题行与内边距）
    expect(L.graphArea.x).toBeGreaterThan(L.graphCard.x)
    expect(L.graphArea.y).toBeGreaterThan(L.graphCard.y)
    expect(L.graphArea.x + L.graphArea.w).toBeLessThan(L.graphCard.x + L.graphCard.w)
    expect(L.graphArea.y + L.graphArea.h).toBeLessThan(L.graphCard.y + L.graphCard.h)
    // 洞察卡与图谱卡不重叠，且都在页脚之上
    const overlaps = (a: typeof L.relations, b: typeof L.relations): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    expect(overlaps(L.relations, L.graphCard), `${ratio} 榜单压图谱`).toBe(false)
    expect(overlaps(L.communities, L.graphCard), `${ratio} 圈子压图谱`).toBe(false)
    expect(overlaps(L.relations, L.communities), `${ratio} 两卡重叠`).toBe(false)
    expect(L.relations.y + L.relations.h).toBeLessThan(L.footerY)
    expect(L.communities.y + L.communities.h).toBeLessThan(L.footerY)
    // 刊头与 KPI 同一水平带、KPI 不压标题（KPI 靠右）
    expect(L.stats.x).toBeGreaterThan(L.masthead.x + L.masthead.w / 2)
    // 页脚基线在画布内
    expect(L.footerY).toBeGreaterThan(L.height - 120)
    expect(L.footerY).toBeLessThan(L.height)
  })

  it('16:9 横版：左图谱 + 右洞察双栏（图谱区接近方形，不被摊成细条）', () => {
    const L = getPosterLayout('16:9')
    expect(L.graphArea.h / L.height).toBeGreaterThan(0.45)
    expect(L.relations.x).toBeGreaterThanOrEqual(L.graphCard.x + L.graphCard.w)
    expect(L.communities.x).toBeGreaterThanOrEqual(L.graphCard.x + L.graphCard.w)
    expect(L.relations.y).toBeLessThan(L.communities.y)
    expect(L.graphArea.w / L.graphArea.h).toBeLessThan(2.2)
  })

  it('3:4 竖版底部双卡更高（排行条可读）', () => {
    const L = getPosterLayout('3:4')
    expect(L.relations.h).toBeGreaterThanOrEqual(200)
    expect(getPosterLayout('1:1').relations.h).toBeGreaterThanOrEqual(200)
  })
})

describe('海报主题：每套风格都有强调色', () => {
  it.each(['light', 'dark', 'neon'] as const)('%s 主题完整', (style) => {
    const th = POSTER_THEMES[style]
    for (const key of ['bgTop', 'bgBottom', 'accent', 'accentSoft', 'title', 'cardBg', 'cardTitle', 'track', 'footer'] as const) {
      expect(th[key], `${style}.${key} 为空`).toBeTruthy()
    }
    expect(th.accent).toMatch(/^#|rgb/)
  })
  it('三套强调色各不相同', () => {
    const accents = new Set(Object.values(POSTER_THEMES).map(t => t.accent))
    expect(accents.size).toBe(3)
  })
})

describe('渲染接线：图层按目标框比例渲染 + 内容更完整', () => {
  it('宿主用 getPosterLayout(ratio) 的图谱区尺寸渲染图层（旧版固定 16:9 会裁竖版）', () => {
    const host = read('graph-canvas-host.tsx')
    expect(host).toContain('getPosterLayout(ratio)')
    expect(host).toMatch(/w: layout\.graphArea\.w, h: layout\.graphArea\.h/)
    expect(host, '仍在写死 1184×360').not.toMatch(/renderOffscreen\(\{ w: 1184, h: 360/)
  })

  it('海报带上口径元信息与图例 chips', () => {
    const host = read('graph-canvas-host.tsx')
    expect(host).toContain('graphMeta')
    expect(host).toContain('legendItems')
    expect(host).toMatch(/中心：我/)
  })

  it('buildPoster 由分块绘制函数组成（便于维护且函数不超行数棘轮）', () => {
    const src = read('graph-poster.ts')
    for (const fn of ['drawBackground', 'drawMasthead', 'drawStats', 'drawGraphCard', 'drawRelations', 'drawCommunities', 'drawFooter']) {
      expect(src, `缺少 ${fn}`).toContain(`function ${fn}(`)
      expect(src).toContain(`${fn}(ctx`)
    }
  })

  it('不再有「圈子变多把画布拉高」的旧逻辑（画幅固定，超出省略）', () => {
    const src = read('graph-poster.ts')
    expect(src).not.toMatch(/layout\.height = base\.height \+ delta/)
  })
})
